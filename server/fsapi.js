'use strict';
// ForgeDeck — 工作区文件 API
const fs = require('node:fs');
const path = require('node:path');
const { resolveIn, relOf, looksBinary, fmtSize, fail } = require('./util');

const HIDDEN_OK = new Set(['.github', '.vscode', '.gitignore', '.editorconfig', '.clang-format', '.env.example']);
const SKIP_ALWAYS = new Set(['node_modules', '.git', '.pio', '.venv', 'venv', '__pycache__', '.cache']);

function visible(name, showHidden) {
  if (SKIP_ALWAYS.has(name)) return false;
  if (name.startsWith('.')) return showHidden || HIDDEN_OK.has(name);
  return true;
}

function listDir(root, dir, { showHidden = false } = {}) {
  const abs = resolveIn(root, dir || '');
  if (!abs) fail(400, '非法路径');
  if (!fs.existsSync(abs)) fail(404, '目录不存在');
  if (!fs.statSync(abs).isDirectory()) fail(400, '不是目录');
  const entries = [];
  for (const name of fs.readdirSync(abs)) {
    if (!visible(name, showHidden)) continue;
    const full = path.join(abs, name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    const entry = {
      name,
      path: relOf(root, full),
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isFile() ? st.size : 0,
      sizeText: st.isFile() ? fmtSize(st.size) : '',
      mtime: st.mtimeMs,
      ext: st.isFile() ? path.extname(name).slice(1).toLowerCase() : '',
    };
    if (entry.type === 'dir') {
      try { entry.children = fs.readdirSync(full).filter((n) => visible(n, false)).length; } catch { entry.children = 0; }
      try { entry.isProject = fs.existsSync(path.join(full, 'platformio.ini')); } catch {}
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1));
  return { dir: relOf(root, abs), entries };
}

function readFile(root, rel, maxBytes) {
  const abs = resolveIn(root, rel);
  if (!abs) fail(400, '非法路径');
  if (!fs.existsSync(abs)) fail(404, '文件不存在');
  const st = fs.statSync(abs);
  if (!st.isFile()) fail(400, '不是文件');
  if (st.size > maxBytes) fail(413, `文件过大 (${fmtSize(st.size)})，上限 ${fmtSize(maxBytes)}`);
  const buf = fs.readFileSync(abs);
  const binary = looksBinary(buf);
  return {
    path: relOf(root, abs),
    size: st.size,
    sizeText: fmtSize(st.size),
    mtime: st.mtimeMs,
    binary,
    content: binary ? '' : buf.toString('utf8'),
  };
}

function writeFile(root, rel, content) {
  const abs = resolveIn(root, rel);
  if (!abs) fail(400, '非法路径');
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${abs}.fd-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
  return { path: relOf(root, abs), size: fs.statSync(abs).size };
}

function mkdir(root, rel) {
  const abs = resolveIn(root, rel);
  if (!abs) fail(400, '非法路径');
  if (fs.existsSync(abs)) fail(409, '已存在');
  fs.mkdirSync(abs, { recursive: true });
  return { path: relOf(root, abs) };
}

function createFile(root, rel, content = '') {
  const abs = resolveIn(root, rel);
  if (!abs) fail(400, '非法路径');
  if (fs.existsSync(abs)) fail(409, '已存在');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { path: relOf(root, abs) };
}

function rename(root, from, to) {
  const a = resolveIn(root, from);
  const b = resolveIn(root, to);
  if (!a || !b) fail(400, '非法路径');
  if (!fs.existsSync(a)) fail(404, '源不存在');
  if (fs.existsSync(b)) fail(409, '目标已存在');
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
  return { from: relOf(root, a), to: relOf(root, b) };
}

function remove(root, rel, recursive) {
  const abs = resolveIn(root, rel);
  if (!abs) fail(400, '非法路径');
  if (abs === root) fail(400, '不能删除工作区根');
  if (!fs.existsSync(abs)) fail(404, '不存在');
  const st = fs.lstatSync(abs);
  if (st.isDirectory()) {
    if (!recursive) fail(400, '目录需要 recursive=true');
    fs.rmSync(abs, { recursive: true, force: true });
  } else {
    fs.unlinkSync(abs);
  }
  return { path: relOf(root, abs) };
}

function saveUpload(root, rel, buffer) {
  const abs = resolveIn(root, rel);
  if (!abs) fail(400, '非法路径');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return { path: relOf(root, abs), size: buffer.length, sizeText: fmtSize(buffer.length) };
}

function search(root, query, dirRel, limit = 200) {
  const q = String(query || '').trim();
  if (!q) fail(400, '搜索词为空');
  const base = resolveIn(root, dirRel || '');
  if (!base) fail(400, '非法路径');
  const lower = q.toLowerCase();
  const results = [];
  const stack = [base];
  while (stack.length && results.length < limit) {
    const dir = stack.pop();
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (it.name.startsWith('.') || SKIP_ALWAYS.has(it.name)) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { stack.push(full); continue; }
      if (it.name.toLowerCase().includes(lower)) {
        results.push({ path: relOf(root, full), hit: 'name', line: 0, text: '' });
        continue;
      }
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 512 * 1024) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        if (lines[i].toLowerCase().includes(lower)) {
          results.push({ path: relOf(root, full), hit: 'content', line: i + 1, text: lines[i].slice(0, 200).trim() });
          break;
        }
      }
    }
  }
  return { query: q, results, limited: results.length >= limit };
}

function stat(root, rel) {
  const abs = resolveIn(root, rel);
  if (!abs || !fs.existsSync(abs)) fail(404, '不存在');
  const st = fs.statSync(abs);
  return { path: relOf(root, abs), isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
}

function downloadPath(root, rel) {
  const abs = resolveIn(root, rel);
  if (!abs || !fs.existsSync(abs)) fail(404, '不存在');
  const st = fs.statSync(abs);
  if (!st.isFile()) fail(400, '不是文件');
  return { abs, size: st.size, name: path.basename(abs) };
}

module.exports = { listDir, readFile, writeFile, mkdir, createFile, rename, remove, saveUpload, search, stat, downloadPath };
