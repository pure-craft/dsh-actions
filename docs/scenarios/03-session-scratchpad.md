# 场景：会话草稿本（会话级临时任务）

> 返回 [README](../../README.md) ｜ 相关：[会话层](../features/session-layer.md) ｜ 场景：[桥接脚本入口](01-bridge-scripts.md) ｜ [CI 流水线](02-ci-pipeline.md)

## 痛点

调试中总有一些"只在这个会话里有意义"的命令：把某个 Action 的参数钉死成当前需求的取值、一条临时拼出来的诊断命令、Agent 刚摸索出来的多步流程。固化进 `actions.json` 不值得（是会话语境，不是项目定义），但每次重敲又繁琐。

## 做法

让 Agent 把它注册为**会话级 Action**：

```
你：这个诊断流程不错，记下来，这个会话里后面还要用。
Agent：→ actions_register({ label: "diag-slow-requests", command: "...", detail: "..." })
       （注册前会先问你批准——Agent 给自己造可执行命令属高危操作）
```

注册后它出现在面板的会话分区（`session:<label>`），和文件层任务一样一键运行、一样流式看输出。支持两种粒度：

- **独立命令**：完整的新任务；
- **变体**：`extends` 继承现有任务 + `params` 钉死参数——比如从 `workspace:deploy` 派生"部署到 staging（本会话专用）"。

## 生命周期

- 会话层定义存放在会话自己的目录里（`<dshHome>/sessions/.../actions.json`），只本会话可见；其他会话天然看不到。
- 会话结束即归档——临时任务随会话目录退场，不污染项目配置。

## 从临时到长期：review-and-persist

用得好的临时任务别留在会话里烂掉：面板会话分区提供审阅入口，确认值得长期保留时**提升到文件层**（写入工作区或全局 `actions.json`），走正常 git 审查，成为项目共享能力。这正是 DSH Actions 想要的演进路径：Agent 驱动发现 → 会话内试用 → 人审阅 → 固化共享。
