'use strict';
/* ForgeDeck — Web 控制台前端
 * 无构建步骤：原生 JS + CodeMirror 5 / xterm.js（优先本地 vendor，其次 CDN，失败降级）
 */

// ── 小工具 ─────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function setMsg(text, kind = '') {
  const el = $('#stMsg');
  el.textContent = text;
  el.className = kind;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeStr(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// 顺序尝试加载远程脚本/样式
async function loadFirst(urls, testFn) {
  for (const url of urls) {
    if (testFn && testFn()) return true;
    await new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
    if (!testFn || testFn()) return true;
  }
  return false;
}

async function loadFirstCss(urls, marker) {
  if (marker && document.querySelector(`style[data-${marker}]`)) return true;
  for (const url of urls) {
    const loaded = await new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = url;
      l.onload = () => resolve(true);
      l.onerror = () => resolve(false);
      // 插到 head 最前面：让 style.css 里的皮肤规则可以覆盖第三方默认主题
      document.head.insertBefore(l, document.head.firstChild);
    });
    if (loaded) return true;
  }
  return false;
}

// ── 全局状态 ─────────────────────────────────
const S = {
  cfg: null,
  user: null,
  tree: new Map(),          // dirPath -> entries
  expanded: new Set(),      // 展开的目录
  tabs: new Map(),          // path -> {content, saved, dirty, binary, size}
  active: null,
  editor: null,             // CodeMirror 实例或 null
  fallback: null,           // textarea 降级
  currentJobId: null,
  sse: null,
  serialWs: null,
  term: null,
  termWs: null,
  termFit: null,
  bottomH: 268,
};

// ── API ─────────────────────────────────────
async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opt = { method, credentials: 'same-origin', headers: { ...headers } };
  if (raw !== undefined) {
    opt.body = raw;
  } else if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  if (res.status === 401) {
    showLogin(S.user ? '登录已过期，请重新输入令牌' : null);
    throw new Error('unauthorized');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ── 登录 ─────────────────────────────────────
function showLogin(hint) {
  $('#loginOverlay').classList.remove('hidden');
  if (hint) $('#loginHint').textContent = hint;
}

async function doLogin() {
  const token = $('#tokenInput').value.trim();
  $('#loginErr').textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    $('#loginOverlay').classList.add('hidden');
    S.user = data.user;
    $('#whoPill').textContent = `${data.user.name || data.user.login}${data.via === 'tailscale' ? ' · ts' : ''}`;
    await boot();
  } catch (e) {
    $('#loginErr').textContent = e.message;
  }
}

// ── 启动流程 ─────────────────────────────────
async function boot() {
  S.cfg = await api('/api/config');
  $('#verLabel').textContent = 'v' + S.cfg.version;
  $('#stRoot').textContent = S.cfg.workspaceName;
  $('#whoPill').textContent = S.user ? (S.user.name || S.user.login) : 'local';
  setMsg('就绪');
  $('#stConn').className = 'ok';
  $('#stConn').textContent = '已连接 · ' + (S.cfg.host || 'server');
  await Promise.all([loadTree(''), loadProjects(), loadPorts(), loadTailnetMini()]);
  await initEditor();
  initTerminalIfNeeded(false);
  refreshWebSerialButtons();
}

// ── 文件树 ───────────────────────────────────
async function fetchDir(dir) {
  const data = await api('/api/tree?dir=' + encodeURIComponent(dir));
  S.tree.set(dir, data.entries);
  return data.entries;
}

async function loadTree(dir = '') {
  const tree = $('#tree');
  tree.innerHTML = '<div class="empty">加载中…</div>';
  try {
    await fetchDir(dir);
    renderTree([]);
  } catch (e) {
    tree.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

function renderTree() {
  const tree = $('#tree');
  tree.innerHTML = '';
  const rootEntries = S.tree.get('') || [];
  renderLevel(rootEntries, '', 0, tree);
  if (!rootEntries.length) {
    tree.innerHTML = '<div class="empty">工作区为空。新建文件，或把固件工程放进工作区目录。</div>';
  }
}

function renderLevel(entries, dir, depth, container) {
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'node ' + (e.type === 'dir' ? 'dir' : 'file');
    if (e.type === 'file' && e.path === S.active) row.classList.add('active');
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    row.dataset.path = e.path;
    row.dataset.type = e.type;

    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = e.type === 'dir' ? (S.expanded.has(e.path) ? '▾' : '▸') : '';
    row.appendChild(tw);

    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = e.type === 'dir' ? '🗀' : iconFor(e.ext);
    row.appendChild(ic);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = e.name;
    nm.title = e.path;
    row.appendChild(nm);

    if (e.isProject) {
      const b = document.createElement('span');
      b.className = 'pio';
      b.textContent = 'pio';
      row.appendChild(b);
    } else if (e.type === 'dir' && e.children) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = e.children;
      row.appendChild(b);
    }

    row.onclick = async () => {
      if (e.type === 'dir') {
        if (S.expanded.has(e.path)) {
          S.expanded.delete(e.path);
          renderTree();
        } else {
          S.expanded.add(e.path);
          if (!S.tree.has(e.path)) {
            try { await fetchDir(e.path); } catch (err) { toast(err.message, 'err'); S.expanded.delete(e.path); }
          }
          renderTree();
        }
        if (e.isProject) selectProject(e.path);
      } else {
        openFile(e.path);
      }
    };
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      fileMenu(e, ev);
    };
    container.appendChild(row);

    if (e.type === 'dir' && S.expanded.has(e.path)) {
      const kids = S.tree.get(e.path);
      if (kids) renderLevel(kids, e.path, depth + 1, container);
    }
  }
}

function iconFor(ext) {
  if (['c', 'h', 'cpp', 'hpp', 'cc'].includes(ext)) return '🅲';
  if (['py'].includes(ext)) return '🐍';
  if (['js', 'ts'].includes(ext)) return '🅹';
  if (['json', 'yml', 'yaml', 'ini', 'toml'].includes(ext)) return '⚙';
  if (['md', 'txt', 'rst'].includes(ext)) return '📄';
  if (['bin', 'hex', 'uf2', 'elf', 'img', 'dfu'].includes(ext)) return '💾';
  if (['sh', 'bash'].includes(ext)) return '$';
  return '·';
}

async function refreshTreeAll() {
  S.tree.clear();
  for (const d of S.expanded) S.tree.delete(d);
  await loadTree('');
}

