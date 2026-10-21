# 功能：Agent 集成

**简体中文** ｜ [English](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.en.md)

> 返回 [README](https://github.com/pure-craft/dsh-actions/blob/main/README.md) ｜ 相关：[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md) ｜ [会话层](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.md) ｜ [面板](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.md)

同一个 Action 以两种形态提供：面板上的一次点击（人），以及一组结构化工具（Agent）。两侧的语义完全一致——同一份目录、同一个冲突协议、同一条审批闸门。

新会话启动时，插件会把当前可供 Agent 调用的 Action 摘要注入运行时上下文，包括稳定 id、label、detail、审批要求和输入提示，并同时说明四个工具各自负责什么。`agentVisible: false` 不会进入这份上下文；完整命令和配置仍按需通过 `actions_query` 渐进披露，避免把整个目录塞进初始提示词。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `actions_query` | 列出当前工作区归一化后的任务摘要（id、label、detail、来源层、审批要求、本会话最新运行状态）——渐进式披露的第一层 |
| `actions_run` | 按 id 启动任务，可带 `params`；`wait: true` 时同步阻塞到终态（60 秒封顶，超时返回当前状态）——短任务（check/test/lint）零轮询拿终态，长任务（dev/publish）省略后接 `actions_query` 跟进；返回结构化结果（见下） |
| `actions_query` | 查看完整定义与运行输出（按 `runId` 或 `actionId`；`actionId` 形式支持字节偏移增量读取） |
| `actions_cancel` | 取消本会话的某个运行（显式停止的唯一途径；对终态运行调用安全） |
| `actions_configure` | 在 `global` / `workspace` / `session` 层严格创建、更新或删除 Action；创建会在批准后读取当前层并拒绝同名冲突，更新/删除使用 entry revision 防止覆盖；所有写入都**始终要求用户批准** |

四个工具都不接受 `workspace` 参数，始终绑定调用会话的工作区，并与该会话的 Actions 面板使用同一份 catalog。它们不能跨工作区查询、运行或配置；仅仅编辑了嵌套仓库中的文件，不会改变会话工作区。

`actions_run` 的结果是可辨识联合：`started`（新实例）、`already-running`（reuse，返回现有实例）、`rejected`（排他策略）、`approval-declined`（审批未通过，未启动任何实例）。Agent 收到冲突结果后**绝不隐式中断**——取消永远是显式的 `actions_cancel`。

## 审批流

`approval: "agent"` 或 `"always"` 的任务，Agent 调用 `actions_run` 时先经宿主审批通道询问用户；回答以 `approval-declined` 返回（`rejected` / `cancelled` / `unavailable`——后者表示部署没有审批通道，此时失败关闭）。Agent 的正确姿态是尊重拒绝：不自动重试、不用 shell 绕行。`actions_configure` 同样必经批准（Agent 给自己造可执行命令属高危操作）。


### 单次扩权与失败重试

- `approval: never`：继承会话沙箱，不自动扩权。
- `approval: agent/always`：参数先求值，审批展示实际命令、目录及本次 `danger-full-access`；一次批准同时授权运行和扩权。不修改会话策略，审批拒绝、取消或不可用均不启动。
- 失败结果中的 `sandboxMode` 记录执行权限；宿主确认拒绝时 `failureKind: sandbox-denied`，仅输出疑似权限错误时为 `permission-error`（不代表确认沙箱拒绝）。`failureHint` 给出恢复指引，普通业务失败不建议提权。
- 先检查输出及部分副作用，再用下面的调用申请重试。不能同时传 `actionId` 或 `params`；只允许当前会话、当前工作区中保留的失败运行，且不能再次提权已使用 full access 的运行。

```json
{ "retryRunId": "run-3", "justification": "git fetch 需要写入工作区外的 worktree Git 元数据，已确认上次未创建 MR", "wait": true }
```

重试使用原运行已求值的命令、目录、Action 环境覆盖和参数，不重新读取当前 catalog、不重复变量替换；脚本内容和继承的宿主环境并不冻结。每次重新审批，重新执行整个 Action，新记录通过 `retryOf` 关联原失败记录。运行记录只在内存中保留；已淘汰或 Host 重启后的记录不能重试。冲突规则照常生效，不会隐式停止正在运行的实例。

## 会话框集成

- **引用**：会话框输入 `/` 从菜单选择任务（候选带 `actions:` 前缀），插入 `☰ actions:<label>` chip；面板行上的 @ 按钮插入同形引用令牌。发送时 chip 经 codec 展开为**操作简报**——「使用 Action「label」（id: …）。必填：…（select 选项）」——Agent 据此精确调用（命令全文可用 `actions_query` 后补）。仅面板可见（`agentVisible: false`）的任务被引用时会明确告知 Agent 无法运行、应交还用户。
- **发送到对话**：任务行上的 @ 按钮向会话框插入同一引用令牌——"帮我把这次失败的输出继续处理"从复制粘贴变成一次点击。

## 随包编写指导

插件内置 `dsh-actions-authoring` skill（随包版本化，Host 注册）：写配置时给出全字段参考与策展指导，操作任务时给出 query→run→query→cancel 的节奏与冲突/审批处理守则。schema 变更时与插件同版本更新（由项目贡献约定强制）。

## 可见性与隔离

Agent 只看到 `agentVisible: true`（默认） 的任务；运行状态按会话隔离——Agent 只能看到、取消本会话的运行，跨会话访问一律 `run-not-found`。同一会话的人与 Agent 共享运行视图。

`view: "layers"` 只返回 Agent 可见的原始来源条目与 revision，不会藉同名条目泄露其他来源的隐藏定义。删除只作用于目标来源，不存在 fallback；旧 `acknowledgeFallback` 参数仅兼容忽略。常规 catalog/action/run 投影不含 UI-only `favorite`/`icon`；保留四工具，不增加常用管理工具。
