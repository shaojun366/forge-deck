# 开发与测试

## 环境要求

- Node.js ≥ 18（开发用 22/24 均可）
- `bash`、`coreutils`（`script(1)` 来自 util-linux，用于 PTY）
- 可选：`usbutils`（`lsusb`）、`stlink-tools`、`platformio`、`esptool`、`avrdude`、`arduino-cli`

后端不依赖任何 npm 包；前端库通过 `scripts/vendor.sh` 缓存到 `web/vendor/`，缺失时自动回退 CDN。

## 本地跑起来

```bash
cp config.example.json config.json     # 改 token
node server/main.js                    # http://127.0.0.1:8083
```

调试便利：

```bash
FORGEDECK_TOKEN=dev FORGEDECK_PORT=8099 node --watch server/main.js
```

不带 token 时只有 `127.0.0.1` 能进（页面会直接进入，不需要登录）。

## 自检

```bash
FORGEDECK_TOKEN=dev node scripts/smoke.js http://127.0.0.1:8099
```

覆盖 17 项：健康检查、401、文件读写、搜索、设备、后端、任务执行与日志、WS 终端回显。

## 代码地图

| 文件 | 职责 | 改动注意 |
|---|---|---|
| `server/main.js` | 路由表 + WS 升级 + 启动 | 新增接口就 `route('GET', /^\/api\/xxx$/, handler)` |
| `server/ws.js` | 手写 RFC6455 | 只支持 FIN=1 的文本/二进制帧；分片仅做降级提示 |
| `server/auth.js` | token + whois | `identify()` 返回 `{ok,user,via}`；`via` 会显示在 UI |
| `server/flash.js` | 命令构造 | 全部数组参数，永不经过 shell |
| `server/jobs.js` | 任务与日志环形缓冲 | 保留最近 4000 行，超出计数到 `truncated` |
| `server/serial.js` | stty + 非阻塞 fd | 同设备只允许一个会话，后连的先关前一个 |
| `server/shell.js` | script(1) PTY | 没有 `script` 时退化为管道 shell |
| `server/fsapi.js` | 文件 API | 所有路径经 `resolveIn`，软链一律拒绝 |
| `web/app.js` | 前端全部逻辑 | 无构建步骤，注意保持"加载失败可降级" |

## 约定

- 路由 handler 抛 `util.fail(status, msg)`，由分发层统一转 JSON 错误。
- 路径参数一律走 `resolveIn(workspaceRealPath, ...)`，不要自己拼 `path.join`。
- 子进程一律 `spawn(cmd, args)`；需要 shell 语义时显式写 `['bash','-lc', ...]`（`custom` 任务）。
- 前端不要直接读 `config.json`，需要什么就加到 `/api/config` 的 `publicConfig()`。
- UI 文案用中文，代码注释可中英混排；日志前缀统一 `[forge-deck HH:MM:SS]`。

## 前端调试技巧

- 浏览器控制台里 `S` 是全局状态（`window.S`），可直接看 `S.tabs` / `S.active`。
- 加载不到 CodeMirror 时会用 `<textarea>` 降级，方便验证"断网也能编辑"。
- `Ctrl+Shift+F` 搜索、`Ctrl+\`` 终端、`Ctrl+B` 编译、`Ctrl+Enter` 烧录。

## 桥接（本机 USB）怎么测

不需要真板子，用 Python 造个伪串口：

```bash
# 起一个会周期性输出的 pts
python3 -c "
import os,pty,time,tty
m,s=pty.openpty(); tty.setraw(s); print(os.ttyname(s))
t=time.time()
while time.time()-t<60: os.write(m, b'hello\n') if time.time()-t<1 else None; time.sleep(0.5)
"
# 另开一个终端
node bridge/serial-bridge.js --device /dev/pts/N --port 19991 --allow any
FORGEDECK_TOKEN=dev node scripts/smoke-bridge.js http://127.0.0.1:8083
```

`scripts/smoke-bridge.js` 会自动：建伪串口 → 起 bridge → `POST /api/remote` → 校验 PTY 读写 → 端口校验 → 清理。

服务端把 TCP 映射成 PTY 需要 `socat` 或 `python3`；两者都没有时 `/api/ports` 的 `backend` 会是 `none`，此时只有 `socket://host:port` 直接交给 PlatformIO 可用。

## 新增一个烧录后端的步骤

1. `server/flash.js` 的 `BACKENDS` 加一行（`id` / `name` / `bins` / `note`）
2. `buildCommand()` 里加分支，返回 `{cmd, args, cwd, note}`
3. `web/app.js` 的"高级烧录"下拉里加 `<option>`
4. `docs/backends.md` 补一节命令与排错

## 无设备时怎么测串口

用伪终端模拟：

```bash
socat -d -d pty,raw,echo=0,link=/tmp/ttyV0 pty,raw,echo=0,link=/tmp/ttyV1
# ForgeDeck 连 /tmp/ttyV0；在 /tmp/ttyV1 上 echo 数据进来
```

`serial.validate()` 只接受 `/dev/...`，测试时可以把端口软链到 `/dev/ttyFDTEST`（`sudo ln -s /tmp/ttyV0 /dev/ttyFDTEST`）。