// 右键菜单
function fileMenu(entry, ev) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'dialog-mask';
  menu.style.background = 'transparent';
  const box = document.createElement('div');
  box.className = 'dialog';
  box.style.cssText = `position:fixed;left:${Math.min(ev.clientX, window.innerWidth - 260)}px;top:${Math.min(ev.clientY, window.innerHeight - 200)}px;width:240px;padding:8px;`;
  box.innerHTML = `<div style="font-size:11px;color:var(--text3);padding:4px 8px 8px;word-break:break-all">${escapeHtml(entry.path)}</div>`;
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.style.cssText = 'display:block;width:100%;text-align:left;padding:6px 8px';
    b.textContent = label;
    b.onclick = () => { closeMenus(); fn(); };
    box.appendChild(b);
  };
  mk('重命名', () => promptDialog('重命名', entry.path, (v) => renameEntry(entry, v)));
  mk('删除', () => {
    if (confirm(`删除 ${entry.path}？`)) api('/api/fs/delete', { method: 'POST', body: { path: entry.path, recursive: true } })
      .then(() => { toast('已删除', 'ok'); refreshTreeAll(); })
      .catch((e) => toast(e.message, 'err'));
  });
  if (entry.type === 'file') {
    mk('下载', () => { location.href = '/api/fs/download?path=' + encodeURIComponent(entry.path); });
    mk('另存为…', () => promptDialog('另存为', entry.path, async (v) => {
      const src = await api('/api/file?path=' + encodeURIComponent(entry.path));
      await api('/api/file', { method: 'PUT', body: { path: v, content: src.content } });
      toast('已另存', 'ok');
      refreshTreeAll();
    }));
  }
  mk('取消', () => {});
  menu.appendChild(box);
  menu.onclick = (e) => { if (e.target === menu) closeMenus(); };
  document.body.appendChild(menu);
}

function closeMenus() {
  $$('.dialog-mask[data-menu]').forEach((m) => m.remove());
  $$('.dialog-mask').forEach((m) => { if (m.style.background === 'transparent') m.remove(); });
}

async function renameEntry(entry, to) {
  await api('/api/fs/rename', { method: 'POST', body: { from: entry.path, to } });
  toast('已重命名', 'ok');
  if (S.tabs.has(entry.path)) { S.tabs.delete(entry.path); }
  await refreshTreeAll();
}

