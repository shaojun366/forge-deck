#!/usr/bin/env bash
# ForgeDeck — 把前端依赖（CodeMirror 5 / xterm.js）缓存到 web/vendor，实现离线可用
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/web/vendor"
mkdir -p "$VENDOR"

fetch() {
  local url="$1" out="$2"
  if [[ -s "$VENDOR/$out" ]]; then
    echo "  已存在 $out"
    return 0
  fi
  echo "  下载 $out"
  if command -v curl >/dev/null; then
    curl -fsSL "$url" -o "$VENDOR/$out"
  else
    wget -q "$url" -O "$VENDOR/$out"
  fi
}

CM_BASE="https://cdn.jsdelivr.net/npm/codemirror@5.65.16"
XT_BASE="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0"
XT_FIT="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0"

echo "→ CodeMirror 5"
fetch "$CM_BASE/lib/codemirror.min.js" codemirror.js
fetch "$CM_BASE/lib/codemirror.min.css" codemirror.css
fetch "$CM_BASE/mode/clike/clike.min.js" cm-clike.js
fetch "$CM_BASE/mode/python/python.min.js" cm-python.js
fetch "$CM_BASE/mode/javascript/javascript.min.js" cm-javascript.js
fetch "$CM_BASE/mode/markdown/markdown.min.js" cm-markdown.js
fetch "$CM_BASE/mode/yaml/yaml.min.js" cm-yaml.js
fetch "$CM_BASE/mode/properties/properties.min.js" cm-properties.js
fetch "$CM_BASE/mode/shell/shell.min.js" cm-shell.js
fetch "$CM_BASE/mode/xml/xml.min.js" cm-xml.js
fetch "$CM_BASE/mode/css/css.min.js" cm-css.js
fetch "$CM_BASE/addon/edit/matchbrackets.js" cm-matchbrackets.js

echo "→ esptool-js（Web Serial 直烧，可选）"
fetch "https://cdn.jsdelivr.net/npm/esptool-js@0.4.5/bundle.js" esptool-bundle.js

echo "→ xterm.js"
fetch "$XT_BASE/lib/xterm.js" xterm.js
fetch "$XT_BASE/css/xterm.css" xterm.css
fetch "$XT_FIT/lib/addon-fit.js" xterm-addon-fit.js

# 把分散的 CodeMirror 模式合并成一个可一次加载的文件
cat > "$VENDOR/cm-modes.js" <<'EOF'
/* ForgeDeck — 合并后的 CodeMirror 模式加载器（由 scripts/vendor.sh 生成） */
EOF
for f in cm-clike cm-python cm-javascript cm-markdown cm-yaml cm-properties cm-shell cm-xml cm-css cm-matchbrackets; do
  if [[ -f "$VENDOR/$f.js" ]]; then
    printf '\n/* ---- %s ---- */\n' "$f" >> "$VENDOR/cm-modes.js"
    cat "$VENDOR/$f.js" >> "$VENDOR/cm-modes.js"
    printf '\n' >> "$VENDOR/cm-modes.js"
  fi
done

echo "完成：$VENDOR"
ls -la "$VENDOR"
