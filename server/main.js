#!/usr/bin/env node
'use strict';
// ForgeDeck — 入口：HTTP 路由、静态资源、WebSocket（终端/串口）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { load } = require('./config');
const util = require('./util');
const ws = require('./ws');
const { Auth, parseCookies } = require('./auth');
const devices = require('./devices');
const projects = require('./projects');
const files = require('./fsapi');
const flash = require('./flash');
const { JobManager } = require('./jobs');
const serial = require('./serial');
const shell = require('./shell');
const tailnet = require('./tailnet');
const remote = require('./remote');

const VERSION = '0.3.0';
const cfg = load();
const jobs = new JobManager(cfg);
const remotes = new remote.RemoteRegistry(cfg);

const log = (...a) => console.log(`[forge-deck ${util.stamp()}]`, ...a);
const auth = new Auth(cfg, log);

const PUBLIC = path.join(__dirname, '..', 'web');

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\//, '');
  const abs = path.resolve(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC)) return util.sendText(res, 403, 'forbidden');
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    if (req.headers.accept && String(req.headers.accept).includes('text/html')) {
      return util.sendText(res, 404, 'not found');
    }
    return util.sendText(res, 404, 'not found');
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': util.mimeOf(abs),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(abs).pipe(res);
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, re: pattern, handler });
}

function q(req) {
  const u = new URL(req.url, 'http://x');
  return { url: u, query: Object.fromEntries(u.searchParams) };
}

function publicConfig() {
  return {
    name: cfg.siteName,
    version: VERSION,
    workspaceName: path.basename(cfg.workspaceRealPath),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
    limits: cfg.limits,
    serial: { defaultBaud: cfg.serial.defaultBaud },
    shellEnabled: cfg.shell.enabled,
    pty: shell.ptyAvailable(),
    tailscaleEnabled: cfg.tailscale.enabled,
    tokenRequired: auth.tokenRequired,
    remote: {
      backend: remote.haveSocat() ? 'socat' : remote.havePython() ? 'python3' : 'none',
      links: remotes.list().length,
      dir: remote.remoteDir(),
    },
  };
}

// ── 路由表 ──────────────────────────────────
route('GET', /^\/api\/health$/, (req, res, m, ctx) => {
  const base = { ok: true, name: cfg.siteName, version: VERSION, uptime: Math.round(process.uptime()) };
  if (!ctx.who) return util.sendJSON(res, 200, base);
  util.sendJSON(res, 200, {
    ...base,
    host: os.hostname(),
    workspace: cfg.workspaceRealPath,
    pio: !!flash.which(cfg.tools.pio),
    jobsRunning: jobs.list().filter((j) => j.status === 'running').length,
  });
});

route('GET', /^\/api\/config$/, (req, res) => util.sendJSON(res, 200, publicConfig()));

route('GET', /^\/api\/me$/, (req, res, m, ctx) => {
  util.sendJSON(res, 200, { user: ctx.who.user, via: ctx.who.via });
});

route('POST', /^\/api\/login$/, async (req, res) => {
  const body = await util.readJSON(req);
  const token = String(body.token || '');
  if (auth.token && token !== auth.token) return util.sendJSON(res, 401, { error: '令牌不正确' });
  if (!auth.token) {
    // 无 token 模式：只允许 loopback / 已识别的 tailnet 身份
    const who = auth.identify(req);
    if (!who.ok) return util.sendJSON(res, 401, { error: '当前部署未启用令牌，需从 tailnet 或本机访问' });
    return util.sendJSON(res, 200, { ok: true, user: who.user, via: who.via });
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `fd_token=${encodeURIComponent(auth.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
  });
  res.end(JSON.stringify({ ok: true, user: { login: 'token', name: 'token-holder', node: 'local', tags: [] }, via: 'token' }));
});

route('POST', /^\/api\/logout$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fd_token=; Path=/; Max-Age=0' });
  res.end(JSON.stringify({ ok: true }));
});

route('GET', /^\/api\/tree$/, (req, res, m, ctx) => {
  const data = files.listDir(cfg.workspaceRealPath, ctx.query.dir || '', { showHidden: ctx.query.hidden === '1' });
  util.sendJSON(res, 200, data);
});

route('GET', /^\/api\/file$/, (req, res, m, ctx) => {
  const data = files.readFile(cfg.workspaceRealPath, ctx.query.path || '', cfg.limits.fileMB * 1024 * 1024);
  util.sendJSON(res, 200, data);
});

route('PUT', /^\/api\/file$/, async (req, res) => {
  const body = await util.readJSON(req, cfg.limits.fileMB * 1024 * 1024 * 2);
  if (typeof body.content !== 'string') util.fail(400, 'content 必须是字符串');
  const r = files.writeFile(cfg.workspaceRealPath, body.path || '', body.content);
  util.sendJSON(res, 200, r);
});

route('GET', /^\/api\/fs\/download$/, (req, res, m, ctx) => {
  const d = files.downloadPath(cfg.workspaceRealPath, ctx.query.path || '');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': d.size,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(d.name)}"`,
  });
  fs.createReadStream(d.abs).pipe(res);
});

