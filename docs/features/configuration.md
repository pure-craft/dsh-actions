# 配置参考：actions.json 全字段

> 返回 [README](../../README.md) ｜ 相关：场景文档（[桥接脚本](../scenarios/01-bridge-scripts.md) / [CI 流水线](../scenarios/02-ci-pipeline.md) / [会话草稿本](../scenarios/03-session-scratchpad.md)）｜ [面板](panel.md) ｜ [会话层](session-layer.md)

Action 定义的唯一来源是独立的 `actions.json`（**JSONC**：允许注释与尾逗号），分三层读取，合并优先级递增：

| 层 | 路径 | 适用 |
| --- | --- | --- |
| 全局 | `~/.dsh/actions.json`（`DSH_HOME` 可覆盖根目录） | 个人常用、跨工作区 |
| 工作区 | `<workspace>/.dsh/actions.json` | 项目共享，随仓库提交（默认选择） |
| 会话 | `<dshHome>/sessions/<projectKey>/<sessionId>/actions.json` | 仅当前会话可见，由 `actions_register` 写入（见[会话层](session-layer.md)） |

每个文件必须声明 `"version": "1.0.0"`——这是枚举白名单门，不是 semver；其他取值整层降级为 `unsupported-version`。

## 字段全表

| 字段 | 必备 | 含义 |
| --- | --- | --- |
| `label` | 是 | 展示名；也是跨层合并键与稳定 id（`<layer>:<label>`）的基础 |
| `command` | 是（`extends` 条目可省略，继承基定义） | Shell 命令，经 `shell -c` 在工作区沙箱边界内执行；可引用 `${input:id}` |
| `detail` | 否 | 一行描述，面板与 `actions_list` 都展示——Agent 靠它判断任务是否合用，务必写 |
| `visibility` | 否 | `all`（默认，面板+Agent）/ `ui`（仅面板）/ `agent`（仅 Agent 工具） |
| `approval` | 否 | `never`（默认）/ `agent` / `always`——运行前的审批要求，见下文 |
| `options.cwd` | 否 | 工作目录，相对工作区根（默认工作区根） |
| `options.env` | 否 | 额外环境变量 |
| `runOptions.instanceLimit` | 否 | 最大并发实例数，≥1 钳制（默认 1） |
| `runOptions.instancePolicy` | 否 | `reuse`（默认，重复运行返回现有实例 `already-running`）/ `reject`（排他，返回 `rejected`） |
| `presentation.panel` | 否 | `new`（默认）/ `dedicated` / `append`——面板呈现档，见下文 |
| `inputs` | 否 | 声明式参数列表，见下文 |
| `extends` | 否 | 引用另一 Action id 作为基定义继承，见下文 |

## inputs（声明式参数）

只保留 `string` / `select` 两种类型。在 `command`、`options.cwd`、`options.env` 值与 `detail` 中以 `${input:id}` 引用：

| 参数字段 | 必备 | 含义 |
| --- | --- | --- |
| `id` | 是 | 标识符，以 `${input:id}` 引用 |
| `type` | 是 | `string`（自由文本）/ `select`（`options` 中选一） |
| `description` | 否 | 展示在面板表单，也帮助 Agent 取值 |
| `required` | 否 | 为 true 时，无值且无 `default` 则运行报错（`invalid-params`，列出缺失 id） |
| `default` | 否 | 未提供值时的兜底；`select` 必须落在 `options` 内 |
| `options` | `select` 必备 | 允许取值，非空 |

两条关键规则：**替换是原文替换、不加引号不转义**（值可能含空格或 shell 元字符时由作者自行加引号）；**参数参与冲突判定**——同一 Action 不同参数的运行互不冲突。运行时的取值链为 显式传参 > 会话固定值 > 配置 `default`（见[会话层](session-layer.md)与[面板](panel.md)）。

## approval（审批要求）

- `never`（默认）：不询问。
- `agent`：Agent 工具调用先经宿主审批通道向用户询问；面板不受影响。
- `always`：Agent 询问；面板额外弹确认对话框（勾选 acknowledge）后才运行。

用户拒绝时返回 `approval-declined`（不启动任何实例）。删除数据、部署、写外部系统等不可逆操作必须标 `agent` 或 `always`。审批先于参数求值。

## presentation.panel（呈现档）

决定面板 run tab 工作区里新运行与 tab 的关系（纯展示层，不影响运行语义）：

- `new`（默认）：每次运行开一个新 tab，旧运行保留为独立 tab；
- `dedicated`：该任务独占一个 tab，重跑原地替换内容（上次输出从视图丢弃，运行记录保留）；
- `append`：同 dedicated，但新输出接在历史输出下方，中间插入边界行。

面板行为细节见[面板](panel.md)。

## extends（继承）

`extends: "<layer>:<label>"` 引用本会话可见的另一 Action 作为基定义：继承其 `command`/`options`/`inputs`/`runOptions` 等，本条写了的字段覆盖。解析规则：

- 按**各层原始条目**解析（合并之前）——被高层覆盖的条目仍可被显式引用，`extends: "global:build"` 命中全局文件自己的 `build`；
- 链式继承（a extends b extends c）与声明顺序无关；
- 引用解析不到时条目保留标记，运行时报 `unknown-extends`。

## 合并规则与容错

同 `label` 跨层逐字段合并（VS Code assign 语义）：上层写了的覆盖，未写的继承；`options.env` 按键合并，`inputs` 按 `id` 合并，`extends` 以本条的引用为准。单条缺 `label`/`command` 或字段非法 → 该条忽略并记录 source 级错误，其余照常加载；降级原因与错误详情显示在面板 source 横幅上。

## 变量替换与生效时机

`${workspaceFolder}`、`${workspaceFolderBasename}`、`${userHome}`、`${env:NAME}`、`${input:id}`；每次运行重新求值。**保存任一 `actions.json` 即自动生效**——Host 轮询各层配置并把刷新后的目录推送到每个打开的标签页，面板工具栏的刷新按钮是手动兜底。

不支持的能力：`type: process`、command 型 inputs、`dependsOn`、`problemMatcher`、平台覆盖块等。
