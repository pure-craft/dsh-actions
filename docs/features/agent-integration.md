# 功能：Agent 集成

> 返回 [README](../../README.md) ｜ 相关：[配置参考](configuration.md) ｜ [会话层](session-layer.md) ｜ [面板](panel.md)

同一个 Action 以两种形态提供：面板上的一次点击（人），以及一组结构化工具（Agent）。两侧的语义完全一致——同一份目录、同一个冲突协议、同一条审批闸门。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `actions_list` | 列出当前工作区归一化后的任务摘要（id、label、detail、来源层、审批要求、本会话最新运行状态）——渐进式披露的第一层 |
| `actions_run` | 按 id 启动任务，可带 `params`；`wait: true` 时同步阻塞到终态（60 秒封顶，超时返回当前状态）——短任务（check/test/lint）零轮询拿终态，长任务（dev/publish）省略后接 `actions_inspect` 跟进；返回结构化结果（见下） |
| `actions_inspect` | 查看完整定义与运行输出（按 `runId` 或 `actionId`；`actionId` 形式支持字节偏移增量读取） |
| `actions_cancel` | 取消本会话的某个运行（显式停止的唯一途径；对终态运行调用安全） |
| `actions_set_params` | 会话参数 pin 板：set / clear / list，按声明校验，值随会话销毁 |
| `actions_register` | 把会话中发现的流程注册为会话层任务（`session:<label>`），**必经用户批准**；支持 `extends` 继承与 `params` 钉死 |

`actions_run` 的结果是可辨识联合：`started`（新实例）、`already-running`（reuse，返回现有实例）、`rejected`（排他策略）、`approval-declined`（审批未通过，未启动任何实例）。Agent 收到冲突结果后**绝不隐式中断**——取消永远是显式的 `actions_cancel`。

## 审批流

`approval: "agent"` 或 `"always"` 的任务，Agent 调用 `actions_run` 时先经宿主审批通道询问用户；回答以 `approval-declined` 返回（`rejected` / `cancelled` / `unavailable`——后者表示部署没有审批通道，此时失败关闭）。Agent 的正确姿态是尊重拒绝：不自动重试、不用 shell 绕行。`actions_register` 同样必经批准（Agent 给自己造可执行命令属高危操作）。

## 会话框集成

- **引用**：会话框输入 `/` 从菜单选择任务（候选带 `actions:` 前缀），插入 `☰ actions:<label>` chip；面板行上的 @ 按钮插入同形引用令牌。发送时 chip 经 codec 展开为**操作简报**——「使用 Action「label」（id: …）。必填：…（select 选项）；已记住参数：…」——Agent 据此精确调用（命令全文可用 `actions_inspect` 后补）。仅面板可见（`visibility: ui`）的任务被引用时会明确告知 Agent 无法运行、应交还用户。
- **发送到对话**：任务行上的 @ 按钮向会话框插入同一引用令牌——"帮我把这次失败的输出继续处理"从复制粘贴变成一次点击。

## 随包编写指导

插件内置 `dsh-actions-authoring` skill（随包版本化，Host 注册）：写配置时给出全字段参考与策展指导，操作任务时给出 list→run→inspect→cancel 的节奏与冲突/审批处理守则。schema 变更时与插件同版本更新（AGENTS.md 强制）。

## 可见性与隔离

Agent 只看到 `visibility: all | agent` 的任务；运行状态按会话隔离——Agent 只能看到、取消本会话的运行，跨会话访问一律 `run-not-found`。同一会话的人与 Agent 共享运行视图。