route('POST', /^\/api\/fs\/upload$/, async (req, res, m, ctx) => {
  const rel = ctx.query.path || '';
  const buf = await util.readBody(req, cfg.limits.uploadMB * 1024 * 1024);
  const r = files.saveUpload(cfg.workspaceRealPath, rel, buf);
  util.sendJSON(res, 200, r);
});

route('POST', /^\/api\/fs\/(mkdir|touch|rename|delete)$/, async (req, res, m, ctx) => {
  const body = await util.readJSON(req);
  const root = cfg.workspaceRealPath;
  let out;
  switch (ctx.match[1]) {
    case 'mkdir': out = files.mkdir(root, body.path); break;
    case 'touch': out = files.createFile(root, body.path, body.content || ''); break;
    case 'rename': out = files.rename(root, body.from, body.to); break;
    case 'delete': out = files.remove(root, body.path, !!body.recursive); break;
  }
  util.sendJSON(res, 200, out);
});

route('GET', /^\/api\/search$/, (req, res, m, ctx) => {
  const data = files.search(cfg.workspaceRealPath, ctx.query.q || '', ctx.query.dir || '');
  util.sendJSON(res, 200, data);
});

route('GET', /^\/api\/projects$/, (req, res) => {
  util.sendJSON(res, 200, { projects: projects.scan(cfg.workspaceRealPath) });
});

route('GET', /^\/api\/projects\/describe$/, (req, res, m, ctx) => {
  const abs = util.resolveIn(cfg.workspaceRealPath, ctx.query.dir || '');
  if (!abs) util.fail(400, '非法路径');
  util.sendJSON(res, 200, projects.describe(abs));
});

route('GET', /^\/api\/devices$/, (req, res) => util.sendJSON(res, 200, devices.detect(cfg)));

route('GET', /^\/api\/ports$/, (req, res) => {
  const local = devices.serialPorts().filter((p) => devices.isAllowedPort(cfg, p.device));
  const localPorts = local.map((p) => ({
    device: p.device,
    label: p.label && p.label !== p.name ? `${p.device} — ${p.label}` : p.device,
    usbId: p.usbId,
    chips: p.chips,
    remote: false,
  }));
  const remotePorts = remotes.sockets();
  util.sendJSON(res, 200, {
    ports: [...localPorts, ...remotePorts],
    local: localPorts,
    remote: remotes.list(),
    active: serial.list(),
    backend: remote.haveSocat() ? 'socat' : remote.havePython() ? 'python3' : 'none',
    hint: devices.detect(cfg).hint,
  });
});

// 远端串口桥（把本机 USB 通过 bridge + Tailscale 接进来）
route('GET', /^\/api\/remote$/, (req, res) => {
  util.sendJSON(res, 200, {
    links: remotes.list(),
    sockets: remotes.sockets(),
    backend: remote.haveSocat() ? 'socat' : remote.havePython() ? 'python3' : 'none',
    dir: remote.remoteDir(),
  });
});

route('POST', /^\/api\/remote$/, async (req, res) => {
  const body = await util.readJSON(req);
  const host = String(body.host || '').trim();
  const port = Number(body.port);
  if (!remote.validateHost(host)) util.fail(400, 'host 非法（只接受主机名或 IP）');
  if (!(port > 0 && port < 65536)) util.fail(400, 'port 非法');
  const st = await remotes.add({ name: body.name || `${host}-${port}`, host, port });
  if (st.error) return util.sendJSON(res, 502, st);
  util.sendJSON(res, 201, st);
});

route('DELETE', /^\/api\/remote\/([A-Za-z0-9_.-]{1,40})$/, (req, res, m, ctx) => {
  const ok = remotes.remove(ctx.match[1]);
  util.sendJSON(res, ok ? 200 : 404, { ok });
});

