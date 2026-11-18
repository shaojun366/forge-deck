[Unit]
Description=ForgeDeck — remote firmware workbench
Documentation=https://github.com/YOUR_GITHUB/forge-deck
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=__ROOT__
ExecStart=__NODE__ __ROOT__/server/main.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
# 串口设备访问需要这些组（按发行版取其一）
SupplementaryGroups=dialout uucp plugdev
# 如需固定令牌而不改 config.json：
# Environment=FORGEDECK_TOKEN=change-me

[Install]
WantedBy=default.target
