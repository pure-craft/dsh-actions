# 功能：会话层

**简体中文** ｜ [English](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md)

> 返回 [README](https://github.com/pure-craft/dsh-actions/blob/main/README.md) ｜ 相关：[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md) ｜ [Agent 集成](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.md) ｜ 场景：[会话草稿本](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.md)

三层模型的最上层：会话层。它回答"这个任务只在当前会话里有意义"的场景——一次性命令、把某个任务的参数钉死一档、Agent 在会话中刚发现的工作流。

## 存储与可见性

- 路径：`<dshHome>/sessions/<projectKey(cwd)>/<sessionId>/actions.json`——复用宿主会话持久化布局，存放在会话自己的目录里。
- 只对该会话可见：合并优先级 全局 < 工作区 < 会话，会话层在它参与的每次合并中都胜出。
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

- `folders` 只允许出现在会话层；全局或工作区文件中的同名字段无效；
- 每个值是相对当前会话工作区的目录，加载 `<workspace>/<folder>/.dsh/actions.json`；
- 它是完整的会话选择，不和其他层的 `folders` 做继承、并集或覆盖；
- 未写或写空数组都表示不加载额外目录；全局层、根工作区层和会话自己的 `actions` 仍照常加载；
- 不复制所选仓库的 Action 定义，也不改写任何仓库文件；换一个会话可以选择完全不同的目录。

因此 `folders` 是会话的动态上下文，不是团队共享配置。目录自身的配置继续跟随对应仓库，保持唯一事实源。

## 写入路径：`actions_register`

Agent 经 `actions_register` 把新任务写进会话层，**注册必经用户批准**（Agent 给自己造可执行命令属高危操作）。支持两种粒度：

- 独立命令：完整的一条新任务定义；
- 变体：`extends: "<layer>:<label>"` 继承现有任务的定义（cwd/env/inputs/runOptions 等），配合 `params` 把参数钉死一档——例如把 `workspace:deploy` 派生成"部署到 staging"的会话专用变体。

`extends` 按各层原始条目解析（被高层覆盖的条目仍可显式引用），链式继承与声明顺序无关；引用解析不到时运行报 `unknown-extends`。细节见[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md)。

## 生命周期与提升

- 会话层文件随会话目录存续；不同会话互不可见。
- 会话**参数 pin**（`actions_set_params`）是另一回事：纯内存态，随会话销毁——别把两者混淆：会话层存任务定义，pin 板存参数取值。
- 经得起用的会话任务应提升到文件层：面板会话分区提供审阅与「提升」入口（review-and-persist），人确认后写入工作区/全局配置，走正常的 git 审查。
