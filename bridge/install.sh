#!/usr/bin/env bash
# 在当前这台机器上把 ForgeDeck Bridge 装成 systemd 用户服务
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVICE=""
PORT=9999
BAUD=115200
NODE_BIN="$(command -v node || true)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/forge-deck-bridge.service"

usage() {
  echo "用法: install.sh --device /dev/ttyUSB0 [--port 9999] [--baud 115200]"
  echo "       install.sh --uninstall"
}

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now forge-deck-bridge.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "已卸载 forge-deck-bridge.service"
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--device) DEVICE="${2:-}"; shift 2;;
    -p|--port)   PORT="${2:-}";   shift 2;;
    -b|--baud)   BAUD="${2:-}";   shift 2;;
    -h|--help)   usage; exit 0;;
    *) echo "未知参数: $1"; usage; exit 2;;
  esac
done

if [[ -z "$NODE_BIN" ]]; then echo "找不到 node，请先安装 Node ≥ 18"; exit 1; fi
if [[ -z "$DEVICE" ]]; then
  echo "请指定设备，例如: install.sh --device /dev/ttyUSB0"
  echo "可用设备："
  "$NODE_BIN" "$HERE/serial-bridge.js" --list || true
  exit 2
fi
if [[ ! -e "$DEVICE" ]]; then echo "设备不存在: $DEVICE"; exit 1; fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=ForgeDeck Bridge ($DEVICE → tcp:$PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $HERE/serial-bridge.js --device $DEVICE --port $PORT --baud $BAUD
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now forge-deck-bridge.service
sleep 1
systemctl --user --no-pager status forge-deck-bridge.service | head -12

echo
echo "服务已启动。日志: journalctl --user -u forge-deck-bridge -f"
echo "在 ForgeDeck 里接入: 主机=$(hostname) / tailscale ip，端口=$PORT"
