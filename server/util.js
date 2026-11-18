'use strict';
// ForgeDeck — 通用工具：响应、读体、路径安全、MIME、SSE
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > max) {
        req.destroy();
        reject(Object.assign(new Error('body too large'), { code: 'ETOO_LARGE', status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req, max = 2 * 1024 * 1024) {
  const raw = await readBody(req, max);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

// 解析相对路径 -> 绝对路径；越界、软链、非法字符一律拒绝
function resolveIn(base, target) {
  const raw = String(target ?? '').replace(/^\.\//, '');
  if (raw.includes('\0')) return null;
  const abs = path.resolve(base, raw);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let cur = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code === 'ENOENT') return abs;
      return null;
    }
    if (st.isSymbolicLink()) return null;
  }
  return abs;
}

function relOf(base, abs) {
  return path.relative(base, abs) || '.';
}

// 文本判定：含 NUL 或解码后替换字符过多视为二进制
function looksBinary(buf) {
  if (!buf.length) return false;
  const probe = buf.subarray(0, Math.min(buf.length, 8000));
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return true;
  return false;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function nowISO() {
  return new Date().toISOString();
}

// SSE 帮助器
function openSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    if (event) res.write(`event: ${event}\n`);
    for (const line of payload.split('\n')) res.write(`data: ${line}\n`);
    res.write('\n');
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  const close = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  res.on('close', () => clearInterval(heartbeat));
  return { send, close };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new HttpError(status, message);
}

// 时间格式化（日志用）
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = {
  mimeOf, sendJSON, sendText, readBody, readJSON,
  resolveIn, relOf, looksBinary, fmtSize, nowISO, openSSE, HttpError, fail, stamp,
};
