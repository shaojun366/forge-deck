## 这个 PR 做了什么

<!-- 一句话说清动机；如果是修 bug，写复现步骤 -->

## 类型

- [ ] 新功能
- [ ] 修 bug
- [ ] 文档
- [ ] 重构 / 性能
- [ ] 新的烧录后端
- [ ] bridge / Web Serial 链路

## 验证

<!-- 贴命令与关键输出，或者说明为什么没法本地验证 -->

```bash
node --check server/*.js
FORGEDECK_TOKEN=dev node scripts/smoke.js        http://127.0.0.1:8083
FORGEDECK_TOKEN=dev node scripts/smoke-bridge.js http://127.0.0.1:8083
```

- [ ] 没有新增运行时依赖
- [ ] 没有把用户输入拼进 shell 字符串
- [ ] 涉及路径的地方仍走 `resolveIn`
- [ ] 前端新增交互在库加载失败时仍有降级路径
