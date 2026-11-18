#!/usr/bin/env node
'use strict';
/* ForgeDeck Bridge — 把本机 USB 串口/烧录器桥接到网络
 *
 * 零依赖单文件。运行在插着开发板的那台机器上；Tailscale 连通的另一头
 * （ForgeDeck 服务器）就能把这块板子当成自己的串口来编译、监控、烧录。
 *
 *   ./serial-bridge.js --list
 *   ./serial-bridge.js --device /dev/ttyUSB0 --port 9999
 *   ./serial-bridge.js --device /dev/ttyACM0:10000 --device /dev/ttyUSB0:9999
 *
 * 传输层是裸 TCP 字节流：
 *   - PlatformIO:  pio run -t upload --upload-port socket://host:9999
 *   - 受限网络:    ssh -R 9999:localhost:9999 server
 */

const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const VERSION = '0.4.0';

let OPT = { quiet: false };

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(...a) {
  if (OPT.quiet) return;
  console.error(`[${stamp()}]`, ...a);
}
function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// ── 参数 ───────────────────────────────────
function parseArgs(argv) {
  const out = {
    devices: [], port: 0, baud: 115200, listen: '0.0.0.0',
    allow: '100.64.0.0/10,127.0.0.1/32', statusPort: 0, token: '',
    list: false, quiet: false, reopenMs: 2500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--list' || a === '-l') out.list = true;
    else if (a === '--device' || a === '-d') {
      const spec = String(val() || '');
      const m = spec.match(/^(.*?)(?::(\d{2,5}))?$/);
      if (!m) die(`--device 参数无法解析: ${spec}`);
      out.devices.push({ path: m[1], port: m[2] ? Number(m[2]) : 0 });
    } else if (a === '--port' || a === '-p') out.port = Number(val());
    else if (a === '--baud' || a === '-b') out.baud = Number(val());
    else if (a === '--bind') out.listen = val();
    else if (a === '--allow') out.allow = val();
    else if (a === '--status-port') out.statusPort = Number(val());
    else if (a === '--token') out.token = val();
    else if (a === '--reopen-ms') out.reopenMs = Number(val());
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--version' || a === '-v') { console.log(`forge-deck-bridge ${VERSION}`); process.exit(0); }
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else die(`未知参数: ${a}（--help 查看用法）`, 2);
  }
  if (!out.devices.length && out.port) out.port = out.port;
  return out;
}

function usage() {
  console.log(`ForgeDeck Bridge ${VERSION} — 本机 USB 串口 → TCP

用法:
  serial-bridge.js --list
  serial-bridge.js --device /dev/ttyUSB0 --port 9999
  serial-bridge.js --device /dev/ttyACM0:10000 --device /dev/ttyUSB0:9999
  serial-bridge.js --device /dev/tty.usbserial-1420 --port 9999    # macOS

选项:
  -l, --list               列出本机串口后退出
  -d, --device PATH[:PORT] 要桥接的设备（可重复）；PORT 省略时用基准端口
  -p, --port N             基准端口（默认 9999，多设备依次 +1）
  -b, --baud N             串口波特率（默认 115200）
      --bind ADDR          监听地址（默认 0.0.0.0；只给 tailnet 用可填 100.x.y.z）
      --allow CIDR[,..]    允许来源（默认 100.64.0.0/10,127.0.0.1/32；填 any 放开）
      --reopen-ms N        设备消失后的重试间隔（默认 2500）
      --status-port N      额外开一个 HTTP 状态页
      --token T            状态页访问令牌
  -q, --quiet              安静模式
`);
}

// ── CIDR 白名单 ────────────────────────────
function ipv4ToInt(ip) {
  const m = String(ip).replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const n = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
  return n;
}

function parseAllow(spec) {
  if (!spec || spec === 'any') return null;
  const rules = [];
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part === 'any') return null;
    if (part.startsWith('fd7a:115c:a1e0:')) { rules.push({ v6: 'fd7a:115c:a1e0:' }); continue; }
    if (part.startsWith('::1')) { rules.push({ v6: '::1' }); continue; }
    const m = part.match(/^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/);
    if (!m) continue;
    const bits = m[2] === undefined ? 32 : Number(m[2]);
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    rules.push({ base: (ipv4ToInt(m[1]) & mask) >>> 0, mask, bits });
  }
  return rules.length ? rules : null;
}

