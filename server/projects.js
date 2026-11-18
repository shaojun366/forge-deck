'use strict';
// ForgeDeck — 项目识别：扫描工作区中的固件工程与构建环境
const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.pio', '.venv', 'venv', '__pycache__', 'build', 'dist', '.cache']);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function platformioEnvs(projectDir) {
  const ini = readText(path.join(projectDir, 'platformio.ini'));
  if (!ini) return [];
  return [...ini.matchAll(/\[env:([^\]]+)\]/g)].map((m) => m[1].trim());
}

function pioBoardHints(projectDir) {
  const ini = readText(path.join(projectDir, 'platformio.ini'));
  const out = { boards: [], frameworks: [], platforms: [] };
  for (const m of ini.matchAll(/board\s*=\s*([^\n\r#]+)/g)) out.boards.push(m[1].trim());
  for (const m of ini.matchAll(/framework\s*=\s*([^\n\r#]+)/g)) out.frameworks.push(m[1].trim());
  for (const m of ini.matchAll(/platform\s*=\s*([^\n\r#]+)/g)) out.platforms.push(m[1].trim());
  return out;
}

function detectKind(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('platformio.ini')) return 'platformio';
  if (has('arduino-cli.yaml') || fs.readdirSync(dir).some((f) => f.endsWith('.ino'))) return 'arduino';
  if (has('Makefile') || has('makefile') || has('GNUmakefile')) return 'make';
  if (has('CMakeLists.txt')) return 'cmake';
  if (has('Cargo.toml')) return 'cargo';
  if (has('package.json')) return 'node';
  if (has('meson.build')) return 'meson';
  if (has('west.yml')) return 'zephyr';
  if (fs.readdirSync(dir).some((f) => f.endsWith('.c') || f.endsWith('.cpp') || f.endsWith('.h'))) return 'c';
  return '';
}

function readChildren(dir, depth = 2, maxEntries = 40) {
  const out = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items.slice(0, maxEntries)) {
    if (!it.isDirectory()) continue;
    if (it.name.startsWith('.') || SKIP_DIRS.has(it.name)) continue;
    const full = path.join(dir, it.name);
    const kind = detectKind(full);
    if (kind) {
      out.push({
        dir: full,
        name: it.name,
        kind,
        envs: kind === 'platformio' ? platformioEnvs(full) : [],
        hints: kind === 'platformio' ? pioBoardHints(full) : null,
      });
    }
    if (depth > 1) out.push(...readChildren(full, depth - 1, maxEntries));
  }
  return out;
}

function scan(root) {
  const projects = [];
  const self = detectKind(root);
  if (self) {
    projects.push({
      dir: root,
      name: path.basename(root) || 'workspace',
      kind: self,
      envs: self === 'platformio' ? platformioEnvs(root) : [],
      hints: self === 'platformio' ? pioBoardHints(root) : null,
      root: true,
    });
  }
  projects.push(...readChildren(root, 2));
  return projects.map((p) => ({ ...p, dir: path.relative(root, p.dir) || '.' }));
}

function describe(projectDir) {
  const kind = detectKind(projectDir);
  const envs = kind === 'platformio' ? platformioEnvs(projectDir) : [];
  // 常见产物路径
  const artifacts = [];
  const pioBuild = path.join(projectDir, '.pio/build');
  if (fs.existsSync(pioBuild)) {
    for (const env of fs.readdirSync(pioBuild)) {
      const fw = path.join(pioBuild, env, 'firmware.bin');
      if (fs.existsSync(fw)) artifacts.push({ env, file: fw, size: fs.statSync(fw).size });
    }
  }
  return { kind, envs, artifacts };
}

module.exports = { scan, describe, detectKind, platformioEnvs, pioBoardHints };