// 简易输入对话框
function promptDialog(title, value, onOk) {
  const mask = document.createElement('div');
  mask.className = 'dialog-mask';
  mask.innerHTML = `<div class="dialog">
    <h3>${escapeHtml(title)}</h3>
    <div class="row"><input type="text" value="${escapeHtml(value)}"></div>
    <div class="actions"><button class="ghost" data-x>取消</button><button class="primary" data-ok>确定</button></div>
  </div>`;
  document.body.appendChild(mask);
  const input = $('input', mask);
  input.focus();
  input.select();
  const close = () => mask.remove();
  $('[data-x]', mask).onclick = close;
  $('[data-ok]', mask).onclick = async () => {
    const v = input.value.trim();
    close();
    if (!v) return;
    try { await onOk(v); } catch (e) { toast(e.message, 'err'); }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') $('[data-ok]', mask).click(); if (e.key === 'Escape') close(); };
}

// ── 搜索 ─────────────────────────────────────
async function runSearch() {
  const q = $('#searchInput').value.trim();
  const box = $('#searchResults');
  if (!q) { box.classList.add('hidden'); $('#tree').classList.remove('hidden'); return; }
  box.classList.remove('hidden');
  $('#tree').classList.add('hidden');
  box.innerHTML = '<div class="empty">搜索中…</div>';
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    if (!data.results.length) { box.innerHTML = '<div class="empty">无结果</div>'; return; }
    box.innerHTML = '';
    for (const r of data.results) {
      const el = document.createElement('div');
      el.className = 'hit';
      el.innerHTML = `<div class="p">${escapeHtml(r.path)}</div>` +
        (r.hit === 'content' ? `<div><span class="ln">${r.line}:</span> <span class="tx">${escapeHtml(r.text)}</span></div>` : '');
      el.onclick = () => openFile(r.path, r.line || 0);
      box.appendChild(el);
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

function exitSearch() {
  $('#searchResults').classList.add('hidden');
  $('#tree').classList.remove('hidden');
  $('#searchInput').value = '';
}

// ── 编辑器 ───────────────────────────────────
const MODES = {
  c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', hpp: 'text/x-c++src', cc: 'text/x-c++src',
  py: 'python', js: 'javascript', mjs: 'javascript', ts: 'text/typescript', json: 'application/json',
  md: 'gfm', markdown: 'gfm', yaml: 'yaml', yml: 'yaml', ini: 'properties', toml: 'toml',
  sh: 'shell', bash: 'shell', html: 'htmlmixed', css: 'css', xml: 'xml', txt: '',
};

async function initEditor() {
  const ok = await loadFirst(
    ['/vendor/codemirror.js', 'https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.js'],
    () => !!window.CodeMirror
  );
  if (ok) {
    await loadFirstCss(
      ['/vendor/codemirror.css', 'https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.css'],
      'cm-css'
    );
    await loadFirst([
      '/vendor/cm-modes.js',
      'https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/clike/clike.min.js',
    ], () => false);
    await Promise.all([
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/python/python.min.js'], () => false),
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/javascript/javascript.min.js'], () => false),
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/markdown/markdown.min.js'], () => false),
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/yaml/yaml.min.js'], () => false),
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/properties/properties.min.js'], () => false),
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/shell/shell.min.js'], () => false),
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/xml/xml.min.js'], () => false),
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/css/css.min.js'], () => false),
      loadFirst(['https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/edit/matchbrackets.js'], () => false),
    ]);
    S.editor = CodeMirror($('#editor'), {
      value: '',
      mode: 'text/plain',
      theme: 'default',
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: false,
      viewportMargin: Infinity,
      extraKeys: {
        'Ctrl-S': () => saveFile(),
        'Cmd-S': () => saveFile(),
      },
    });
    S.editor.on('change', () => markDirty());
    S.editor.on('cursorActivity', () => {
      const p = S.editor.getCursor();
      $('#stCursor').textContent = `行 ${p.line + 1}，列 ${p.ch + 1}`;
    });
    S.editor.setSize('100%', '100%');
    $('#editor').classList.add('hidden');
  } else {
    // 降级：纯 textarea
    const ta = document.createElement('textarea');
    ta.className = 'fallback-editor';
    ta.spellcheck = false;
    ta.oninput = () => markDirty();
    $('#editor').appendChild(ta);
    $('#editor').classList.add('hidden');
    S.fallback = ta;
    toast('编辑器组件加载失败，已切换为纯文本模式', 'err');
  }
}

function setEditorContent(content, path) {
  const mode = MODES[path.split('.').pop().toLowerCase()] || '';
  if (S.editor) {
    S.editor.setValue(content);
    S.editor.setOption('mode', mode);
    S.editor.clearHistory();
    S.editor.refresh();
  } else if (S.fallback) {
    S.fallback.value = content;
  }
}

function getEditorContent() {
  return S.editor ? S.editor.getValue() : S.fallback ? S.fallback.value : '';
}

function markDirty() {
  if (!S.active) return;
  const t = S.tabs.get(S.active);
  if (!t) return;
  t.content = getEditorContent();
  t.dirty = t.content !== t.saved;
  renderTabs();
}

async function openFile(path, line = 0) {
  try {
    if (S.active && S.tabs.has(S.active)) S.tabs.get(S.active).content = getEditorContent();
    let tab = S.tabs.get(path);
    if (!tab) {
      const data = await api('/api/file?path=' + encodeURIComponent(path));
      tab = { path, content: data.content, saved: data.content, dirty: false, binary: data.binary, size: data.size, sizeText: data.sizeText };
      S.tabs.set(path, tab);
    }
    if (tab.binary) {
      toast('二进制文件不可编辑，可在树中右键下载', 'err');
      return;
    }
    S.active = path;
    $('#welcome').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    setEditorContent(tab.content, path);
    if (line && S.editor) {
      S.editor.setCursor({ line: line - 1, ch: 0 });
      S.editor.scrollIntoView({ line: line - 1, ch: 0 }, 80);
    }
    $('#stFile').textContent = path + ' · ' + tab.sizeText;
    renderTabs();
    renderTree();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function saveFile() {
  if (!S.active) return;
  const tab = S.tabs.get(S.active);
  if (!tab) return;
  try {
    setMsg('保存中…');
    const content = getEditorContent();
    await api('/api/file', { method: 'PUT', body: { path: S.active, content } });
    tab.saved = content;
    tab.content = content;
    tab.dirty = false;
    renderTabs();
    setMsg('已保存 ' + S.active, 'ok');
  } catch (e) {
    setMsg('保存失败: ' + e.message, 'err');
    toast(e.message, 'err');
  }
}

function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = '';
  for (const [path, tab] of S.tabs) {
    const t = document.createElement('div');
    t.className = 'tab' + (path === S.active ? ' active' : '') + (tab.dirty ? ' dirty' : '');
    t.title = path;
    t.innerHTML = `<span class="dot"></span><span>${escapeHtml(path.split('/').pop())}</span><span class="x">✕</span>`;
    t.onclick = (ev) => {
      if (ev.target.classList.contains('x')) { closeTab(path); return; }
      openFile(path);
    };
    el.appendChild(t);
  }
}

function closeTab(path) {
  const tab = S.tabs.get(path);
  if (tab && tab.dirty && !confirm(`${path} 有未保存修改，关闭？`)) return;
  S.tabs.delete(path);
  if (S.active === path) {
    const next = [...S.tabs.keys()].pop();
    S.active = next || null;
    if (next) openFile(next);
    else {
      S.active = null;
      setEditorContent('', '');
      $('#editor').classList.add('hidden');
      $('#welcome').classList.remove('hidden');
      $('#stFile').textContent = '—';
    }
  }
  renderTabs();
  renderTree();
}

// ── 新建 / 上传 ──────────────────────────────
async function newFile() {
  const base = S.expanded.size ? [...S.expanded].pop() : '';
  promptDialog('新建文件', (base ? base + '/' : '') + 'main.c', async (v) => {
    await api('/api/fs/touch', { method: 'POST', body: { path: v } });
    toast('已创建 ' + v, 'ok');
    await refreshTreeAll();
    openFile(v);
  });
}

async function newDir() {
  const base = S.expanded.size ? [...S.expanded].pop() : '';
  promptDialog('新建目录', (base ? base + '/' : '') + 'newdir', async (v) => {
    await api('/api/fs/mkdir', { method: 'POST', body: { path: v } });
    toast('已创建目录', 'ok');
    await refreshTreeAll();
  });
}

function uploadFiles() {
  const picker = $('#filePicker');
  picker.value = '';
  picker.click();
}

async function onPickedFiles() {
  const files = [...$('#filePicker').files];
  if (!files.length) return;
  const base = S.expanded.size ? [...S.expanded].pop() : '';
  for (const f of files) {
    const target = (base ? base + '/' : '') + f.name;
    try {
      await api('/api/fs/upload?path=' + encodeURIComponent(target), { method: 'POST', raw: f });
      toast(`已上传 ${target} (${fmtBytes(f.size)})`, 'ok');
    } catch (e) {
      toast(`${f.name}: ${e.message}`, 'err');
    }
  }
  await refreshTreeAll();
}

// ── 工程 / 端口 ──────────────────────────────
let projectsCache = [];

async function loadProjects() {
  try {
    const data = await api('/api/projects');
    projectsCache = data.projects;
    const sel = $('#projectSel');
    sel.innerHTML = '<option value="">工程…</option>';
    for (const p of projectsCache) {
      const o = new Option(`${p.name}  (${p.kind})`, p.dir);
      sel.appendChild(o);
    }
    const pio = projectsCache.find((p) => p.kind === 'platformio');
    if (pio) { sel.value = pio.dir; await onProjectChange(); }
  } catch (e) { /* 忽略 */ }
}

async function onProjectChange() {
  const dir = $('#projectSel').value;
  const sel = $('#envSel');
  sel.innerHTML = '<option value="">env…</option>';
  if (!dir) return;
  try {
    const d = await api('/api/projects/describe?dir=' + encodeURIComponent(dir));
    for (const env of d.envs) sel.appendChild(new Option(env, env));
    if (d.envs.length) sel.value = d.envs[0];
  } catch (e) {
    toast(e.message, 'err');
  }
}

function selectProject(dir) {
  $('#projectSel').value = dir;
  onProjectChange();
}

async function loadPorts() {
  try {
    const data = await api('/api/ports');
    S.remoteInfo = data;
    for (const id of ['#portSel', '#serialPort']) {
      const sel = $(id);
      const keep = sel.value;
      sel.innerHTML = '<option value="">' + (id === '#portSel' ? '端口…' : '串口…') + '</option>';
      for (const p of data.ports) {
        const label = (p.remote ? '⛓ ' : '') + (p.label || p.device);
        sel.appendChild(new Option(label, p.device));
      }
      if (keep) sel.value = keep;
      if (data.ports.length && id === '#serialPort' && !sel.value) sel.value = data.ports[0].device;
    }
    const remoteAlive = (data.remote || []).filter((l) => l.alive).length;
    setMsg(data.ports.length
      ? `端口 ${data.ports.length} 个（本地 ${(data.local || []).length} · 远端 ${remoteAlive}）`
      : '没有可用端口');
  } catch (e) { /* ignore */ }
}

// ── 远端串口桥：把插在自己电脑上的板子接进来 ──
async function loadRemotes() {
  try {
    const data = await api('/api/remote');
    S.remoteLinks = data.links || [];
    return data;
  } catch {
    S.remoteLinks = [];
    return { links: [], backend: 'none' };
  }
}

function remoteDialog() {
  loadRemotes().then((data) => renderRemoteDialog(data));
}

function renderRemoteDialog(data) {
  const mask = document.createElement('div');
  mask.className = 'dialog-mask';
  const backend = data.backend === 'none'
    ? '<span class="tag no">缺少 socat / python3</span>'
    : `<span class="tag ok">${escapeHtml(data.backend)}</span>`;
  const rows = (data.links || []).map((l) => `
    <tr>
      <td class="mono">${escapeHtml(l.name)}</td>
      <td class="mono">${escapeHtml(l.host)}:${l.port}</td>
      <td><span class="tag ${l.alive ? 'ok' : 'no'}">${l.alive ? '在线' : '离线'}</span></td>
      <td class="mono" style="font-size:11px">${escapeHtml(l.path)}</td>
      <td><button class="ghost" data-del="${escapeHtml(l.name)}">断开</button></td>
    </tr>`).join('');
  mask.innerHTML = `<div class="dialog" style="width:min(720px,94vw)">
    <h3>远端串口桥</h3>
    <p class="hint" style="margin:0 0 10px">
      先在<strong>插着板子的那台机器</strong>上启动桥：<br>
      <span class="mono">node bridge/serial-bridge.js --device /dev/ttyUSB0 --port 9999</span><br>
      再填那台机器的 Tailscale 地址（同机可达时用 <span class="mono">127.0.0.1</span> + <span class="mono">ssh -R</span>）。映射后端：${backend}
    </p>
    <div class="row" style="display:grid;grid-template-columns:1.4fr .7fr 1fr;gap:8px">
      <input id="rmHost" type="text" placeholder="主机 / 100.x.y.z">
      <input id="rmPort" type="text" placeholder="端口 9999">
      <input id="rmName" type="text" placeholder="别名 laptop-board">
    </div>
    <div class="actions"><button class="ghost" data-x>关闭</button><button class="primary" data-add>接入</button></div>
    <div class="section-title">当前桥接</div>
    ${rows
      ? `<table class="device-table"><thead><tr><th>别名</th><th>目标</th><th>状态</th><th>本地 PTY</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">还没有远端桥接</div>'}
    <div class="hint" style="margin-top:10px">
      接入后它会出现在端口下拉里（带 ⛓ 标记），可以直接编译烧录，也能在“串口监控”里看输出。
    </div>
  </div>`;
  document.body.appendChild(mask);

  $('[data-x]', mask).onclick = () => mask.remove();
  $('[data-add]', mask).onclick = async () => {
    const host = $('#rmHost', mask).value.trim();
    const port = $('#rmPort', mask).value.trim();
    const name = $('#rmName', mask).value.trim();
    if (!host || !port) return toast('主机和端口都要填', 'err');
    try {
      const r = await api('/api/remote', { method: 'POST', body: { host, port: Number(port), name } });
      if (r.alive) {
        toast(`已接入 ${r.path}`, 'ok');
        mask.remove();
        await loadPorts();
        $('#serialPort').value = r.path;
        $('#portSel').value = r.path;
        showPanel('serial');
      } else {
        toast(`已创建，但对端未响应：${r.error || '检查 bridge 是否在跑 / --allow 是否放行'}`, 'err');
        mask.remove();
        await loadPorts();
      }
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-del]', mask).forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/remote/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
        toast('已断开', 'ok');
        mask.remove();
        await loadPorts();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ── Web Serial：浏览器直连本机 USB（Chrome / Edge）──
const WSER = { port: null, reader: null, writer: null, running: false, decoder: null };
let lineStartFlag = true;

function webSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

function refreshWebSerialButtons() {
  const ok = webSerialSupported();
  $('#btnWebSerial').classList.toggle('hidden', !ok);
  $('#btnWebFlash').classList.toggle('hidden', !ok);
  if (ok) $('#btnWebSerial').textContent = WSER.running ? '断开本机' : '本机 USB';
}

async function webSerialToggle() {
  if (WSER.running) return webSerialStop();
  if (!webSerialSupported()) {
    return toast('浏览器不支持 Web Serial：需要 Chrome/Edge，且页面为 https 或 localhost', 'err');
  }
  if (S.serialWs) disconnectSerial();
  try {
    const port = await navigator.serial.requestPort();
    const baud = Number($('#serialBaud').value) || 115200;
    await port.open({ baudRate: baud });
    WSER.port = port;
    WSER.running = true;
    WSER.decoder = new TextDecoder();
    lineStartFlag = true;
    refreshWebSerialButtons();
    setSerialState(`本机 USB ${baud}`, 'ok');
    appendSerial(`\n[本机 USB] 已连接 @ ${baud}\n`);
    webSerialReadLoop();
  } catch (e) {
    toast('打开本机串口失败: ' + e.message, 'err');
  }
}

async function webSerialReadLoop() {
  const port = WSER.port;
  while (port && port.readable && WSER.running) {
    let reader;
    try {
      reader = port.readable.getReader();
    } catch (e) {
      appendSerial(`\n[本机 USB] ${e.message}\n`);
      break;
    }
    WSER.reader = reader;
    try {
      while (WSER.running) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) {
          let text;
          if ($('#serialHex').checked) {
            text = [...value].map((b) => b.toString(16).padStart(2, '0')).join(' ') + ' ';
          } else {
            text = WSER.decoder.decode(value, { stream: true });
          }
          if ($('#serialTime').checked && lineStartFlag && text.trim()) text = `[${timeStr()}] ` + text;
          lineStartFlag = text.endsWith('\n');
          appendSerial(text);
        }
      }
    } catch (e) {
      if (WSER.running) appendSerial(`\n[本机 USB 读取中断] ${e.message}\n`);
    } finally {
      try { reader.releaseLock(); } catch {}
      WSER.reader = null;
    }
  }
}

async function webSerialPause(keepPort) {
  WSER.running = false;
  try { if (WSER.reader) await WSER.reader.cancel(); } catch {}
  WSER.reader = null;
  try { if (WSER.writer) { WSER.writer.releaseLock(); } } catch {}
  WSER.writer = null;
  try { if (WSER.port && WSER.port.readable === null && WSER.port.writable === null) { /* already closed */ } } catch {}
  try { if (WSER.port) await WSER.port.close(); } catch {}
  if (!keepPort) WSER.port = null;
}

async function webSerialStop() {
  const had = !!WSER.port;
  await webSerialPause(false);
  refreshWebSerialButtons();
  setSerialState('未连接');
  if (had) appendSerial('\n[本机 USB] 已断开\n');
}

async function webSerialWrite(text) {
  if (!WSER.port || !WSER.port.writable) return false;
  try {
    if (!WSER.writer) WSER.writer = WSER.port.writable.getWriter();
    await WSER.writer.write(new TextEncoder().encode(text));
    return true;
  } catch (e) {
    toast('写入本机串口失败: ' + e.message, 'err');
    return false;
  }
}

// esptool-js：浏览器里直接烧 ESP 系列
async function loadEsptoolLib() {
  if (S.esptool) return S.esptool;
  const urls = ['/vendor/esptool-bundle.js', 'https://cdn.jsdelivr.net/npm/esptool-js@0.4.5/bundle.js'];
  for (const url of urls) {
    try {
      const mod = await import(url);
      if (mod && mod.ESPLoader && mod.Transport) { S.esptool = mod; return mod; }
    } catch { /* 下一个 */ }
  }
  throw new Error('esptool-js 加载失败（Chrome 需要网络访问 CDN，或运行 scripts/vendor.sh）');
}

function webFlashDialog() {
  if (!webSerialSupported()) return toast('Web Serial 不可用（Chrome/Edge + https 或 localhost）', 'err');
  const mask = document.createElement('div');
  mask.className = 'dialog-mask';
  mask.innerHTML = `<div class="dialog" style="width:min(560px,94vw)">
    <h3>ESP 直烧（浏览器本地 USB）</h3>
    <p class="hint" style="margin:0 0 10px">
      走 esptool-js，直接把固件写进插在<strong>这台设备</strong>上的 ESP 芯片。烧录期间会暂停串口监控。
      其他芯片（STM32/AVR）请用“远端桥 + 服务端 PlatformIO”。
    </p>
    <div class="row"><label>固件文件（.bin）</label><input type="file" id="wfFile" accept=".bin,.img"></div>
    <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><label>写入地址</label><input id="wfAddr" type="text" value="0x0"></div>
      <div><label>波特率</label>
        <select id="wfBaud"><option>115200</option><option selected>460800</option><option>921600</option></select>
      </div>
    </div>
    <div class="actions"><button class="ghost" data-x>取消</button><button class="primary" data-go>开始烧录</button></div>
    <div class="hint" id="wfStatus" style="margin-top:8px;min-height:16px"></div>
  </div>`;
  document.body.appendChild(mask);
  const status = (t) => { $('#wfStatus', mask).textContent = t; };
  $('[data-x]', mask).onclick = () => mask.remove();
  $('[data-go]', mask).onclick = async () => {
    const file = $('#wfFile', mask).files[0];
    if (!file) return status('先选一个 .bin 文件');
    const address = $('#wfAddr', mask).value.trim() || '0x0';
    const baud = Number($('#wfBaud', mask).value) || 460800;
    const addrNum = Number(address);
    if (!Number.isFinite(addrNum) || addrNum < 0) return status('地址格式不对，例如 0x0 或 0x10000');

    // 拿本机串口：已连接就复用，否则现选一个
    let port = WSER.port;
    if (!port) {
      try {
        if (S.serialWs) disconnectSerial();
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: baud });
        WSER.port = port;
      } catch (e) {
        return status('打开串口失败: ' + e.message);
      }
    } else {
      await webSerialPause(true);
    }
    refreshWebSerialButtons();
    setSerialState('烧录中', 'ok');
    status('加载 esptool-js…');
    let mod;
    try {
      mod = await loadEsptoolLib();
    } catch (e) {
      status(e.message);
      return;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const terminal = {
      clean() {},
      writeLine(l) { appendSerial(String(l) + '\n'); },
      write(t) { appendSerial(String(t)); },
    };
    let transport;
    try {
      status('连接芯片…');
      transport = new mod.Transport(port, false);
      const loader = new mod.ESPLoader({ transport, baudrate: baud, terminal });
      const chip = typeof loader.main === 'function' ? await loader.main() : await loader.connect();
      status(`芯片: ${chip || '已连接'}，写入 ${file.name} → ${address}`);
      await loader.writeFlash({
        fileArray: [{ data, address: addrNum }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (idx, written, total) => {
          status(`${Math.round((written / total) * 100)}%  (${written}/${total})`);
        },
        calculateMD5sum: false,
      });
      status('✅ 烧录完成，记得复位');
      setMsg(`ESP 烧录完成 ${file.name}`, 'ok');
    } catch (e) {
      status('❌ ' + (e.message || String(e)));
      setMsg('ESP 烧录失败', 'err');
    } finally {
      try { if (transport) await transport.disconnect(); } catch {}
      WSER.port = null;
      refreshWebSerialButtons();
      setSerialState('未连接');
    }
  };
}


// ── 任务 ─────────────────────────────────────
function showPanel(name) {
  $$('.ptab').forEach((t) => t.classList.toggle('active', t.dataset.panel === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

function appendOutput(text, cls) {
  const out = $('#output');
  if (cls) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    out.appendChild(span);
  } else {
    out.appendChild(document.createTextNode(text));
  }
  out.scrollTop = out.scrollHeight;
}

async function startJob(kind) {
  if (S.currentJobId) {
    toast('已有任务在运行，请先停止', 'err');
    return;
  }
  const project = $('#projectSel').value;
  if (!project && kind !== 'custom') {
    toast('请先在顶部选择工程', 'err');
    return;
  }
  const adv = advancedSpec();
  const body = {
    kind,
    project,
    env: $('#envSel').value,
    port: $('#portSel').value,
    backend: adv.backend || 'auto',
    file: adv.file,
    address: adv.address,
    baud: adv.baud ? Number(adv.baud) : undefined,
    cfgFile: adv.cfgFile,
  };
  showPanel('output');
  $('#output').textContent = '';
  $('#outputTitle').textContent = `启动 ${kind}…`;
  try {
    const job = await api('/api/jobs', { method: 'POST', body });
    subscribeJob(job.id, kind);
  } catch (e) {
    appendOutput(`[错误] ${e.message}\n`, 'stderr');
    setMsg(e.message, 'err');
  }
}

function subscribeJob(id, kind) {
  S.currentJobId = id;
  $('#btnCancelJob').disabled = false;
  $('#outputTitle').textContent = `${kind} · ${id}`;
  setMsg(`${kind} 运行中…`);
  const es = new EventSource(`/api/jobs/${id}/stream`);
  S.sse = es;
  let sawEnd = false;
  es.addEventListener('log', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      const cls = m.stream === 'err' ? 'stderr' : m.stream === 'sys' ? 'sys' : '';
      appendOutput(String(m.text ?? ''), cls);
    } catch {
      appendOutput(ev.data);
    }
  });
  es.addEventListener('end', (ev) => {
    sawEnd = true;
    try {
      const j = JSON.parse(ev.data);
      const ok = j.code === 0;
      appendOutput(`\n[任务结束] 状态=${j.status} code=${j.code}\n`, ok ? '' : 'stderr');
      setMsg(ok ? `${kind} 成功` : `${kind} 失败 (code=${j.code})`, ok ? 'ok' : 'err');
      toast(ok ? `${kind} 成功` : `${kind} 失败`, ok ? 'ok' : 'err');
    } catch (err) {
      appendOutput(`\n[结束] ${ev.data}\n`);
    }
    cleanupJob();
  });
  es.onerror = () => {
    if (!sawEnd) {
      appendOutput('\n[流中断]\n', 'sys');
      cleanupJob();
    }
  };
}

function cleanupJob() {
  if (S.sse) { S.sse.close(); S.sse = null; }
  S.currentJobId = null;
  $('#btnCancelJob').disabled = true;
  loadJobs();
}

async function cancelJob() {
  if (!S.currentJobId) return;
  try {
    await api(`/api/jobs/${S.currentJobId}/cancel`, { method: 'POST' });
    appendOutput('\n[已请求停止]\n', 'sys');
    setMsg('已停止');
  } catch (e) { toast(e.message, 'err'); }
}

async function loadJobs() {
  try {
    const data = await api('/api/jobs');
    const body = $('#jobsBody');
    if (!data.jobs.length) { body.innerHTML = '<div class="empty">暂无任务</div>'; return; }
    const rows = data.jobs.map((j) => `
      <tr>
        <td class="mono">${j.id}</td>
        <td>${j.kind}</td>
        <td><span class="tag ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'no' : ''}">${j.status}</span></td>
        <td class="mono">${j.code ?? '—'}</td>
        <td class="mono">${escapeHtml(j.meta?.project || '')} ${escapeHtml(j.meta?.env || '')}</td>
        <td class="mono">${j.startedAt ? new Date(j.startedAt).toLocaleTimeString() : ''}</td>
        <td><button class="ghost" data-job="${j.id}">日志</button></td>
      </tr>`).join('');
    body.innerHTML = `<table class="device-table">
      <thead><tr><th>ID</th><th>类型</th><th>状态</th><th>code</th><th>工程</th><th>开始</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    $$('[data-job]', body).forEach((b) => {
      b.onclick = async () => {
        const j = await api('/api/jobs/' + b.dataset.job);
        showPanel('output');
        $('#output').textContent = j.log;
        $('#outputTitle').textContent = `${j.kind} · ${j.id} · ${j.status}`;
      };
    });
  } catch (e) { /* ignore */ }
}

// 高级烧录参数（从对话框读取，保存在 S.adv）
function advancedSpec() {
  return S.adv || { backend: 'auto' };
}

function openAdvanced() {
  const a = S.adv || {};
  const mask = document.createElement('div');
  mask.className = 'dialog-mask';
  mask.innerHTML = `<div class="dialog">
    <h3>高级烧录</h3>
    <div class="row"><label>烧录后端</label><select id="advBackend">
      <option value="auto">auto（按工程类型决定）</option>
      <option value="platformio">platformio</option>
      <option value="esptool">esptool</option>
      <option value="avrdude">avrdude</option>
      <option value="stflash">st-flash</option>
      <option value="dfu">dfu-util</option>
      <option value="openocd">openocd</option>
      <option value="arduino">arduino-cli</option>
      <option value="picotool">picotool</option>
      <option value="make">make</option>
    </select></div>
    <div class="row"><label>固件文件（相对工作区，直烧后端需要）</label><input id="advFile" type="text" placeholder="如 fw/firmware.bin"></div>
    <div class="row"><label>写入地址</label><input id="advAddr" type="text" placeholder="0x0 / 0x08000000"></div>
    <div class="row"><label>波特率（串口烧录）</label><input id="advBaud" type="text" placeholder="460800"></div>
    <div class="row"><label>OpenOCD 配置</label><input id="advCfg" type="text" placeholder="board/stm32f4discovery.cfg"></div>
    <div class="actions"><button class="ghost" data-x>取消</button><button class="primary" data-ok>保存</button></div>
  </div>`;
  document.body.appendChild(mask);
  $('#advBackend', mask).value = a.backend || 'auto';
  $('#advFile', mask).value = a.file || '';
  $('#advAddr', mask).value = a.address || '';
  $('#advBaud', mask).value = a.baud || '';
  $('#advCfg', mask).value = a.cfgFile || '';
  $('[data-x]', mask).onclick = () => mask.remove();
  $('[data-ok]', mask).onclick = () => {
    S.adv = {
      backend: $('#advBackend', mask).value,
      file: $('#advFile', mask).value.trim(),
      address: $('#advAddr', mask).value.trim(),
      baud: $('#advBaud', mask).value.trim(),
      cfgFile: $('#advCfg', mask).value.trim(),
    };
    mask.remove();
    toast('高级参数已保存', 'ok');
  };
}

// ── 串口 ─────────────────────────────────────
let serialDecoder = null;
let serialRawMode = false;

function setSerialState(text, cls = '') {
  const el = $('#serialState');
  el.textContent = text;
  el.className = 'tag ' + cls;
}

function connectSerial() {
  if (S.serialWs) { disconnectSerial(); return; }
  const port = $('#serialPort').value;
  const baud = $('#serialBaud').value;
  if (!port) { toast('请选择串口', 'err'); return; }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/serial?port=${encodeURIComponent(port)}&baud=${baud}`);
  ws.binaryType = 'arraybuffer';
  serialDecoder = new TextDecoder('utf-8', { fatal: false });
  S.serialWs = ws;
  let first = true;
  const t0 = Date.now();
  let lineStart = true;

  ws.onopen = () => {
    setSerialState(`已连接 ${port} @ ${baud}`, 'ok');
    $('#serialConnect').textContent = '断开';
    $('#serialConnect').classList.remove('primary');
    // 让顶栏的烧录端口跟随串口面板选择
    if ([...$('#portSel').options].some((o) => o.value === port)) $('#portSel').value = port;
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'ready') return;
        if (m.type === 'error') { appendSerial(`\n[错误] ${m.message}\n`); setSerialState('错误', 'no'); return; }
        if (m.type === 'closed') { appendSerial(`\n[已关闭] ${m.reason}\n`); disconnectSerial(); return; }
      } catch {}
      return;
    }
    const buf = new Uint8Array(ev.data);
    let text;
    if ($('#serialHex').checked) {
      text = [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ') + ' ';
    } else {
      text = serialDecoder.decode(buf, { stream: true });
    }
    if ($('#serialTime').checked && lineStart && text.trim()) {
      text = `[${timeStr()}] ` + text;
      lineStart = false;
    }
    if (text.endsWith('\n')) lineStart = true;
    appendSerial(text);
  };
  ws.onclose = () => {
    setSerialState('未连接');
    $('#serialConnect').textContent = '连接';
    $('#serialConnect').classList.add('primary');
    S.serialWs = null;
  };
  ws.onerror = () => { appendSerial('\n[连接错误]\n'); };
}

function disconnectSerial() {
  if (S.serialWs) {
    try { S.serialWs.close(); } catch {}
    S.serialWs = null;
  }
  setSerialState('未连接');
  $('#serialConnect').textContent = '连接';
  $('#serialConnect').classList.add('primary');
}

function appendSerial(text) {
  const out = $('#serialOut');
  out.appendChild(document.createTextNode(text));
  const max = 400000;
  if (out.textContent.length > max) {
    out.textContent = out.textContent.slice(-max / 2);
    out.appendChild(document.createTextNode('\n[输出过长，已截断]\n'));
  }
  out.scrollTop = out.scrollHeight;
}

function sendSerial() {
  const input = $('#serialSendInput');
  const text = input.value;
  if (!text) return;
  const payload = text + ($('#serialCRLF').checked ? '\r\n' : '');
  if (WSER.running) {
    webSerialWrite(payload).then((ok) => { if (ok) input.value = ''; });
    return;
  }
  if (!S.serialWs) { toast('串口未连接（远端桥请先在端口下拉里选中它）', 'err'); return; }
  S.serialWs.send(JSON.stringify({ type: 'write', data: payload }));
  input.value = '';
}

// ── 终端 ─────────────────────────────────────
async function initTerminalIfNeeded(connect) {
  if (S.term) { if (connect) connectTerm(); return; }
  const ok = await loadFirst(
    ['/vendor/xterm.js', 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js'],
    () => !!window.Terminal
  );
  if (!ok) {
    $('#termHost').innerHTML = '<div class="empty">终端组件加载失败（需要 xterm.js）。可运行 scripts/vendor.sh 获取本地副本。</div>';
    return;
  }
  await loadFirstCss(
    ['/vendor/xterm.css', 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css'],
    'xterm-css'
  );
  await loadFirst(
    ['/vendor/xterm-addon-fit.js', 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js'],
    () => !!window.FitAddon
  );
  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    cursorBlink: true,
    scrollback: 8000,
    theme: {
      background: '#0d0f12', foreground: '#c9d1d9', cursor: '#ff7a3d',
      selectionBackground: '#334155', black: '#1b1f24', red: '#ff7b72', green: '#3ecf8e',
      yellow: '#e0b64f', blue: '#4aa8ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#dfe4ea',
    },
  });
  const fit = window.FitAddon ? new FitAddon.FitAddon() : null;
  if (fit) term.loadAddon(fit);
  term.open($('#termHost'));
  S.term = term;
  S.termFit = fit;
  if (connect) connectTerm();
}

function connectTerm() {
  if (S.termWs || !S.term) return;
  if (S.termFit) { try { S.termFit.fit(); } catch {} }
  const cols = S.term.cols || 160;
  const rows = S.term.rows || 40;
  const cwd = $('#projectSel').value || '';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/shell?cols=${cols}&rows=${rows}&cwd=${encodeURIComponent(cwd)}`);
  S.termWs = ws;
  ws.onopen = () => {
    S.term.write('\r\n\x1b[38;5;209m* ForgeDeck 终端已连接\x1b[0m\r\n');
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const m = JSON.parse(ev.data);
      if (m.type === 'data') S.term.write(m.data);
      else if (m.type === 'exit') { S.term.write(`\r\n\x1b[38;5;245m* ${m.reason}\x1b[0m\r\n`); }
      else if (m.type === 'ready') { if (m.cwd) S.termCwd = m.cwd; }
      return;
    } catch { S.term.write(ev.data); }
  };
  ws.onclose = () => {
    S.termWs = null;
    S.term.write('\r\n\x1b[38;5;245m* 终端已断开，点击面板重连\x1b[0m\r\n');
  };
  S.term.onData((d) => { if (S.termWs) S.termWs.send(JSON.stringify({ type: 'input', data: d })); });
  S.term.onResize(({ cols: c, rows: r }) => {
    if (S.termWs) S.termWs.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
  });
}

// ── 设备面板 ─────────────────────────────────
async function loadDevices() {
  const body = $('#devBody');
  body.innerHTML = '<div class="empty">检测中…</div>';
  try {
    const d = await api('/api/devices');
    const remData = await loadRemotes();
    $('#devHint').textContent = d.hint || '';
    let html = `<div class="section-title">串口 (${d.serialPorts.length})</div>`;
    if (d.serialPorts.length) {
      html += `<table class="device-table"><thead><tr><th>设备</th><th>名称</th><th>USB</th><th>芯片提示</th><th>操作</th></tr></thead><tbody>`;
      for (const p of d.serialPorts) {
        html += `<tr><td class="mono">${escapeHtml(p.device)}</td><td>${escapeHtml(p.label)}</td>
          <td class="mono">${escapeHtml(p.usbId || '—')}</td><td>${escapeHtml((p.chips || []).join(', ') || '—')}</td>
          <td><button class="ghost" data-mon="${escapeHtml(p.device)}">监控</button></td></tr>`;
      }
      html += '</tbody></table>';
    } else html += '<div class="empty">未发现串口设备</div>';

    html += `<div class="section-title">USB (${(d.usb || []).length})</div>`;
    if ((d.usb || []).length) {
      html += `<table class="device-table"><thead><tr><th>ID</th><th>描述</th><th>类型</th><th>工具</th></tr></thead><tbody>`;
      for (const u of d.usb) {
        html += `<tr><td class="mono">${escapeHtml(u.id)}</td><td>${escapeHtml(u.known || u.desc)}</td>
          <td><span class="tag ${u.kind === 'other' ? '' : 'ok'}">${escapeHtml(u.kind)}</span></td>
          <td class="mono">${escapeHtml(u.tool || '—')}</td></tr>`;
      }
      html += '</tbody></table>';
    }
    const links = remData.links || [];
    html += `<div class="section-title">远端桥接 (${links.length})${remData.backend && remData.backend !== 'none' ? ` · 映射后端 ${escapeHtml(remData.backend)}` : ' · 缺 socat/python3'}</div>`;
    if (links.length) {
      html += `<table class="device-table"><thead><tr><th>别名</th><th>对端</th><th>状态</th><th>本地 PTY</th><th>操作</th></tr></thead><tbody>`;
      for (const l of links) {
        html += `<tr><td class="mono">${escapeHtml(l.name)}</td>
          <td class="mono">${escapeHtml(l.host)}:${l.port}</td>
          <td><span class="tag ${l.alive ? 'ok' : 'no'}">${l.alive ? '在线' : '离线'}</span></td>
          <td class="mono" style="font-size:11px">${escapeHtml(l.path)}</td>
          <td><button class="ghost" data-rmon="${escapeHtml(l.path)}">监控</button>
              <button class="ghost" data-rdel="${escapeHtml(l.name)}">断开</button></td></tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += `<div class="hint">把板子插在自己电脑上，跑 <span class="mono">node bridge/serial-bridge.js --device /dev/ttyUSB0 --port 9999</span>，然后点“⛓ 远端桥接”填入那台机器的 Tailscale 地址。</div>`;
    }
    if ((d.errors || []).length) html += `<div class="section-title">警告</div><div class="hint">${escapeHtml(d.errors.join('；'))}</div>`;
    body.innerHTML = html;
    $$('[data-mon]', body).forEach((b) => {
      b.onclick = () => {
        showPanel('serial');
        $('#serialPort').value = b.dataset.mon;
        connectSerial();
      };
    });
    $$('[data-rmon]', body).forEach((b) => {
      b.onclick = () => {
        showPanel('serial');
        $('#serialPort').value = b.dataset.rmon;
        connectSerial();
      };
    });
    $$('[data-rdel]', body).forEach((b) => {
      b.onclick = async () => {
        try { await api('/api/remote/' + encodeURIComponent(b.dataset.rdel), { method: 'DELETE' }); toast('已断开', 'ok'); loadDevices(); loadPorts(); }
        catch (e) { toast(e.message, 'err'); }
      };
    });
  } catch (e) {
    body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

// ── Tailnet ──────────────────────────────────
async function loadTailnetMini() {
  try {
    const t = await api('/api/tailnet');
    $('#tailText').textContent = t.running ? (t.self.dns || '已连接') : '未运行';
    $('#tailPill .dot').style.background = t.running ? 'var(--green)' : 'var(--text3)';
    renderTail(t);
  } catch { $('#tailText').textContent = '不可用'; }
}

let tailCache = null;

function renderTail(t) {
  tailCache = t;
  const body = $('#tailBody');
  if (!body) return;
  let html = '';
  if (!t.installed) {
    html = `<div class="empty">未检测到 tailscale CLI。<br>安装后执行：<div class="cmd">curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up</div></div>`;
    body.innerHTML = html;
    return;
  }
  if (!t.running) {
    html = `<div class="empty">tailscale 已安装但未运行：<div class="cmd">sudo tailscale up --ssh</div>${escapeHtml(t.error || '')}</div>`;
    body.innerHTML = html;
    return;
  }
  html += `<div class="kv">
    <span class="k">本机节点</span><span class="v">${escapeHtml(t.self.host)}</span>
    <span class="k">MagicDNS</span><span class="v">${escapeHtml(t.self.dns || '—')}</span>
    <span class="k">Tailnet IP</span><span class="v">${escapeHtml((t.self.ips || []).join('  '))}</span>
    <span class="k">Tailnet</span><span class="v">${escapeHtml(t.tailnetName || '—')}</span>
    <span class="k">在线设备</span><span class="v">${t.peersOnline} / ${t.peersTotal}</span>
  </div>`;

  html += `<div class="section-title">对外访问命令</div>`;
  html += `<div class="cmd">${escapeHtml((t.tips.commands || []).join('\n'))}<button class="copy ghost" data-copycmd>复制</button></div>`;
  html += `<div class="hint">推荐：<span class="mono">tailscale serve --bg http://127.0.0.1:${S.cfg?.port || 8083}</span>，
    之后从任意设备用 <span class="mono">https://${escapeHtml(t.self.dns || 'machine.tailnet.ts.net')}</span> 打开本控制台。TLS 由 Tailscale 自动签发。</div>`;

  if (t.peers && t.peers.length) {
    html += `<div class="section-title">可见设备 (${t.peers.length})</div><table class="device-table">
      <thead><tr><th>主机</th><th>DNS</th><th>IP</th><th>OS</th><th>状态</th></tr></thead><tbody>`;
    for (const p of t.peers) {
      html += `<tr><td>${escapeHtml(p.host)}</td><td class="mono">${escapeHtml(p.dns)}</td>
        <td class="mono">${escapeHtml(p.ip || '—')}</td><td>${escapeHtml(p.os || '')}</td>
        <td><span class="tag ${p.online ? 'ok' : ''}">${p.online ? '在线' : '离线'}</span></td></tr>`;
    }
    html += '</tbody></table>';
  }
  body.innerHTML = html;
  $$('[data-copycmd]', body).forEach((b) => {
    b.onclick = () => {
      navigator.clipboard.writeText((tailCache?.tips?.commands || []).join('\n'))
        .then(() => toast('已复制', 'ok'))
        .catch(() => toast('复制失败，请手动选择', 'err'));
    };
  });
}

// ── 面板 / 尺寸 ───────────────────────────────
function initPanels() {
  $$('.ptab').forEach((t) => {
    t.onclick = () => {
      showPanel(t.dataset.panel);
      if (t.dataset.panel === 'terminal') {
        initTerminalIfNeeded(true);
        setTimeout(() => { if (S.termFit) { try { S.termFit.fit(); } catch {} } }, 60);
      }
      if (t.dataset.panel === 'devices') loadDevices();
      if (t.dataset.panel === 'tailnet') loadTailnetMini();
      if (t.dataset.panel === 'jobs') loadJobs();
    };
  });

  const resizer = $('#resizer');
  let dragging = false;
  resizer.onmousedown = () => { dragging = true; document.body.style.userSelect = 'none'; };
  window.onmousemove = (e) => {
    if (!dragging) return;
    const h = window.innerHeight - e.clientY;
    S.bottomH = Math.max(90, Math.min(window.innerHeight - 160, h));
    $('#bottom').style.height = S.bottomH + 'px';
    if (S.editor) S.editor.refresh();
  };
  window.onmouseup = () => { dragging = false; document.body.style.userSelect = ''; };
}

// ── 事件绑定 ─────────────────────────────────
function initEvents() {
  $('#loginBtn').onclick = doLogin;
  $('#tokenInput').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  $('#btnLogout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    S.user = null;
    showLogin('已退出，请输入令牌');
  };

  $('#btnBuild').onclick = () => startJob('build');
  $('#btnFlash').onclick = () => startJob('flash');
  $('#btnErase').onclick = () => {
    if (!confirm('擦除目标芯片上的全部固件？')) return;
    startJob('erase');
  };
  $('#btnPorts').onclick = loadPorts;
  $('#btnDevices').onclick = () => { showPanel('devices'); loadDevices(); };
  $('#btnAdvanced').onclick = openAdvanced;
  $('#btnCancelJob').onclick = cancelJob;
  $('#btnClearPanel').onclick = () => {
    const active = $$('.ptab.active')[0]?.dataset.panel;
    if (active === 'output') $('#output').textContent = '';
    if (active === 'serial') $('#serialOut').textContent = '';
    if (active === 'terminal' && S.term) S.term.clear();
  };

  $$('[data-act]').forEach((b) => {
    b.onclick = () => ({
      refresh: refreshTreeAll,
      newfile: newFile,
      newdir: newDir,
      upload: uploadFiles,
      root: () => { S.expanded.clear(); loadTree(''); },
    }[b.dataset.act] || (() => {}))();
  });

  $('#projectSel').onchange = onProjectChange;
  $('#filePicker').onchange = onPickedFiles;

  $('#searchInput').onkeydown = (e) => {
    if (e.key === 'Enter') runSearch();
    if (e.key === 'Escape') exitSearch();
  };

  $('#serialConnect').onclick = connectSerial;
  $('#btnRemote').onclick = remoteDialog;
  $('#btnBridge').onclick = remoteDialog;
  $('#devRemote').onclick = remoteDialog;
  $('#btnWebSerial').onclick = webSerialToggle;
  $('#btnWebFlash').onclick = webFlashDialog;
  $('#serialSend').onclick = sendSerial;
  $('#serialSendInput').onkeydown = (e) => { if (e.key === 'Enter') sendSerial(); };
  $('#serialClear').onclick = () => { $('#serialOut').textContent = ''; };
  $('#serialReset').onclick = () => {
    if (S.serialWs) S.serialWs.send(JSON.stringify({ type: 'reset' }));
    toast('已发送复位请求');
  };
  $('#serialHex').onchange = () => toast($('#serialHex').checked ? 'HEX 显示已开启' : '文本显示已开启');
  $('#devRefresh').onclick = loadDevices;

  $('#termHost').onclick = () => initTerminalIfNeeded(true);

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
    else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); startJob('build'); }
    else if (mod && e.key === 'Enter') { e.preventDefault(); startJob('flash'); }
    else if (mod && e.key === '`') { e.preventDefault(); showPanel('terminal'); initTerminalIfNeeded(true); setTimeout(() => S.termFit && S.termFit.fit(), 60); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#searchInput').focus(); }
  });

  window.addEventListener('resize', () => {
    if (S.termFit) { try { S.termFit.fit(); } catch {} }
  });
}

// ── 入口 ─────────────────────────────────────
(async function main() {
  initPanels();
  initEvents();
  try {
    const me = await api('/api/me');
    S.user = me.user;
    $('#whoPill').textContent = `${me.user.name || me.user.login}${me.via === 'tailscale' ? ' · ts' : ''}`;
    await boot();
  } catch (e) {
    if (String(e.message) === 'unauthorized') {
      showLogin();
    } else {
      showLogin('无法连接后端：' + e.message);
    }
  }
})();
