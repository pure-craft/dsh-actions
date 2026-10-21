# 功能：会话层

**简体中文** ｜ [English](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md)

> 返回 [README](https://github.com/pure-craft/dsh-actions/blob/main/README.md) ｜ 相关：[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md) ｜ [Agent 集成](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.md) ｜ 场景：[会话草稿本](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.md)

三层独立来源之一：会话层。它回答"这个任务只在当前会话里有意义"的场景——一次性命令、把某个任务的参数钉死一档、Agent 在会话中刚发现的工作流。

## 存储与可见性

- 路径：`<dshHome>/sessions/<projectKey(cwd)>/<sessionId>/actions.json`——复用宿主会话持久化布局，存放在会话自己的目录里。
- 只对该会话可见；与全局/工作区来源完全独立，同名不覆盖。
- **空层是正常态**：首次注册前文件不存在（`available: true` + `exists: false`）；面板据 `exists` 信号隐藏"打开配置"按钮，注册首个任务后文件出现。

## 动态 Action 目录：`folders`

当工作区只是多个 Git 仓库的上层聚合目录时，每个仓库仍把定义放在自己的 `<folder>/.dsh/actions.json`。会话层可以选择本次真正涉及的目录：

```jsonc
{
  "version": "1.0.0",
  "folders": ["frontend", "services/api"],
  "actions": []
}
```

规则刻意保持简单：

- `folders` 只允许出现在会话层；全局或工作区文件里的同名字段被忽略，并在该来源上记一条错误（不会静默生效）；
- 每个值是相对当前会话工作区的目录，加载 `<folder>/.dsh/actions.json`；绝对路径按原样使用；
- 它是完整的会话选择，不和其他层做继承、并集或覆盖；重复或指向同一目录的写法会合并成一个来源；
- 未写或写空数组都表示不加载额外目录；全局层、根工作区层和会话自己的 `actions` 仍照常加载；
- 不复制所选仓库的 Action 定义，也不改写任何仓库文件；换一个会话可以选择完全不同的目录；
- 所选目录不能是工作区根目录本身（它已作为工作区层加载），也不能再声明自己的 `folders`——递归选择被拒绝，仓库无法藉此扩大自己的读取范围。

**每个目录是独立来源，不与任何层合并。** 仓库 A 和仓库 B 各有一个 `build` 时，得到两个互不覆盖的 Action，id 形如 `folder:frontend:build`（`folder:<相对工作区的目录>:<label>`）。在该 Action 里：

- `${workspaceFolder}` / `${workspaceFolderBasename}` 指向这个仓库目录，而不是会话工作区；
- `options.cwd` 相对该目录解析，未写时默认就是该目录；
- 相对 cwd 可以 `../` 回到上层，目录是解析基准而非写入边界；
- 目录没有 `.dsh/actions.json` 是**正常空源**（`available: true` + `exists: false`）——选中一个仓库不等于它已经有 Actions；
- 目录的配置文件损坏只降级该来源，其他来源照常加载。

因为定义留在仓库里，面板不会为这些 Action 提供删除入口：文件属于仓库，会话只是指向它。

## 写入路径：会话层由谁写

- **Agent 写任务定义**：`actions_configure`（见下节）。
- **配置完整会话层**：宿主插件调用 `dshActions.configureSession(sessionId, workspace, { folders, actions })`，在一次原子写入中替换目录选择与会话 Action、保留文件 `version`，成功后立即刷新 catalog；`clearSession(sessionId, workspace)` 原子清空两者。兼容方法 `setSessionFolders(sessionId, workspace, folders)` 仍只替换 `folders` 并保留 Actions。也可以直接编辑会话层的 `actions.json`（面板里会话分区的编辑按钮就是打开这个文件，文件存在时可见）。目前**没有**目录选择器 UI，也**没有**对应的 Agent 工具：选择由用户或宿主插件决定，Agent 只是消费它（`actions_query` 会带上自己的会话，因此能看到所选目录里的 Action）。

## 写入路径：`actions_configure`

Agent 经 `actions_configure` 把新任务写进会话层，**注册必经用户批准**（Agent 给自己造可执行命令属高危操作）。支持两种粒度：

- 独立命令：完整的一条新任务定义；
- 变体：`extends: "<layer>:<label>"` 继承现有任务的定义（cwd/env/inputs/runOptions 等），通过派生条目的 `inputs` 默认值选择参数档位——例如把 `workspace:deploy` 派生成"部署到 staging"的会话专用变体。

`extends` 按各层原始条目解析（来源之间没有隐式覆盖），链式继承与声明顺序无关；引用解析不到时运行报 `unknown-extends`。细节见[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md)。

## 生命周期与提升

- 会话层文件随会话目录存续；不同会话互不可见。
- 运行参数只来自本次显式传参和 Action 声明的 `default`；不存在会话级参数记忆或隐藏参数源。
- 经得起用的会话任务应提升到文件层：请 Agent 通过 `actions_configure` 在工作区/全局层创建等价定义，经审批和验证后再删除原会话条目，走正常的 git 审查；面板目前没有直接「提升」入口。