function allowed(rules, addr) {
  if (!rules) return true;
  const ip = String(addr || '').replace(/^::ffff:/, '');
  for (const r of rules) {
    if (r.v6) {
      if (ip.startsWith(r.v6)) return true;
      continue;
    }
    const v = ipv4ToInt(ip);
    if (v === null) continue;
    if (((v & r.mask) >>> 0) === r.base) return true;
  }
  return false;
}

// ── 串口设备发现 ────────────────────────────
function serialDevices() {
  const out = [];
  if (IS_LINUX) {
    let names = [];
    try { names = fs.readdirSync('/dev'); } catch { return out; }
    for (const n of names.filter((x) => /^(ttyUSB|ttyACM|ttyAMA|ttyCH343USB|ttyCH341USB)\d+$/.test(x))) {
      let label = n;
      try { label = fs.readFileSync(`/sys/class/tty/${n}/device/../product`, 'utf8').trim() || n; } catch {}
      out.push({ device: '/dev/' + n, label });
    }
  } else if (IS_MAC) {
    let names = [];
    try { names = fs.readdirSync('/dev'); } catch { return out; }
    for (const n of names.filter((x) => /^(tty|cu)\./.test(x))) out.push({ device: '/dev/' + n, label: n });
  }
  return out;
}

function configureTty(device, baud) {
  const flag = IS_MAC ? '-f' : '-F';
  const r = spawnSync('stty', [flag, device, String(baud), 'raw', '-echo', '-echoe', '-echok',
    '-icrnl', '-ixon', '-crtscts', 'cs8', '-cstopb', '-parenb', 'min', '0', 'time', '0'], { timeout: 5000 });
  if (r.status !== 0) {
    const msg = (r.stderr || r.error?.message || '').toString().trim();
    throw new Error(msg || 'stty 配置失败');
  }
}

// ── 一个设备的桥 ────────────────────────────
class DeviceBridge {
  constructor({ device, baud, reopenMs, onData, onState }) {
    this.device = device;
    this.baud = baud;
    this.reopenMs = reopenMs || 2500;
    this.onData = onData;
    this.onState = onState;
    this.fd = -1;
    this.rx = 0;
    this.tx = 0;
    this.buf = Buffer.alloc(4096);
    this.clients = new Set();
    this._pumpTimer = null;
    this._reopenTimer = null;
    this.open();
  }

  open() {
    try {
      const flags = fs.constants.O_RDWR | fs.constants.O_NONBLOCK;
      this.fd = fs.openSync(this.device, flags);
      configureTty(this.device, this.baud);
      clearInterval(this._pumpTimer);
      this._pumpTimer = setInterval(() => this._pump(), 3);
      log(`打开 ${this.device} @ ${this.baud}`);
      this._state('open');
    } catch (e) {
      if (this.fd >= 0) { try { fs.closeSync(this.fd); } catch {} this.fd = -1; }
      log(`${this.device} 打开失败: ${e.message}（等待设备，${this.reopenMs}ms 重试）`);
      this._state('error', e.message);
      this._scheduleReopen();
    }
  }

  _state(kind, extra) {
    try { this.onState && this.onState(this.device, kind, extra); } catch {}
  }

  _scheduleReopen() {
    if (this._reopenTimer) return;
    this._reopenTimer = setTimeout(() => {
      this._reopenTimer = null;
      if (!fs.existsSync(this.device)) return this._scheduleReopen();
      this.open();
    }, this.reopenMs);
  }

  _pump() {
    if (this.fd < 0) return;
    for (let guard = 0; guard < 64; guard++) {
      let n;
      try {
        n = fs.readSync(this.fd, this.buf, 0, this.buf.length, null);
      } catch (e) {
        if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') return;
        return this._lost(`读取失败: ${e.message}`);
      }
      if (n <= 0) return;
      this.rx += n;
      const chunk = Buffer.from(this.buf.subarray(0, n));
      try { this.onData && this.onData(this.device, chunk); } catch {}
    }
  }

  write(buf) {
    if (this.fd < 0) return false;
    try {
      const n = fs.writeSync(this.fd, buf, 0, buf.length);
      this.tx += n;
      return true;
    } catch (e) {
      if (e.code !== 'EAGAIN') this._lost(`写入失败: ${e.message}`);
      return false;
    }
  }

