'use strict';
// ForgeDeck — 串口会话：零依赖（stty 配置 + 非阻塞 fd 读写）
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const sessions = new Map(); // device -> SerialSession

class SerialSession {
  constructor(device, baud, onData, onClose) {
    this.device = device;
    this.baud = Number(baud) || 115200;
    this.onData = onData;
    this.onClose = onClose;
    this.fd = -1;
    this.closed = false;
    this.rx = 0;
    this.tx = 0;
    this.buf = Buffer.alloc(4096);
    this._open();
    this._timer = setInterval(() => this._pump(), 3);
  }

  _open() {
    const flags = fs.constants.O_RDWR | fs.constants.O_NONBLOCK;
    this.fd = fs.openSync(this.device, flags);
    const stty = spawnSync('stty', ['-F', this.device, String(this.baud), 'raw', '-echo', '-echoe', '-echok', '-icrnl', '-ixon', '-crtscts', 'cs8', '-cstopb', '-parenb', 'min', '0', 'time', '0'], { timeout: 4000 });
    if (stty.status !== 0) {
      const msg = (stty.stderr || '').toString().trim() || 'stty 配置失败';
      throw new Error(msg);
    }
  }

  _pump() {
    if (this.closed) return;
    let guard = 0;
    while (guard++ < 32) {
      try {
        const n = fs.readSync(this.fd, this.buf, 0, this.buf.length, null);
        if (n > 0) {
          this.rx += n;
          this.onData ? this.onData(this.buf.subarray(0, n)) : null;
          continue;
        }
        break;
      } catch (e) {
        if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') break;
        this.close(`读取失败: ${e.message}`);
        return;
      }
    }
  }

  write(data) {
    if (this.closed) return false;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    try {
      fs.writeSync(this.fd, buf, 0, buf.length);
      this.tx += buf.length;
      return true;
    } catch (e) {
      if (e.code !== 'EAGAIN') this.close(`写入失败: ${e.message}`);
      return false;
    }
  }

  // 硬复位（可选，走 esptool 的 DTR/RTS 时序）
  reset() {
    spawnSync('stty', ['-F', this.device, 'hupcl'], { timeout: 2000 });
    return true;
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._timer);
    try { fs.closeSync(this.fd); } catch {}
    if (sessions.get(this.device) === this) sessions.delete(this.device);
    this.onClose ? this.onClose(reason || 'closed', { rx: this.rx, tx: this.tx }) : null;
  }

  stats() {
    return { device: this.device, baud: this.baud, rx: this.rx, tx: this.tx, closed: this.closed };
  }
}

function acquire(device, baud, onData, onClose) {
  const existing = sessions.get(device);
  if (existing && !existing.closed) {
    existing.close('replaced');
  }
  const s = new SerialSession(device, baud, onData, onClose);
  sessions.set(device, s);
  return s;
}

function list() {
  return [...sessions.values()].filter((s) => !s.closed).map((s) => s.stats());
}

function validate(st) {
  return /^\/dev\/[A-Za-z0-9_-]{1,64}$/.test(st);
}

module.exports = { acquire, list, validate, SerialSession };
