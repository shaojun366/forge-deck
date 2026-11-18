'use strict';
// ForgeDeck — 极简 WebSocket 服务端（RFC 6455，仅用于终端/串口流，零依赖）
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.alive = true;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.setNoDelay(true);
    const ping = setInterval(() => {
      if (this.closed) return clearInterval(ping);
      this._frame(0x9, Buffer.alloc(0));
    }, 25000);
    this._pingTimer = ping;
  }

  _finish(reason = 'close') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._pingTimer);
    try { this.socket.destroy(); } catch {}
    this.emit('close', reason);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._frame(0x8, payload);
    setTimeout(() => this._finish('client-close'), 60);
  }

  send(data) {
    if (this.closed) return false;
    if (typeof data === 'string') return this._frame(0x1, Buffer.from(data, 'utf8'));
    if (Buffer.isBuffer(data)) return this._frame(0x2, data);
    return this._frame(0x1, Buffer.from(String(data), 'utf8'));
  }

  _frame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      this._finish('write-error');
      return false;
    }
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n) return this._finish('frame-too-large');
        len = Number(big);
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        const copy = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) copy[i] = payload[i] ^ mask[i & 3];
        payload = copy;
      }
      this.buf = this.buf.subarray(off + maskLen + len);

      if (opcode === 0x8) return this._finish('client-close');
      if (opcode === 0x9) { this._frame(0xA, payload); continue; }
      if (opcode === 0xA) { continue; }
      if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
      else if (opcode === 0x2) this.emit('binary', payload);
      else if (opcode === 0x0) this.emit('continuation', payload);
      if (!fin && opcode !== 0x0) this.emit('fragmented-start', opcode);
    }
  }
}

function upgrade(req, socket, head, handler) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
}
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  if (head && head.length) socket.unshift(head);
  const conn = new WSConnection(socket, req);
  try {
    handler(conn, req);
  } catch (e) {
    conn.send(JSON.stringify({ type: 'error', message: e.message }));
    conn.close(1011, 'internal error');
  }
  return conn;
}

module.exports = { upgrade, WSConnection };