  _lost(reason) {
    clearInterval(this._pumpTimer);
    if (this.fd >= 0) { try { fs.closeSync(this.fd); } catch {} }
    this.fd = -1;
    log(`${this.device} 断开: ${reason}`);
    this._state('closed', reason);
    this._scheduleReopen();
  }

  close() {
    clearInterval(this._pumpTimer);
    clearTimeout(this._reopenTimer);
    if (this.fd >= 0) { try { fs.closeSync(this.fd); } catch {} }
    this.fd = -1;
  }

  stats() {
    return { device: this.device, open: this.fd >= 0, rx: this.rx, tx: this.tx, clients: this.clients.size };
  }
}

// ── 主流程 ──────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  OPT = opts;

  if (opts.list) {
    const devs = serialDevices();
    if (!devs.length) return console.log('未发现串口设备（Linux: /dev/ttyUSB* /dev/ttyACM*，macOS: /dev/tty.* /dev/cu.*）');
    console.log('可用串口：');
    for (const d of devs) console.log(`  ${d.device.padEnd(26)} ${d.label}`);
    console.log('\n示例: serial-bridge.js --device ' + devs[0].device + ' --port 9999');
    return;
  }

  if (!opts.devices.length) {
    const devs = serialDevices();
    if (devs.length === 1) {
      opts.devices.push({ path: devs[0].device, port: 0 });
      log(`未指定 --device，自动使用唯一串口 ${devs[0].device}`);
    } else if (devs.length > 1) {
      console.error('检测到多个串口，请显式指定：');
      for (const d of devs) console.error(`  --device ${d.device}`);
      process.exit(2);
    } else {
      console.error('未检测到串口设备。请插好板子，或用 --device 指定。');
      process.exit(2);
    }
  }

  const basePort = opts.port || 9999;
  const links = [];
  const rules = parseAllow(opts.allow);

  for (let i = 0; i < opts.devices.length; i++) {
    const d = opts.devices[i];
    const port = d.port || basePort + i;
    const bridge = new DeviceBridge({
      device: d.path,
      baud: opts.baud,
      reopenMs: opts.reopenMs,
      onData: (dev, chunk) => {
        for (const c of bridge.clients) { try { c.write(chunk); } catch {} }
      },
    });

    const server = net.createServer((socket) => {
      const addr = socket.remoteAddress || '';
      if (!allowed(rules, addr)) {
        log(`拒绝 ${addr}：不在 --allow 白名单`);
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      bridge.clients.add(socket);
      log(`${d.path} ← 客户端 ${addr}（共 ${bridge.clients.size}）`);
      if (bridge.fd < 0) {
        socket.write(Buffer.alloc(0));
        log(`${d.path} 当前未就绪，等待设备后自动打通`);
      }
      socket.on('data', (buf) => { if (!bridge.write(buf)) socket.destroy(); });
      socket.on('error', () => {});
      socket.on('close', () => {
        bridge.clients.delete(socket);
        log(`${d.path} 客户端断开 ${addr}（剩 ${bridge.clients.size}）`);
      });
    });
    server.on('error', (e) => die(`${d.path} 监听 ${opts.listen}:${port} 失败: ${e.message}`));
    server.listen(port, opts.listen, () => {
      log(`就绪 tcp://${opts.listen}:${port} → ${d.path}（baud ${opts.baud}）`);
    });
    links.push({ device: d.path, port, bridge, server });
  }

  if (opts.statusPort) {
    http.createServer((req, res) => {
      if (opts.token) {
        const auth = String(req.headers.authorization || '');
        const custom = String(req.headers['x-bridge-token'] || '');
        if (auth !== 'Bearer ' + opts.token && custom !== opts.token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'unauthorized' }));
        }
      }
      if (String(req.url || '/') !== '/') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      const body = JSON.stringify({
        name: os.hostname(),
        version: VERSION,
        uptime: Math.round(process.uptime()),
        allow: opts.allow,
        links: links.map((l) => ({ ...l.bridge.stats(), port: l.port })),
      }, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    }).listen(opts.statusPort, opts.listen, () => log(`状态页 http://${opts.listen}:${opts.statusPort}/`));
  }

  const stop = () => {
    log('退出中…');
    for (const l of links) {
      try { l.server.close(); } catch {}
      try { l.bridge.close(); } catch {}
    }
    setTimeout(() => process.exit(0), 150);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(`已桥接 ${links.length} 个设备，Ctrl-C 退出`);
}

main();
