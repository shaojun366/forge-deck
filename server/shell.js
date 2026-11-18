'use strict';
// ForgeDeck — 交互式终端：优先 script(1) 提供真 PTY，缺失时退化为管道 shell
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');

function hasScript() {
  const r = spawnSync('which', ['script'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

class ShellSession {
  constructor({ shell, cwd, cols = 160, rows = 40, onData, onClose }) {
    this.onData = onData;
    this.onClose = onClose;
    this.closed = false;
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    const scriptBin = hasScript();
    const shellCmd = shell || process.env.SHELL || '/bin/bash';
    this.pty = !!scriptBin;

    if (scriptBin) {
      // script -qfc "<初始化>; <shell> -i" /dev/null
      // 初始化里一次性设定窗口尺寸，避免连接后终端里出现一行 stty 命令
      const init = `stty rows ${rows} cols ${cols} 2>/dev/null || true; exec ${shellCmd} -i`;
      this.proc = spawn(scriptBin, ['-qfc', init, '/dev/null'], {
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLUMNS: String(cols),
          LINES: String(rows),
          FORGEDECK: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      this.proc = spawn(shellCmd, ['-i'], {
        cwd,
        env: { ...process.env, TERM: 'dumb', FORGEDECK: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    this.proc.stdout.on('data', (d) => this._out(d));
    this.proc.stderr.on('data', (d) => this._out(d));
    this.proc.on('error', (e) => this._out(`\r\n[shell error] ${e.message}\r\n`));
    this.proc.on('close', (code) => this.close(`shell exited (${code})`));
    // 初始化窗口尺寸
    setTimeout(() => this.resize(cols, rows), 120);
  }

  _out(data) {
    if (this.closed) return;
    this.onData ? this.onData(data.toString('utf8')) : null;
  }

  write(text) {
    if (this.closed || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(text);
    return true;
  }

  resize(cols, rows) {
    const nc = Math.max(20, Math.min(500, Number(cols) || this.cols));
    const nr = Math.max(5, Math.min(200, Number(rows) || this.rows));
    if (nc === this.cols && nr === this.rows) return;
    this.cols = nc;
    this.rows = nr;
    if (this.closed) return;
    if (this.pty) {
      // script 不会跟随前端窗口；向 PTY 注入一次 stty（终端里会短暂看到该行）
      this.write(`\x1b[?25l\r\x1b[Kstty rows ${nr} cols ${nc} 2>/dev/null; \x1b[?25h`);
      this.write('\x0c');
    }
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch {} }, 1500);
    this.onClose ? this.onClose(reason) : null;
  }
}

module.exports = { ShellSession, hasScript, ptyAvailable: () => !!hasScript() };
