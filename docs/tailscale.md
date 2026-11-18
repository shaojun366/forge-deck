# Tailscale 接入指南

ForgeDeck 默认只监听 `127.0.0.1`，把"对外"这件事交给 Tailscale。这样你不需要开防火墙端口、不需要自签证书、不需要 nginx 反代。

## 方案 A：`tailscale serve`（推荐）

```bash
tailscale serve --bg http://127.0.0.1:8083
tailscale serve status
```

- 输出里会出现 `https://<主机名>.<tailnet>.ts.net`
- 证书由 Tailscale 自动签发（Let's Encrypt 内部 CA）
- 只有同一 tailnet 的设备能打开
- `--bg` 表示后台常驻；重启后仍然生效

换端口：

```bash
tailscale serve --bg --https 8443 http://127.0.0.1:8083
```

关闭：

```bash
tailscale serve reset
```

## 方案 B：`tailscale funnel`（对公网开放）

**只在你有令牌并且接受公网暴露时才用。** 前提是 tailnet 已开启 HTTPS certificates（管理后台 → DNS → HTTPS Certificates）。

```bash
tailscale funnel --bg http://127.0.0.1:8083
```

配套的加固：

```jsonc
// config.json
{
  "token": "用 openssl rand -hex 32 生成",
  "tailscale": { "whoisAuth": true, "allowUsers": ["you@example.com"], "allowTags": [] },
  "shell": { "enabled": false },        // 公网场景建议关掉交互 shell
  "serial": { "allowPorts": ["/dev/ttyUSB0"] }
}
```

Funnel 的请求来自公网 IP，`whoisAuth` 无法识别身份，此时**必须**靠 token 保护。

## 方案 C：直接监听 tailnet 地址

不想用 serve，就让 ForgeDeck 直接监听本机的 tailnet IP：

```jsonc
{ "host": "100.64.x.y" }   // tailscale ip -4 查看
```

优点是没有中间层；缺点是必须自己处理端口暴露与 TLS（tailnet 内部走加密 WireGuard，纯内网场景可以接受）。

## 身份识别（WhoIs）

`config.json` 里 `tailscale.whoisAuth=true` 时，来自 `100.64.0.0/10` 的请求会执行：

```bash
tailscale whois --json 100.64.1.23
```

若解析出 `User.LoginName` 与 `Node.Name`，就把该身份作为登录用户（`via: "tailscale"`），无需输入令牌。

白名单用法：

```jsonc
"allowUsers": ["you@example.com"],      // 按登录名
"allowTags":  ["tag:lab"]               // 按节点标签（ACL 里给机器打 tag）
```

两个都留空且 `allowAnyTailnetDevice=true`，等于"tailnet 内谁都能进"。多人共用的 tailnet 建议把白名单填上。

> `tailscale whois` 需要本机 tailscaled 的访问权限。以普通用户跑 ForgeDeck 通常可用；如果在受限 sandbox（如 snap）里失败，日志里会退化到"需要访问令牌"，此时用 token 登录即可。

## 手机 / 平板

1. 装 Tailscale 客户端并登录同一账号
2. 浏览器打开 `https://<主机名>.<tailnet>.ts.net`
3. 串口面板在窄屏下会自动压缩侧栏；终端建议横屏

iOS 上注意：**不要**开"私人中继"或系统代理绕过 tailnet，否则 MagicDNS 解析会失败。

## 排错清单

| 现象 | 检查 |
|---|---|
| `serve` 后 502 | `curl http://127.0.0.1:8083/api/health` 是否通；进程是否活着 |
| 证书报错 / 打不开 https | 后台是否启用 HTTPS Certificates；`tailscale cert <dns>` 能否签发 |
| 能打开但一直跳登录 | 令牌错了；或 cookie 被浏览器拦（确认不是无痕 + 第三方 cookie 限制） |
| Tailnet 面板显示"未运行" | `sudo tailscale up`；`systemctl status tailscaled` |
| 手机连不上 | 手机端 Tailscale 是否在线；是否被 ACL 拒绝 |
| 串口打不开 | `dialout` 组、`allowPorts`、容器 `--device` |

## 与 SSH 端口转发的区别

`ssh -L` 转发的是**网络端口**，转发不了你本机的 USB。ForgeDeck 的定位正是"把 USB 留在服务器上，把操作搬到浏览器"——所以它和 SSH 转发不冲突，而是替代"必须坐在服务器前面"的那一步。
