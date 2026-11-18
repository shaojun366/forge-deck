# ForgeDeck Bridge

一个零依赖的 Node 脚本，把**本机**的 USB 串口/开发板桥接到网络，让远端的 ForgeDeck 服务器能编译、监控、烧录这块板子。

```
serial-bridge.js --list
serial-bridge.js --device /dev/ttyUSB0 --port 9999
```

- 单文件，直接拷到任意装了 Node ≥ 18 的 Linux/macOS 机器就能跑
- 裸 TCP 字节流：PlatformIO 可直接 `--upload-port socket://host:9999`
- 设备拔插自动重连
- 默认只允许 tailnet（100.64.0.0/10）与本机访问

完整用法见 [docs/remote-usb.md](../docs/remote-usb.md)。

## 参数

| 参数 | 说明 |
|---|---|
| `-l, --list` | 列出本机串口 |
| `-d, --device PATH[:PORT]` | 要桥接的设备，可重复 |
| `-p, --port N` | 基准端口（默认 9999） |
| `-b, --baud N` | 串口波特率（默认 115200） |
| `--bind ADDR` | 监听地址（默认 0.0.0.0） |
| `--allow CIDR[,..]` | 允许来源，`any` 放开 |
| `--reopen-ms N` | 拔插后重试间隔 |
| `--status-port N` | 附加 HTTP 状态页 |
| `--token T` | 状态页令牌 |

## 常驻

```bash
bash install.sh --device /dev/ttyUSB0 --port 9999
```

会生成 `~/.config/systemd/user/forge-deck-bridge.service`（Linux）并启动。
