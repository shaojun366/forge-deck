'use strict';
// ForgeDeck — 远端串口接入：把 bridge 暴露的 TCP 流映射成本地 PTY
// 优先用 socat；没有 socat 时用 Python 的 pty 模块（两者都只在服务端运行）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PY_HELPER = path.join(__dirname, 'pty_bridge.py');

function remoteDir() {
  const dir = path.join(os.tmpdir(), 'forge-deck-remote');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function safeName(raw) {
  const n = String(raw || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  return n || `link${Date.now() % 10000}`;
}

function validateHost(h) {
  return /^[A-Za-z0-9._-]{1,63}$/.test(String(h)) || /^(\d+\.\d+\.\d+\.\d+)$/.test(String(h));
}

function haveSocat() {
  const r = spawnSync('which', ['socat'], { timeout: 3000 });
  return r.status === 0;
}

function havePython() {
  const r = spawnSync('which', ['python3'], { timeout: 3000 });
  return r.status === 0 ? 'python3' : '';
}

class RemoteLink {
  constructor({ name, host, port, cfg }) {
    this.name = safeName(name);
    this.host = String(host);
    this.port = Number(port);
    this.dir = remoteDir();
    this.path = path.join(this.dir, `${this.name}.pty`);
    this.since = Date.now();
    this.alive = false;
    this.error = '';
    this.rx = 0;
    this.tx = 0;
    this.proc = null;
    this.start();
  }

  start() {
    if (!validateHost(this.host) || !(this.port > 0 && this.port < 65536)) {
      this.error = 'host/port 非法';
      return;
    }
    const socat = haveSocat();
    let cmd;
    let args;
    if (socat) {
      cmd = 'socat';
      args = [`PTY,link=${this.path},raw,echo=0,waitslave`, `TCP:${this.host}:${this.port},forever,interval=2,connect-timeout=5`];
    } else {
      const py = havePython();
      if (!py) {
        this.error = '需要 socat 或 python3 才能映射远端串口（sudo apt install socat）';
        return;
      }
      cmd = py;
      args = [PY_HELPER, this.host, String(this.port), this.path];
    }
    try {
      this.proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    } catch (e) {
      this.error = e.message;
      return;
    }
    this.backend = socat ? 'socat' : 'python3';
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) this.note = s;
    });
    this.proc.on('error', (e) => { this.error = e.message; this.alive = false; });
    this.proc.on('close', () => { this.alive = false; });
    // 等待 PTY 出现
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (fs.existsSync(this.path)) {
        this.alive = true;
        this.error = '';
        clearInterval(timer);
      } else if (tries > 25 || !this.proc || this.proc.exitCode !== null) {
        this.alive = false;
        clearInterval(timer);
      }
    }, 120);
  }

  stats() {
    return {
      name: this.name,
      host: this.host,
      port: this.port,
      path: this.path,
      alive: this.alive,
      backend: this.backend || '',
      error: this.error,
      note: this.note || '',
      since: this.since,
    };
  }

  stop() {
    try { this.proc && this.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { this.proc && this.proc.kill('SIGKILL'); } catch {} }, 1500);
    try { fs.unlinkSync(this.path); } catch {}
    this.alive = false;
  }
}

class RemoteRegistry {
  constructor(cfg) {
    this.cfg = cfg;
    this.links = new Map();
    this.stateFile = path.join(cfg.rootDir, 'data', 'remotes.json');
    this._restore();
  }

  _restore() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const r of arr) {
        if (!validateHost(r.host) || !(r.port > 0)) continue;
        const key = safeName(r.name);
        const link = new RemoteLink({ name: key, host: r.host, port: r.port, cfg: this.cfg });
        this.links.set(key, link);
      }
    } catch { /* 首次运行 */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const arr = [...this.links.values()].map((l) => ({ name: l.name, host: l.host, port: l.port }));
      fs.writeFileSync(this.stateFile, JSON.stringify(arr, null, 2) + '\n');
    } catch { /* 忽略 */ }
  }

  list() {
    return [...this.links.values()].map((l) => l.stats());
  }

  async add({ name, host, port }) {
    const key = safeName(name || `${host}-${port}`);
    if (this.links.has(key)) {
      const existing = this.links.get(key);
      existing.stop();
      this.links.delete(key);
    }
    const link = new RemoteLink({ name: key, host, port, cfg: this.cfg });
    this.links.set(key, link);
    this._save();
    // 给 PTY 一点时间就绪，避免前端拿到 alive:false 误报
    const t0 = Date.now();
    while (!link.alive && !link.error && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 120));
    }
    return link.stats();
  }

  remove(name) {
    const key = safeName(name);
    const link = this.links.get(key);
    if (!link) return false;
    link.stop();
    this.links.delete(key);
    this._save();
    return true;
  }

  isRemotePath(p) {
    return typeof p === 'string' && p.startsWith(remoteDir() + path.sep);
  }

  sockets() {
    return this.list().filter((l) => l.alive).map((l) => ({
      device: l.path,
      label: `${l.name}  ⇄  ${l.host}:${l.port}`,
      remote: true,
      name: l.name,
    }));
  }
}

module.exports = { RemoteRegistry, remoteDir, haveSocat, havePython, safeName, validateHost };