route('GET', /^\/api\/backends$/, (req, res) => util.sendJSON(res, 200, { backends: flash.backendStatus(cfg) }));

route('GET', /^\/api\/tailnet$/, (req, res) => {
  const st = tailnet.status();
  const dns = st.self && st.self.dns;
  util.sendJSON(res, 200, { ...st, tips: tailnet.tips(cfg.port, dns), serve: tailnet.serveStatus() });
});

route('GET', /^\/api\/jobs$/, (req, res) => util.sendJSON(res, 200, { jobs: jobs.list(), running: jobs.list().filter((j) => j.status === 'running').length }));

route('GET', /^\/api\/jobs\/([0-9a-f]{8})$/, (req, res, m, ctx) => {
  const job = jobs.get(ctx.match[1]);
  if (!job) util.fail(404, '任务不存在');
  util.sendJSON(res, 200, { ...job.summary(), log: job.text() });
});

route('GET', /^\/api\/jobs\/([0-9a-f]{8})\/log$/, (req, res, m, ctx) => {
  const job = jobs.get(ctx.match[1]);
  if (!job) util.fail(404, '任务不存在');
  util.sendText(res, 200, job.text());
});

route('GET', /^\/api\/jobs\/([0-9a-f]{8})\/stream$/, (req, res, m, ctx) => {
  const job = jobs.get(ctx.match[1]);
  if (!job) util.fail(404, '任务不存在');
  const { send, close } = util.openSSE(req, res);
  if (job.log.length) send('log', JSON.stringify({ text: job.text() }));
  const onData = (ev) => send('log', JSON.stringify({ text: String(ev.text ?? ev), stream: ev.stream || 'out' }));
  const onEnd = (summary) => {
    send('end', JSON.stringify(summary));
    close();
  };
  job.emitter.on('data', onData);
  job.emitter.on('end', onEnd);
  req.on('close', () => {
    job.emitter.off('data', onData);
    job.emitter.off('end', onEnd);
  });
});

route('POST', /^\/api\/jobs\/([0-9a-f]{8})\/cancel$/, (req, res, m, ctx) => {
  const job = jobs.get(ctx.match[1]);
  if (!job) util.fail(404, '任务不存在');
  util.sendJSON(res, 200, { canceled: job.cancel() });
});

route('POST', /^\/api\/jobs$/, async (req, res) => {
  const body = await util.readJSON(req);
  const kind = String(body.kind || '');
  if (!['build', 'flash', 'clean', 'erase', 'custom'].includes(kind)) util.fail(400, '未知任务类型');
  const spec = flash.buildCommand(cfg, {
    kind,
    project: body.project || '',
    env: body.env || '',
    port: body.port || '',
    backend: body.backend || 'auto',
    file: body.file || '',
    address: body.address || '',
    baud: body.baud,
    cfgFile: body.cfgFile || '',
    target: body.target || '',
    argv: body.argv,
  });
  const job = jobs.create({ ...spec, kind, meta: { project: body.project || '', env: body.env || '', port: body.port || '' } });
  util.sendJSON(res, 202, job.summary());
});

route('POST', /^\/api\/serial\/write$/, async (req, res) => {
  const body = await util.readJSON(req);
  const dev = String(body.port || '');
  if (!(serial.validate(dev) || remotes.isRemotePath(dev))) util.fail(400, '端口非法');
  const s = serial.list().find((x) => x.device === dev);
  if (!s) {
    // 没有活动会话时直接写一帧（不做读取）
    const tmp = serial.acquire(dev, body.baud || cfg.serial.defaultBaud, () => {}, () => {});
    const ok = tmp.write(Buffer.from(String(body.data || ''), 'utf8'));
    tmp.close('one-shot');
    return util.sendJSON(res, 200, { ok });
  }
  util.fail(404, '串口未连接');
});

route('GET', /^\/api\/serial\/sessions$/, (req, res) => util.sendJSON(res, 200, serial.list()));

route('GET', /^\/api\/version$/, (req, res) => util.sendJSON(res, 200, { version: VERSION }));

