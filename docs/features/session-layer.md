# 功能：会话层

> 返回 [README](../../README.md) ｜ 相关：[配置参考](configuration.md) ｜ [Agent 集成](agent-integration.md) ｜ 场景：[会话草稿本](../scenarios/03-session-scratchpad.md)

三层模型的最上层：会话层。它回答"这个任务只在当前会话里有意义"的场景——一次性命令、把某个任务的参数钉死一档、Agent 在会话中刚发现的工作流。

## 存储与可见性

- 路径：`<dshHome>/sessions/<projectKey(cwd)>/<sessionId>/actions.json`——复用宿主会话持久化布局，存放在会话自己的目录里。
- 只对该会话可见：合并优先级 全局 < 工作区 < 会话，会话层在它参与的每次合并中都胜出。
- **空层是正常态**：首次注册前文件不存在（`available: true` + `exists: false`）；面板据 `exists` 信号隐藏"打开配置"按钮，注册首个任务后文件出现。

## 写入路径：`actions_register`

Agent 经 `actions_register` 把新任务写进会话层，**注册必经用户批准**（Agent 给自己造可执行命令属高危操作）。支持两种粒度：

- 独立命令：完整的一条新任务定义；
- 变体：`extends: "<layer>:<label>"` 继承现有任务的定义（cwd/env/inputs/runOptions 等），配合 `params` 把参数钉死一档——例如把 `workspace:deploy` 派生成"部署到 staging"的会话专用变体。

`extends` 按各层原始条目解析（被高层覆盖的条目仍可显式引用），链式继承与声明顺序无关；引用解析不到时运行报 `unknown-extends`。细节见[配置参考](configuration.md)。

## 生命周期与提升

- 会话层文件随会话目录存续；不同会话互不可见。
- 会话**参数 pin**（`actions_set_params`）是另一回事：纯内存态，随会话销毁——别把两者混淆：会话层存任务定义，pin 板存参数取值。
- 经得起用的会话任务应提升到文件层：面板会话分区提供审阅与「提升」入口（review-and-persist），人确认后写入工作区/全局配置，走正常的 git 审查。
