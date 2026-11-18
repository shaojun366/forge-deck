'use strict';
// ForgeDeck — Tailnet 状态：本机地址、DNS 名、serve/funnel 建议、在线设备
const { spawnSync } = require('node:child_process');

function run(args, timeout = 6000) {
  const r = spawnSync('tailscale', args, { encoding: 'utf8', timeout });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() || r.error?.message || '' };
}

function installed() {
  const r = spawnSync('which', ['tailscale'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

function status() {
  const bin = installed();
  if (!bin) {
    return { installed: false, running: false, hint: '未检测到 tailscale CLI：https://tailscale.com/download' };
  }
  const s = run(['status', '--json']);
  if (!s.ok || !s.out) {
    return { installed: true, running: false, error: s.err || 'tailscale status 失败', hint: 'sudo tailscale up' };
  }
  let data;
  try { data = JSON.parse(s.out); } catch { return { installed: true, running: false, error: 'JSON 解析失败' }; }
  const self = data.Self || {};
  const peers = Object.values(data.Peer || {}).map((p) => ({
    host: p.HostName,
    dns: p.DNSName,
    ip: (p.TailscaleIPs || [])[0],
    online: !!p.Online,
    os: p.OS,
    user: p.UserID,
  }));
  return {
    installed: true,
    running: true,
    version: data.Version,
    backendState: data.BackendState,
    magicDnsSuffix: data.MagicDNSSuffix,
    tailnetName: data.CurrentTailnet && data.CurrentTailnet.Name,
    self: {
      host: self.HostName,
      dns: (self.DNSName || '').replace(/\.$/, ''),
      ips: self.TailscaleIPs || [],
      online: !!self.Online,
      os: self.OS,
    },
    peersOnline: peers.filter((p) => p.online).length,
    peersTotal: peers.length,
    peers: peers.slice(0, 30),
  };
}

function serveStatus() {
  const s = run(['serve', 'status', '--json']);
  if (!s.ok) return { ok: false, error: s.err };
  try { return { ok: true, raw: JSON.parse(s.out) }; } catch { return { ok: false, error: 'parse' }; }
}

function tips(port, dnsName) {
  const host = dnsName || '<machine>.<tailnet>.ts.net';
  return {
    local: `http://127.0.0.1:${port}`,
    tailnetHttps: `https://${host}`,
    commands: [
      `# 仅 tailnet 内访问（推荐，自动签发 TLS 证书）`,
      `tailscale serve --bg http://127.0.0.1:${port}`,
      ``,
      `# 映射到自定义端口 8443`,
      `tailscale serve --bg --https 8443 http://127.0.0.1:${port}`,
      ``,
      `# 暴露到公网（慎用，配合 token + allowUsers）`,
      `tailscale funnel --bg http://127.0.0.1:${port}`,
      ``,
      `# 关闭`,
      `tailscale serve reset`,
    ],
  };
}

module.exports = { status, serveStatus, tips, installed };
