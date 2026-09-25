# 场景：桥接现有脚本入口

> 返回 [README](../../README.md) ｜ 相关：[配置参考](../features/configuration.md) ｜ 场景：[CI 流水线](02-ci-pipeline.md) ｜ [会话草稿本](03-session-scratchpad.md)

## 痛点

项目里能跑的命令早就有了，只是分散：`package.json` 的 scripts、Makefile、Taskfile、`scripts/` 目录里的脚本……入口分散意味着没人记得全，Agent 每次也得重新翻。DSH Actions 不做这些格式的运行时适配器（已明确否决），而是提供一个一次性的解法：**策展固化**。

## 做法

让 Agent 做一次扫描与策展，把常用任务固化成 `.dsh/actions.json`：

1. 空状态下点分区头的「让 Agent 帮我创建」按钮——附带的提示词草稿就是让 Agent 扫描 package.json scripts、Makefile、Taskfile 等入口并策展写入配置；
2. 或直接在会话里下一句指令："把这个仓库常用的脚本入口整理成 DSH Actions"。

固化后每个任务都有统一的 `label`/`detail`/运行策略，原始脚本入口保持不动（Action 的 `command` 只是调用它们）。

## 收益

- **统一入口**：同一份清单出现在面板（人一键运行）和 Agent 工具（`actions_list` 可发现、可调用）两侧；
- **可策展**：趁机补上 `detail` 描述、给排他任务标 `runOptions.instancePolicy: "reject"`、给高危任务标 `approval`——原格式里表达不了的行为约束，在 `actions.json` 里都有位置；
- **可演进**：定义跟随仓库，评审走正常 git 流程，Agent 后续还能继续改进它。

## 示例

```jsonc
{
  "version": "1.0.0",
  "actions": [
    // 桥接 npm scripts
    { "label": "check", "command": "pnpm check", "detail": "类型检查 + lint + 全部测试" },
    // 桥接 Makefile 目标
    { "label": "proto", "command": "make proto", "detail": "重新生成 protobuf 代码" },
    // 桥接 scripts/ 目录里的脚本
    { "label": "release", "command": "node scripts/release.mjs", "detail": "打 tag 并发布", "approval": "always" }
  ]
}
```

注意这是**一次性策展**，不是运行时桥接：插件不会在每次运行时去解析 package.json/Makefile——`actions.json` 是唯一项目定义源（外部格式导入/桥接已明确否决）。
