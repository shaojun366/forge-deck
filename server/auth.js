'use strict';
// ForgeDeck — 鉴权：静态 token + Tailscale WhoIs 身份识别
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.fd_token) return cookies.fd_token;
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-forgedeck-token']) return String(req.headers['x-forgedeck-token']);
  return '';
}

function isTailscaleIP(addr) {
  const a = String(addr || '');
  // 100.64.0.0/10 (CGNAT 区间) 与 fd7a:115c:a1e0::/48
  const m = a.match(/^100\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    return second >= 64 && second <= 127;
  }
  return a.startsWith('fd7a:115c:a1e0:') || a === '::1' || a === '127.0.0.1';
}

function normalizeIP(addr) {
  return String(addr || '').replace(/^::ffff:/, '');
}

// tailscale whois --json <ip>  ->  {User, Node, ...}
function whois(ip) {
  try {
    const r = spawnSync('tailscale', ['whois', '--json', ip], { encoding: 'utf8', timeout: 4000 });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

class Auth {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.token = String(cfg.token || '');
    this.tt = cfg.tailscale || {};
    this.whoisCache = new Map(); // ip -> {at, data}
  }

  get tokenRequired() {
    return this.token.length > 0;
  }

  _whoisCached(ip) {
    const hit = this.whoisCache.get(ip);
    if (hit && Date.now() - hit.at < 60_000) return hit.data;
    const data = whois(ip);
    this.whoisCache.set(ip, { at: Date.now(), data });
    return data;
  }

  // 返回 { ok, user, via } ；user = { login, name, node, tags }
  identify(req) {
    const ip = normalizeIP(req.socket.remoteAddress);
    const supplied = tokenFromRequest(req);

    if (this.token && supplied && timingEqual(supplied, this.token)) {
      return { ok: true, user: { login: 'token', name: 'token-holder', node: 'local', tags: [] }, via: 'token' };
    }

    // 本机回环：无令牌模式下直接放行
    if (!this.token && (ip === '127.0.0.1' || ip === '::1')) {
      return { ok: true, user: { login: 'local', name: 'local', node: 'loopback', tags: [] }, via: 'loopback' };
    }

    if (this.tt.enabled && this.tt.whoisAuth && isTailscaleIP(ip)) {
      const w = this._whoisCached(ip);
      if (w && (w.User || w.Node)) {
        const login = (w.User && (w.User.LoginName || w.User.Name)) || '';
        const name = (w.User && w.User.DisplayName) || login;
        const node = w.Node && (w.Node.Name || w.Node.ComputedName);
        const tags = (w.Node && (w.Node.Tags || w.Node.Hostinfo?.Tags)) || [];
        const allowed = this._isAllowed(login, tags, w);
        if (allowed) {
          return {
            ok: true,
            user: { login: login || node || ip, name: name || login, node: node || '', tags: Array.isArray(tags) ? tags : [] },
            via: 'tailscale',
          };
        }
        return { ok: false, reason: `tailnet 身份 ${login || node || ip} 未被允许`, ip };
      }
      if (this.tt.allowAnyTailnetDevice && !this.token) {
        return { ok: true, user: { login: ip, name: 'tailnet-device', node: ip, tags: [] }, via: 'tailnet-ip' };
      }
    }

    return { ok: false, reason: '需要访问令牌', ip };
  }

  _isAllowed(login, tags, whoisData) {
    const users = this.tt.allowUsers || [];
    const allowTags = this.tt.allowTags || [];
    if (!users.length && !allowTags.length) return this.tt.allowAnyTailnetDevice !== false;
    if (login && users.some((u) => u.toLowerCase() === String(login).toLowerCase())) return true;
    const tagList = Array.isArray(tags) ? tags : [];
    if (allowTags.length && tagList.some((t) => allowTags.includes(t))) return true;
    // whois 的 Node.Tags 有时在 Hostinfo 之外
    const hi = whoisData && whoisData.Node && whoisData.Node.Hostinfo;
    if (hi && Array.isArray(hi.Tags) && hi.Tags.some((t) => allowTags.includes(t))) return true;
    return false;
  }

  // 静态资源无条件放行；/api 与 /ws 需要身份
  require(req, res) {
    const who = this.identify(req);
    if (who.ok) return who;
    const msg = who.reason || '未授权';
    if (res) {
      if (String(req.url || '').startsWith('/api/')) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: msg, needToken: this.tokenRequired }));
      } else {
        res.writeHead(302, { Location: '/?login=1' });
        res.end();
      }
    }
    return null;
  }
}

module.exports = { Auth, parseCookies, tokenFromRequest, isTailscaleIP, normalizeIP, whois };
