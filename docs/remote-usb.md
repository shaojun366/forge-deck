# 把"你手边的板子"接进远端工作台

ForgeDeck 的代码、编译、工具链可以在远端服务器上，但**板子通常插在你自己的电脑上**。这个文档讲三种把它接进来的方式。

```
┌─────────────┐   USB   ┌──────────────┐   Tailscale / SSH   ┌──────────────┐
│ ESP32/STM32 │ ──────▶ │ 你的电脑      │ ──────────────────▶ │ 服务器        │
│             │         │ serial-bridge │                     │ PlatformIO   │
└─────────────┘         └──────────────┘                     └──────────────┘
                                                                    ▲
                                                          浏览器 / ForgeDeck
```

## 方式 A：bridge + Tailscale（推荐）

一步到位，不需要装东西到服务器，也不依赖 SSH。

**在你自己的电脑上**（Linux / macOS，装 Node ≥ 18）：

```bash
# 1. 找到板子
node bridge/serial-bridge.js --list
#   可用串口：
#     /dev/ttyUSB0              CP2102 USB to UART Bridge
#     /dev/ttyACM0              ESP32-S3

# 2. 起桥（默认只允许 100.64.0.0/10 和本机访问）
node bridge/serial-bridge.js --device /dev/ttyUSB0 --port 9999

# macOS
node bridge/serial-bridge.js --device /dev/tty.usbserial-1420 --port 9999
```

**在 ForgeDeck 界面里**：

1. 顶栏点 `⛓ 桥接`
2. 主机填 `tailscale status` 里那台电脑的 `100.x.y.z` 或 MagicDNS 名（例如 `my-laptop.tailnet-xxx.ts.net`）
3. 端口填 `9999`，别名随意（如 `laptop-board`）
4. 点「接入」——它立刻出现在端口下拉里，带 `⛓` 标记

之后所有烧录后端都能用这块板子，因为服务端会把它映射成一个本地 PTY（`/tmp/forge-deck-remote/<别名>.pty`），PlatformIO / esptool / avrdude 都当成普通串口。

### 多块板子

```bash
node bridge/serial-bridge.js \
  --device /dev/ttyUSB0:9999 \
  --device /dev/ttyACM0:10000
```

界面上接两次（端口分别 9999 / 10000）。

### Tailscale ACL

bridge 的裸 TCP 没有握手，鉴权靠 `--allow`（默认只收 tailnet 网段与 loopback）。想更严格：

```bash
# 只允许你自己的机器
node bridge/serial-bridge.js --device /dev/ttyUSB0 --port 9999 --allow 100.64.1.23/32
```

Tailscale 管理后台的 ACL 里也可以限制：

```jsonc
{
  "grants": [
    { "src": ["you@example.com"], "dst": ["my-laptop:9999"], "ip": ["tcp"] }
  ]
}
```

### 让桥常驻

```bash
# 用 systemd 用户服务（Linux）
bash bridge/install.sh --device /dev/ttyUSB0 --port 9999
systemctl --user status forge-deck-bridge
```

macOS 用 `launchd` 或 `nohup node bridge/serial-bridge.js ... &`。

## 方式 B：ssh 反向隧道（Tailscale 不通时的备胎）

服务器能 ssh 到你，或者你能 ssh 到服务器，就能用一条隧道把 bridge 端口搬过去——**不需要 tailscale**，只要有 SSH。

```bash
# 在插着板子的电脑上
node bridge/serial-bridge.js --device /dev/ttyUSB0 --port 9999

# 另一条终端：把服务器的 9999 转发到本地 9999
ssh -N -R 9999:localhost:9999 user@server
```

然后在 ForgeDeck 里接：

```
主机: 127.0.0.1    端口: 9999    别名: usb-via-ssh
```

服务器上会看到 `127.0.0.1:9999`，而它的对端其实是你的电脑。

小技巧：

```bash
# 保持隧道不断（网络抖动时自愈）
autossh -M 0 -N -R 9999:localhost:9999 user@server
```

也可以反过来：服务器 `ssh -L` 到你的电脑，前提是电脑能被连上。

## 方式 C：Web Serial（零安装，浏览器直连）

Chrome / Edge 支持 `navigator.serial`，ForgeDeck 页面直接把**当前这台设备**的串口拿过来，完全不过服务器。

前提：页面必须是 `https://`（`tailscale serve` 就是）或 `http://localhost`。

1. 底部面板 → `串口监控` → 点 `本机 USB`
2. 浏览器弹出选择框，选中你的板子
3. 波特率选好，开始看输出 / 发指令

**ESP 直烧**：同一个面板里的 `ESP 直烧` 按钮，选 `.bin`、填地址（通常 `0x0`），走 esptool-js 直接在浏览器里烧（首次需要联网加载库，或运行 `scripts/vendor.sh`）。

限制：

- 只有 Chromium 系浏览器支持（Firefox/Safari 没有 Web Serial）
- 授权是按"站点 + 设备"记的，换端口/换线可能要重新选
- STM32/AVR 的烧录协议浏览器里没有成熟实现，请用方式 A/B + 服务端 PlatformIO
- 手机上的 Chrome 一般不支持 Web Serial

## 三种方式怎么选

| | A. bridge + Tailscale | B. ssh -R | C. Web Serial |
|---|---|---|---|
| 需要装东西 | 本机 Node | 本机 Node + ssh | 只 Chrome |
| 支持所有后端 | ✅ | ✅ | 仅 ESP |
| 多人共享同板 | ✅ | ✅ | ❌ |
| 手机可用 | ✅（看/发串口） | ✅ | ❌ |
| 断线自愈 | 桥会重连设备；映射会自动等对端 | autossh | 手动重连 |
| 适合 | 日常 | 网络受限 | 临时救急 |

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 接入后显示「离线」 | 对端 bridge 没跑，或 `--allow` 没放行；`curl http://<ip>:9999/` 应能被拒但不是超时 |
| 端口下拉没有 ⛓ 项 | 先点一次「刷新端口」；服务端缺 `socat`/`python3` 时映射后端显示 none |
| 烧录报 `端口不存在` | 桥断了，PTY 被清理；重新「接入」 |
| Web Serial 按钮不出现 | 不是 Chromium 系、或页面不是 https/localhost |
| Web Serial 选不到设备 | 串口被别的程序（Arduino IDE、screen）占着 |
| macOS 权限 | 首次需要在「系统设置 → 隐私与安全性」允许终端/浏览器访问 USB 串口 |
| Linux 权限 | `sudo usermod -aG dialout $USER` 后重新登录 |

## 安全提醒

bridge 暴露的是**一块真实硬件的读写权**。默认 `--allow` 只收 tailnet 与 loopback；把 `--allow any` 打开前，先确认这个端口不会被不该访问的机器碰到。ForgeDeck 服务端的 token 只保护 Web 界面，保护不了 bridge 的裸 TCP 端口——那一层由 Tailscale ACL 或 SSH 负责。
