#!/usr/bin/env node
'use strict';
/* ForgeDeck 桥接端到端测试
 *
 * 用 Python 的 pty 模拟一块"插在本机的板子"，走一遍：
 *   伪串口 → serial-bridge → TCP → 服务端 pty_bridge → /tmp/forge-deck-remote/*.pty
 *
 * 用法: FORGEDECK_TOKEN=xxx node scripts/smoke-bridge.js [http://127.0.0.1:8083]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const BASE = process.argv[2] || process.env.FORGEDECK_URL || 'http://127.0.0.1:8083';
const TOKEN = process.env.FORGEDECK_TOKEN || '';
const u = new URL(BASE);
const BRIDGE_PORT = 19991;
const NAME = 'smoke-bridge';
const BRIDGE_BIN = path.join(__dirname, '..', 'bridge', 'serial-bridge.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: u.hostname, port: Number(u.port || 80), method, path: p,
      headers: {
        ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// 用 python 造一个会周期性输出的伪串口
function startFakeSerial() {
  const script = `
import os, pty, sys, time, select, tty
m, s = pty.openpty()
tty.setraw(s)
sys.stdout.write(os.ttyname(s)); sys.stdout.flush()
out = open('/tmp/fd-smoke-got.txt', 'w'); out.close()
t0 = time.time(); last = -1
while time.time() - t0 < 40:
    r, _, _ = select.select([m], [], [], 0.15)
    if m in r:
        try: d = os.read(m, 4096)
        except OSError: break
        if d:
            with open('/tmp/fd-smoke-got.txt', 'a') as f: f.write(d.decode('utf-8', 'replace'))
    n = int((time.time() - t0) * 2)
    if n != last:
        last = n
        try: os.write(m, ('tick %d\\n' % n).encode())
        except OSError: break
`;
  const proc = spawn('python3', ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('/dev/pts')) resolve({ proc, pty: buf.trim() });
    });
  });
}

(async function main() {
  console.log(`ForgeDeck bridge smoke → ${BASE}`);
  let fake, bridge;
  try {
    fake = await startFakeSerial();
    ok('伪串口创建', !!fake.pty && fs.existsSync(fake.pty), fake.pty);

    if (!fs.existsSync(fake.pty)) throw new Error('伪串口不存在');
    bridge = spawn(process.execPath, [BRIDGE_BIN, '--device', fake.pty, '--port', String(BRIDGE_PORT), '--allow', 'any', '--quiet'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await delay(900);
    ok('bridge 启动', !bridge.exitCode, `exit=${bridge.exitCode}`);

    const added = await req('POST', '/api/remote', { host: '127.0.0.1', port: BRIDGE_PORT, name: NAME });
    ok('接入远端桥 201', added.status === 201, `${added.status} ${added.raw}`);
    ok('映射在线', added.json && added.json.alive === true, JSON.stringify(added.json));
    const ptyPath = added.json && added.json.path;

    const ports = await req('GET', '/api/ports');
    const found = (ports.json?.ports || []).some((p) => p.device === ptyPath && p.remote);
    ok('端口列表包含远端 PTY', found);

    // 从映射后的 PTY 读数据
    let got = '';
    let fd = -1;
    try {
      fd = fs.openSync(ptyPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      const buf = Buffer.alloc(4096);
      const t0 = Date.now();
      while (Date.now() - t0 < 900) {
        try {
          const n = fs.readSync(fd, buf, 0, buf.length, null);
          if (n > 0) got += buf.subarray(0, n).toString();
        } catch (e) { if (e.code !== 'EAGAIN') break; }
        await delay(5);
      }
    } finally {
      if (fd >= 0) try { fs.closeSync(fd); } catch {}
    }
    ok('远端 PTY 能读到串口输出', got.includes('tick'), JSON.stringify(got.slice(0, 60)));

    // 写入映射后的 PTY，看伪串口是否收到
    try {
      fs.writeFileSync(ptyPath, 'hello-from-server\n');
    } catch (e) { /* 某些 PTY 实现写入需保持 fd */ }
    await delay(600);
    const echoed = fs.existsSync('/tmp/fd-smoke-got.txt') ? fs.readFileSync('/tmp/fd-smoke-got.txt', 'utf8') : '';
    ok('伪串口收到服务端写入', echoed.includes('hello-from-server'), JSON.stringify(echoed.slice(-40)));

    // 端口校验：远端 PTY 被允许，工作区外的路径被拒绝（不会真的启动编译）
    const bad = await req('POST', '/api/jobs', {
      kind: 'flash', project: 'blinky', env: 'esp32dev', port: '/etc/passwd', backend: 'platformio',
    });
    ok('非法端口被拒绝', bad.status === 400, `status=${bad.status}`);
    const sock = await req('GET', '/api/ports');
    ok('ports 接口标注 remote 字段', (sock.json?.ports || []).every((p) => typeof p.remote === 'boolean'));

    const del = await req('DELETE', '/api/remote/' + NAME);
    ok('断开桥接', del.status === 200);
  } catch (e) {
    fail++;
    console.log('  ✗ 异常', e.message);
  } finally {
    try { bridge && bridge.kill('SIGTERM'); } catch {}
    try { fake && fake.proc.kill('SIGTERM'); } catch {}
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail) process.exit(1);
  console.log('全部通过 ✅');
})();
