#!/usr/bin/env node
'use strict';
/* ForgeDeck 冒烟测试：REST + WebSocket（零依赖）
 * 用法：FORGEDECK_TOKEN=xxx node scripts/smoke.js [http://127.0.0.1:8083]
 */
const http = require('node:http');
const crypto = require('node:crypto');

const BASE = process.argv[2] || process.env.FORGEDECK_URL || 'http://127.0.0.1:8083';
const TOKEN = process.env.FORGEDECK_TOKEN || '';
const u = new URL(BASE);
const HOST = u.hostname;
const PORT = Number(u.port || 80);

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opt = {
      host: HOST, port: PORT, method, path,
      headers: { ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}), ...headers },
    };
    if (body !== undefined) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      opt.headers['Content-Type'] = opt.headers['Content-Type'] || 'application/json';
      opt.headers['Content-Length'] = buf.length;
      opt.body = buf;
    }
    const r = http.request(opt, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, raw, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (opt.body) r.write(opt.body);
    r.end();
  });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 极简 WS 客户端
function wsOpen(path, onMessage) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    };
    const r = http.request({ host: HOST, port: PORT, path, headers });
    r.on('upgrade', (res, socket) => {
      const conn = { socket, closed: false, send: (s) => writeFrame(socket, s), close: () => socket.destroy() };
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (opcode === 0x1) onMessage(payload.toString('utf8'));
          if (opcode === 0x8) { conn.closed = true; socket.destroy(); }
        }
      });
      resolve(conn);
    });
    r.on('response', (res) => reject(new Error('upgrade 被拒绝: ' + res.statusCode)));
    r.on('error', reject);
    r.end();
  });
}

function writeFrame(socket, text) {
  const payload = Buffer.from(String(text));
  const head = [0x81];
  if (payload.length < 126) head.push(payload.length);
  else if (payload.length < 65536) head.push(126, payload.length >> 8, payload.length & 0xff);
  else {
    head.push(127);
    const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length));
    for (const x of b) head.push(x);
  }
  socket.write(Buffer.concat([Buffer.from(head), payload]));
}

(async function main() {
  console.log(`ForgeDeck smoke test → ${BASE}`);
  try {
    const health = await req('GET', '/api/health');
    ok('health 200', health.status === 200, health.status);
    ok('health ok=true', health.json && health.json.ok === true);

    const unauthorized = await req('GET', '/api/config', undefined, { Authorization: '' });
    ok('未授权返回 401', unauthorized.status === 401, unauthorized.status);

    if (TOKEN) {
      const cfg = await req('GET', '/api/config');
      ok('config 200', cfg.status === 200, cfg.status);
      ok('config 有 workspaceName', !!cfg.json?.workspaceName);
    }

    const root = await req('GET', '/api/tree?dir=');
    ok('tree 200', root.status === 200, root.status);
    ok('tree entries 是数组', Array.isArray(root.json?.entries));

    const tmpDir = '__smoke';
    await req('POST', '/api/fs/mkdir', { path: tmpDir });
    const written = await req('PUT', '/api/file', { path: tmpDir + '/a.txt', content: 'hello forge\n' });
    ok('写入文件', written.status === 200, written.status);
    const read = await req('GET', '/api/file?path=' + encodeURIComponent(tmpDir + '/a.txt'));
    ok('读回内容一致', read.json?.content === 'hello forge\n', JSON.stringify(read.json?.content));

    const search = await req('GET', '/api/search?q=forge');
    ok('搜索命中', search.json?.results?.some((r) => r.path.endsWith('a.txt')));

    const devices = await req('GET', '/api/devices');
    ok('devices 200', devices.status === 200, devices.status);
    ok('devices 有 usb 数组', Array.isArray(devices.json?.usb));

    const backends = await req('GET', '/api/backends');
    ok('backends 200', backends.status === 200, backends.status);

    // 任务：用 custom 跑一个 echo
    const job = await req('POST', '/api/jobs', { kind: 'custom', argv: ['sh', '-c', 'echo fd-smoke'] });
    ok('创建任务 202', job.status === 202, job.status);
    await delay(400);
    const jr = await req('GET', '/api/jobs/' + job.json.id);
    ok('任务完成 code=0', jr.json?.code === 0, jr.json?.status);
    ok('任务输出包含 fd-smoke', String(jr.json?.log || '').includes('fd-smoke'));

    // WS 终端
    const msgs = [];
    const shellWs = await wsOpen('/ws/shell?cols=100&rows=30', (m) => msgs.push(m));
    await delay(300);
    shellWs.send(JSON.stringify({ type: 'input', data: 'echo fd-shell-ok\n' }));
    await delay(700);
    ok('WS shell 有回显', msgs.some((m) => m.includes('fd-shell-ok')), msgs.join('').slice(0, 120));
    shellWs.close();

    // 清理
    await req('POST', '/api/fs/delete', { path: tmpDir, recursive: true });
  } catch (e) {
    fail++;
    fails.push('异常: ' + e.message);
    console.log('  ✗ 异常', e.message);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
  console.log('全部通过 ✅');
})().catch((e) => { console.error(e); process.exit(1); });
