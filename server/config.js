'use strict';
// ForgeDeck — 配置加载（文件 + 环境变量覆盖）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8083,
  workspace: './workspace',
  token: '',
  siteName: 'ForgeDeck',
  publicUrl: '',
  tailscale: {
    enabled: true,
    whoisAuth: true,
    allowUsers: [],
    allowTags: [],
    allowAnyTailnetDevice: true,
  },
  tools: {
    pio: '',
    esptool: '',
    avrdude: '',
    stflash: 'st-flash',
    dfuUtil: 'dfu-util',
    openocd: 'openocd',
  },
  serial: { defaultBaud: 115200, allowPorts: [] },
  shell: { enabled: true, shell: '' },
  limits: { uploadMB: 32, fileMB: 8, jobsKeep: 30 },
};

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('_')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function load({ configPath } = {}) {
  const here = __dirname;
  const rootDir = path.resolve(here, '..');
  const file = configPath || process.env.FORGEDECK_CONFIG || path.join(rootDir, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config.json 解析失败: ${e.message}`);
    }
  }

  const cfg = deepMerge(DEFAULTS, fileCfg);

  if (process.env.FORGEDECK_TOKEN) cfg.token = process.env.FORGEDECK_TOKEN;
  if (process.env.FORGEDECK_PORT) cfg.port = num(process.env.FORGEDECK_PORT, cfg.port);
  if (process.env.FORGEDECK_HOST) cfg.host = process.env.FORGEDECK_HOST;
  if (process.env.FORGEDECK_WORKSPACE) cfg.workspace = process.env.FORGEDECK_WORKSPACE;

  cfg.port = num(cfg.port, 8083);
  cfg.limits.uploadMB = num(cfg.limits.uploadMB, 32);
  cfg.limits.fileMB = num(cfg.limits.fileMB, 8);
  cfg.limits.jobsKeep = num(cfg.limits.jobsKeep, 30);
  cfg.serial.defaultBaud = num(cfg.serial.defaultBaud, 115200);

  const wsRaw = String(cfg.workspace || './workspace');
  cfg.workspacePath = path.resolve(wsRaw.startsWith('~')
    ? path.join(os.homedir(), wsRaw.slice(1))
    : path.isAbsolute(wsRaw) ? wsRaw : path.join(rootDir, wsRaw));
  if (!fs.existsSync(cfg.workspacePath)) fs.mkdirSync(cfg.workspacePath, { recursive: true });
  cfg.workspaceRealPath = fs.realpathSync(cfg.workspacePath);

  cfg.rootDir = rootDir;
  cfg.configPath = file;
  cfg.configExists = fs.existsSync(file);

  const pioDefault = path.join(os.homedir(), '.local/bin/pio');
  cfg.tools.pio = cfg.tools.pio || (fs.existsSync(pioDefault) ? pioDefault : 'pio');
  cfg.shell.shell = cfg.shell.shell || process.env.SHELL || '/bin/bash';

  return cfg;
}

module.exports = { load, DEFAULTS };
