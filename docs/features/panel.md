# 功能：Actions 面板

**简体中文** ｜ [English](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md)

> 返回 [README](https://github.com/pure-craft/dsh-actions/blob/main/README.md) ｜ 相关：[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md) ｜ [Agent 集成](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.md) ｜ [会话层](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.md)

面板是给人用的主入口：DSH Web 右侧栏「开始」页的 **Actions** 卡片（绑定当前会话的工作区；composer 统计条上还有一枚实时状态胶囊可直达）。设计目标只有一个——让运行一个项目任务变成一次点击。

## 任务列表

- **三层分组**：工作区 / 全局 / 会话分区展示归一化后的任务；各层标题的编辑按钮在 DSH 原生右侧边栏文件查看器中打开对应的 `actions.json`（该层文件缺失或加载失败时按钮不显示）。
- **语义 badge**：任务行上把原始配置翻译成行为提示——审批要求（`agent`/`always`，always 带盾标）、呈现档（`dedicated`/`append`）、仅面板可见（`agentVisible: false`）、尚未解析的继承引用（`extends`，成功解析后不保留该 badge）四类；默认状态不渲染（安静默认），tooltip 携带原始配置值。
- **空态 CTA**：空层或空配置的分区头提供「让 Agent 帮我创建」按钮，按层附带提示词草稿（扫描工作区脚本入口、创建全局/会话任务）。
- **种子示例**：首次使用时全局层自动种入一份带字段注释的 `dsh-update` 示例（`.seeded` 标记保证只种一次）。
- **删除**：不再需要的 Action 可从面板删除——强确认后从对应层配置文件原子移除；历史运行记录不受影响，活动实例的进程不受牵连。

## 排序与常用

- 拖动任务名称、描述或行内空白处，可在当前分组内排序；不再常驻显示拖拽图标或预留其占位。星标、运行、发送和删除按钮仍独立操作，不会发起拖拽。
- 拖动时其他条目平滑让位，松手后将数组顺序保存到该来源的配置文件；不能跨分组拖动。系统开启「减少动态效果」时不播放位移动画。
- 键盘用户按 Tab 聚焦时才显示排序按钮，可通过该按钮，以空格或 Enter 拿起，方向键移动，再按空格或 Enter 保存；Escape 取消。
- 空心星常驻显示，点击切换常用状态；标星不置顶，也不改变排序。

## run tab 工作区

面板下半区是常驻的运行工作区，模型对齐 VS Code 的 tasks + terminals：

- 每次运行是一个 tab（跨任务排布在一条 tab 条上，溢出横向滚动、边缘渐隐）；点击列表中的任务只聚焦其最新 tab，不替换整个区域；工作区可整体收起/展开、高度固定；没有任何运行时工作区不渲染。
- 各 tab 的输出与取消相互独立，绝不混流；活动中的 tab 可停止，已终结的可遗忘（关闭活动中的 tab 先经「终止并关闭」确认）。
- 焦点规则按呈现档区分：`new` 档不抢焦点（只有正看着最新运行时才跟随新运行），`dedicated`/`append` 档原地刷新所在 tab。三档语义见[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md)。

## 运行与冲突

- 面板手动运行以 DSH Host 本机用户权限执行（`danger-full-access`），不受 DSH 文件沙箱限制，但仍受操作系统权限约束；输出实时呈现。Agent 入口的沙箱与审批规则独立。
- 对正在运行的任务再次触发不会重复启动：定位到现有实例的日志（`already-running`），并就近提供「结束后再运行一次」（观察终态后自动再跑一次）与「停止并重跑」（显式取消 + 显式再运行）。
- `approval: "always"` 的任务运行前弹确认对话框（勾选 acknowledge）；被拒绝时轻提示，不启动任何实例。

## 参数表单

声明了 `inputs` 的任务在运行时渲染表单：重跑时优先带入该次运行的显式参数，其余字段使用声明的 `default`，`select` 用下拉选择。参数不会在会话中暗中记忆；字段语义见[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md)。

## 实时同步

- 同一会话的 Agent 启动的运行实时出现在面板（订阅会话级运行发现流，断连自动重订阅、快照幂等重同步）。
- 保存任一 `actions.json` 自动生效（Host 轮询各层并推送全量快照）；工具栏刷新按钮是手动兜底。
- 运行状态按会话隔离：同一工作区的两个会话互不可见、互不阻塞。

`favorite: true` 标记常用任务，仅影响 UI，不改变运行、审批或 Agent 可见性，也不通过 `extends` 继承。所有来源独立，同名条目并列展示。
