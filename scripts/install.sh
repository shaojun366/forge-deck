#!/usr/bin/env bash
# ForgeDeck 一键安装：生成配置、可选注册 systemd 用户服务、打印 Tailscale 接入指引
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  %s\033[0m\n' "$*"; }

bold "ForgeDeck 安装"
echo

# 1. Node 版本
if ! command -v node >/dev/null; then
  warn "未找到 node，请先安装 Node.js >= 18：https://nodejs.org"
  exit 1
fi
NODE_V=$(node -v | sed 's/v//')
NODE_MAJOR=${NODE_V%%.*}
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  warn "Node $NODE_V 版本过低，需要 >= 18"
  exit 1
fi
ok "Node $NODE_V"

# 2. 配置文件
if [[ -f config.json ]]; then
  info "config.json 已存在，跳过生成"
else
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cp config.example.json config.json
  node - "$TOKEN" <<'NODE'
const fs = require('fs');
const token = process.argv[2];
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
cfg.token = token;
fs.writeFileSync('config.json', JSON.stringify(cfg, null, 2) + '\n');
NODE
  ok "已生成 config.json（含随机令牌）"
  echo
  bold "访问令牌（请保存）"
  echo "  $TOKEN"
  echo
fi

# 3. 工作区
WS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).workspace || './workspace')")
mkdir -p "$WS"
if [ -z "$(ls -A "$WS" 2>/dev/null | grep -v '.gitkeep')" ] && [ -d examples ]; then
  cp -r examples/blinky "$WS/" 2>/dev/null || true
  info "已把示例工程 examples/blinky 复制到工作区（可随时删除）"
fi
ok "工作区: $(cd "$WS" && pwd)"

# 4. 前端依赖（可选离线缓存）
if [[ ! -d web/vendor ]]; then
  read -r -p "是否下载前端依赖到 web/vendor（离线可用，约 800KB）？[Y/n] " ans
  if [[ "${ans:-Y}" =~ ^(Y|y|)$ ]]; then
    bash scripts/vendor.sh >/dev/null && ok "已缓存前端依赖"
  fi
fi

# 5. 工具检查
bold "工具检查"
for t in pio esptool.py avrdude st-flash dfu-util openocd arduino-cli picotool; do
  if command -v "$t" >/dev/null; then ok "$t → $(command -v "$t")"; else info "$t 未安装"; fi
done

# 6. 串口权限
if id -nG | grep -qE 'dialout|uucp'; then
  ok "当前用户在 dialout/uucp 组"
else
  warn "加入串口组: sudo usermod -aG dialout \$USER  （然后重新登录）"
fi

# 7. systemd 用户服务
if command -v systemctl >/dev/null; then
  read -r -p "注册 systemd 用户服务（开机自启）？[Y/n] " ans
  if [[ "${ans:-Y}" =~ ^(Y|y|)$ ]]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    sed "s|__ROOT__|$ROOT|g; s|__NODE__|$(command -v node)|g" scripts/forge-deck.service.tpl > "$UNIT_DIR/forge-deck.service"
    systemctl --user daemon-reload
    systemctl --user enable --now forge-deck.service
    ok "已启动 forge-deck.service"
    info "查看日志: journalctl --user -u forge-deck -f"
    info "开启 linger（不登录也运行）: sudo loginctl enable-linger $USER"
  fi
fi

# 8. Tailscale 指引
bold "Tailscale 接入"
if command -v tailscale >/dev/null; then
  DNS=$(tailscale status --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.Self&&j.Self.DNSName||'').replace(/\.$/,''))}catch{console.log('')}})" )
  PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).port||8083)")
  echo
  info "在本机执行："
  echo
  echo "    tailscale serve --bg http://127.0.0.1:$PORT"
  echo
  if [[ -n "$DNS" ]]; then
    ok "之后任意设备访问: https://$DNS"
  fi
  echo
  info "仅想局域网使用？改 config.json 的 host 为 0.0.0.0，并用 token 保护。"
else
  warn "未安装 tailscale：curl -fsSL https://tailscale.com/install.sh | sh"
fi

echo
bold "启动"
info "前台运行: node server/main.js"
info "或: systemctl --user start forge-deck"
echo