// ── 请求分发 ──────────────────────────────────
async function handle(req, res) {
  const { url, query } = q(req);
  const p = url.pathname;

  if (p === '/favicon.ico') {
    return util.sendText(res, 204, '');
  }

  if (!p.startsWith('/api/')) {
    if (p.startsWith('/ws/')) return util.sendText(res, 400, 'websocket only');
    return serveStatic(req, res, p);
  }

  // 免鉴权端点：登录本身与探活
  const OPEN_PATHS = new Set(['/api/login', '/api/health']);
  let who = null;
  if (!OPEN_PATHS.has(p)) {
    who = auth.require(req, res);
    if (!who) return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(p);
    if (!m) continue;
    try {
      return await r.handler(req, res, m, { query, who, url, match: m });
    } catch (e) {
      const status = e.status || 500;
      log(`route error ${p}:`, e.message);
      if (!res.headersSent) util.sendJSON(res, status, { error: e.message });
      else if (!res.writableEnded) res.end();
      return;
    }
  }
  util.sendJSON(res, 404, { error: 'not found', path: p });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('unhandled:', e);
    try { util.sendJSON(res, 500, { error: e.message }); } catch {}
  });
});

// ── WebSocket ──────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
  const who = auth.identify(req);
  if (!who.ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const p = url.pathname;

  if (p === '/ws/shell') {
    if (!cfg.shell.enabled) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    ws.upgrade(req, socket, head, (conn) => {
      const cwdParam = url.searchParams.get('cwd') || '';
      const cwd = util.resolveIn(cfg.workspaceRealPath, cwdParam) || cfg.workspaceRealPath;
      const cols = Number(url.searchParams.get('cols')) || 160;
      const rows = Number(url.searchParams.get('rows')) || 40;
      const sess = new shell.ShellSession({
        shell: cfg.shell.shell,
        cwd,
        cols,
        rows,
        onData: (d) => conn.send(JSON.stringify({ type: 'data', data: d })),
        onClose: (reason) => {
          conn.send(JSON.stringify({ type: 'exit', reason }));
          conn.close(1000, 'shell closed');
        },
      });
      conn.send(JSON.stringify({ type: 'ready', cwd, pty: sess.pty }));
      conn.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === 'input') sess.write(String(msg.data || ''));
        else if (msg.type === 'resize') sess.resize(msg.cols, msg.rows);
        else if (msg.type === 'signal' && msg.sig === 'C-c') sess.write('\x03');
      });
      conn.on('close', () => sess.close('ws closed'));
    });
    return;
  }

  if (p === '/ws/serial') {
    const dev = url.searchParams.get('port') || '';
    const baud = Number(url.searchParams.get('baud')) || cfg.serial.defaultBaud;
    const isRemote = remotes.isRemotePath(dev);
    if (isRemote ? !fs.existsSync(dev) : (!serial.validate(dev) || !devices.isAllowedPort(cfg, dev))) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    ws.upgrade(req, socket, head, (conn) => {
      let sess;
      try {
        sess = serial.acquire(
          dev,
          baud,
          (buf) => conn.send(buf),
          (reason, stats) => {
            conn.send(JSON.stringify({ type: 'closed', reason, stats }));
            conn.close(1000, 'serial closed');
          }
        );
      } catch (e) {
        conn.send(JSON.stringify({ type: 'error', message: `打开 ${dev} 失败: ${e.message}` }));
        conn.close(1011, 'open failed');
        return;
      }
      conn.send(JSON.stringify({ type: 'ready', device: dev, baud }));
      conn.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'write') sess.write(String(msg.data || ''));
          else if (msg.type === 'reset') sess.reset();
        } catch {}
      });
      conn.on('close', () => sess.close('ws closed'));
    });
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

server.listen(cfg.port, cfg.host, () => {
  log(`${cfg.siteName} ${VERSION} 启动 → http://${cfg.host}:${cfg.port}`);
  log(`工作区: ${cfg.workspaceRealPath}`);
  log(`配置文件: ${cfg.configPath}${cfg.configExists ? '' : '（未找到，使用默认）'}`);
  log(`令牌: ${auth.tokenRequired ? '已启用' : '未设置（仅允许 loopback / tailnet 身份访问）'}`);
  const st = tailnet.status();
  if (st.running && st.self) log(`Tailnet: ${st.self.dns} → tailscale serve --bg http://127.0.0.1:${cfg.port}`);
  log(`终端 PTY: ${shell.ptyAvailable() ? 'script(1) 可用' : '退化模式'}`);
});

process.on('SIGINT', () => {
  log('收到 SIGINT，退出');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});

module.exports = { server, cfg, jobs };
