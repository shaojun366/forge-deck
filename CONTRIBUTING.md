# 参与 ForgeDeck

ForgeDeck 是 MIT 许可的开源项目。**二开、Fork、改商用、拿去改成你自己的工具，都欢迎，不用先说一声。** 这里只写"怎么改得顺手、怎么合回来"。

## 三种参与方式

| 你想做什么 | 怎么做 |
|---|---|
| 自己用 / 魔改 | `git clone` 后随便改。`config.json`、`workspace/`、`web/vendor/` 都在 `.gitignore` 里，不会冲突 |
| 提一个小改动 | 直接开 PR，**不用先开 issue**。改完说明"为什么"就够了 |
| 大改 / 换架构 | 先开一个 issue 说方向（或直接在 PR 里写清楚动机），避免白写 |

协作者（有写权限的人）可以直接往 `feat/*`、`fix/*` 分支 push；`main` 走 PR，保证历史可读。

## 本地开发

```bash
git clone https://github.com/shaojun366/forge-deck.git
cd forge-deck
cp config.example.json config.json   # 改 token，或直接留空用 loopback 免登录
node server/main.js                  # http://127.0.0.1:8083
```

没有 npm 依赖，没有构建步骤。改 `web/` 下的文件刷新页面即可；改 `server/` 需要重启进程（`node --watch server/main.js` 也行）。

前端库默认走 `web/vendor/`（跑一次 `bash scripts/vendor.sh` 生成），没有就走 CDN，再没有就降级成纯文本编辑器——**别破坏这条降级链**。

## 提交前跑什么

```bash
# 语法
for f in server/*.js web/app.js bridge/serial-bridge.js scripts/*.js; do node --check "$f"; done
python3 -m py_compile server/pty_bridge.py

# 接口与终端
FORGEDECK_TOKEN=dev node scripts/smoke.js        http://127.0.0.1:8083

# 本机 USB 桥接（不需要真硬件，用伪串口）
FORGEDECK_TOKEN=dev node scripts/smoke-bridge.js http://127.0.0.1:8083
```

CI 会在 Node 18/20/22 上跑同一套。

## 代码约定

- **零运行时依赖**是硬约束。要加 npm 包，先在 issue 里论证；前端库只允许"可降级"的方式引入。
- 子进程一律 `spawn(cmd, args)`，**永远不要拼 shell 字符串**。确实需要 shell 语义时写 `['bash','-lc', ...]` 并说明原因。
- 所有路径经过 `resolveIn(workspaceRealPath, ...)`；不要自己拼 `path.join`，不要把用户输入直接交给 fs。
- 新接口：`server/main.js` 里 `route('GET', /^\/api\/xxx$/, handler)`，handler 抛 `util.fail(status, msg)`。
- 前端不读 `config.json`；需要什么就往 `publicConfig()` 里加，并在 `web/app.js` 的 `S.cfg` 里用。
- UI 文案用中文；日志前缀保持 `[forge-deck HH:MM:SS]`。
- 注释写"为什么"，不写"是什么"。

## 加一个烧录后端

1. `server/flash.js` 的 `BACKENDS` 加一行（`id` / `name` / `bins` / `note`）
2. `buildCommand()` 加分支，返回 `{ cmd, args, cwd, note }`
3. `web/app.js` 的「⚙︎ 高级烧录」下拉加 `<option>`
4. `docs/backends.md` 补一节：命令、权限、排错

## 改 bridge（本机 USB 那条链）

链路是 `串口 → bridge(TCP) → 服务端 pty_bridge → PTY → 烧录/监控`。任何一环改动都要保证：

- 裸 TCP 仍然是**纯字节流**（PlatformIO 的 `socket://` 依赖这一点，不能加握手）
- 设备拔插后能自愈
- `--allow` 默认只放行 tailnet 与 loopback

`scripts/smoke-bridge.js` 会用 Python 的 pty 造一块假板子跑完整条链，改完先跑它。

## 提交信息

```
feat: 新功能
fix: 修 bug
docs: 文档
refactor: 重构
perf: 性能
chore: 杂项
```

一条提交说一件事；大改拆成几条。中文英文都行，仓库现有历史是中文。

## 许可

提交 PR 即表示同意以 [MIT](LICENSE) 许可发布你的贡献。没有 CLA，不需要签任何东西。

二次开发时如果改了名字（比如叫 `MyForge`），只要求保留原来的版权声明和 MIT 文本，其余随你。
