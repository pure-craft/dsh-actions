# DSH Actions

**简体中文** ｜ [English](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-actions.svg)](https://www.npmjs.com/package/dsh-actions)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/pure-craft/dsh-actions/blob/main/LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-%3E%3D0.1.7--alpha.1-blue.svg)](https://github.com/pure-craft/dsh-actions/blob/main/README.md#安装)

> 写一份跟随仓库的 `actions.json`，它同时是**你在右侧栏点一下就跑的面板入口**，和 **Agent 可以直接调用的结构化工具**——同一份定义，同一个审批闸门。

开发过程中要反复执行的操作，远不止跑一遍测试：

- 各类 check 与测试；
- 生成代码、生成文档的脚本；
- 数据上传、资源同步；
- 提交前跑一遍 lint；
- 触发一次 CI 构建、查一次构建状态；
- 按环境发布；
- 查一次线上服务状态。

它们的共同点有两个：**一是反复执行**——做同一个需求、跑同一类任务时，这些操作会被一遍遍重复；**二是要切平台**——在终端跑完命令，得去浏览器看 CI 状态，再登录另一个系统点发布。

让 Agent 来做，成本反而更高：查文档、编写、运行、调试，多轮循环才跑通一次，而下个会话又从头再来一遍，token 就这么一遍遍烧掉。

VS Code Tasks 的答案是「不用离开编辑器」。DSH Actions 更进一步——**不用离开对话，而且跑一次就固化**：人在面板上点一下，Agent 在会话里说一句话，输出就在同一个工作区里实时出现。

## 核心价值

1. **给人一个快捷启动方式**——右侧面板里每个任务都是一次点击，不用再回忆命令、不用翻散落在各处的脚本；
2. **Agent 参与构建**——编写与固化都交给 Agent：一句指令把一个复杂操作变成可复用任务，多步流程也由它编码、由它调试。于是**固化复杂操作**从「要下决心做一次的工程量」变成顺手的事，不好用就丢掉，试错成本几乎为零；
3. **固化与复用**——工作区层随仓库提交，就是团队共享（新同事 clone 下来就有全套任务）；全局层是个人跨项目；只在当前会话有意义的任务放会话层，用完即弃，经得起用的再提升到文件层；
4. **人与 Agent 共用同一套定义**——人固化一次，Agent 在任何会话里都能调用；Agent 在工作中固化的任务，人点开就能复跑。

输出不只是文本：实时流式出现在 run tab 工作区，状态徽章一眼可读；失败即停、随时重跑；重复触发不会起重复实例，而是定位到正在跑的那个；把任务或某次运行以 chip 引用发给 Agent，就能接着输出继续追问。

高危任务还有一层 VS Code Tasks 没有的东西：**审批闸门**——标记过的任务，无论人点还是 Agent 调，都要经过你的显式确认才会启动。

配置的唯一来源是独立的 `actions.json`（JSONC）——不提供、也不计划提供对其他任务格式的运行时导入或桥接。

> **现状**：Agent 侧的主动发现目前还比较弱。任务清单不会自动进入 Agent 的上下文，它得先自己调 `actions_list` 才知道有哪些任务。「在会话框直接触发一次运行、把结果回插进对话」也还没做。眼下的状态是——**被人引用时很顺，主动发现并调用还谈不上**。让 Agent 更主动地发现和使用这批任务，是接下来的主要方向。

## 目录

- [界面](#界面)
- [安装](#安装)
- [30 秒跑通](#30-秒跑通)
- [一份配置，两个面](#一份配置两个面)
- [使用场景](#使用场景)
- [三层设计](#三层设计)
- [项目起源](#项目起源)
- [文档地图](#文档地图)
- [包身份](#包身份)
- [致谢](#致谢)
- [License](#license)

## 界面

| 右侧栏入口 | 面板总览 | 参数 Modal |
| --- | --- | --- |
| ![开始页的 Actions 卡片](https://raw.githubusercontent.com/pure-craft/dsh-actions/main/docs/assets/guide-entry.png) | ![三层分区的任务面板](https://raw.githubusercontent.com/pure-craft/dsh-actions/main/docs/assets/panel-overview.png) | ![带参数的任务运行前弹出参数 Modal](https://raw.githubusercontent.com/pure-craft/dsh-actions/main/docs/assets/params-modal.png) |
| **运行输出** | **`/actions:` 引用菜单** | **Agent 审批流** |
| ![run tab 工作区的实时输出](https://raw.githubusercontent.com/pure-craft/dsh-actions/main/docs/assets/run-output.png) | ![输入 / 选择任务，引用进对话](https://raw.githubusercontent.com/pure-craft/dsh-actions/main/docs/assets/slash-menu.png) | ![Agent 调用带审批的任务：引用 → 加载 skill → 尊重审批 → 人工闸门](https://raw.githubusercontent.com/pure-craft/dsh-actions/main/docs/assets/agent-approval-flow.png) |

## 安装

用 DSH 自己的插件命令装，然后重启：

```bash
dsh plugin --profile web add dsh-actions
# 重启 DSH Web
```

这条命令做三件缺一不可的事：先按你的 DSH 版本做插件兼容性预检（版本不匹配会直接拒绝，并告诉你怎么放行），再用 profile 自己的 pnpm 安装依赖，最后把声明了 `dsh.bundle` 的包登记进 `dsh.profile.bundles`——没登记就不会被加载。

别在 `~/.dsh/profiles/web` 里直接 `npm install`：那个目录由 pnpm 管理，而且裸装会跳过 bundles 登记，包进了 `node_modules` 却永远不会被加载。

**从源码安装（仅开发本插件时）**：clone 本仓库后——

```bash
dsh plugin --profile web add /path/to/dsh-actions
```

装好后打开右侧栏的「开始」页，Actions 卡片就在那里。

### 版本要求

需要 DSH `>= 0.1.7-alpha.1`（写在 `peerDependencies` 里，安装时 DSH 会拿你的运行时版本逐条校验）。registry 上的 `latest`（`0.2.0-rc.2`）已满足这个下界，**直接装即可，不用切通道**。

版本不匹配时安装会被**直接拒绝**（提示 `nothing was installed`），并给出放行命令：

```bash
dsh plugin allow-version dsh-actions@<版本> --dsh-version <你的 DSH 版本> --accept-risk
```

放行只针对那一对确切的版本，且意味着你接受崩溃或数据损坏的风险——插件会加载进正在跑的 Web UI。正常情况下应该升级 DSH，而不是放行。

<details>
<summary><strong>下界为什么定在 0.1.7-alpha.1（可自行核实）</strong></summary>

因为插件在 0.1.5 上**跑不起来**，声明一个它撑不住的下界只会让人装上之后界面报错。

界面半边只从 `@deepseek-ai/dsh-client-ui-primitives` 取具名导出，一共 31 个。该包在 `0.1.6-alpha.2 → 0.1.7-alpha.1` 之间把整套图标**改了名**（`IconCheckOutline16` / `IconCheckOutline14` → `IconCheckOutlineRegular`），并新增了 `Checkbox`。所以 0.1.5-rc.3 上这 31 个里有 **20 个不存在**，React 拿到 `undefined` 当组件渲染会直接抛异常——而这些图标用在面板和 toolview（对话里的工具卡片）两处，崩起来是整个界面的问题。

版本号里看不出这一层，所以下界是**扫出来的**，不是推出来的。clone 本仓库后，任何一个版本都可以自己核实（该脚本是开发工具，不随 npm 包分发）：

```bash
node scripts/verify-floor.mjs 0.1.7-alpha.1   # 通过
node scripts/verify-floor.mjs 0.1.5-rc.3      # 列出缺失的 20 个
```

</details>

## 30 秒跑通

在工作区根目录写 `.dsh/actions.json`：

```jsonc
{
  "version": "1.0.0",
  "actions": [
    { "label": "check", "command": "pnpm check", "detail": "类型检查 + lint + 全部测试" }
  ]
}
```

`detail` 那一行不是可选装饰：它同时显示在面板和 `actions_list` 的返回里，**Agent 靠它判断这是不是它要找的任务**。

打开右侧栏「开始」页的 **Actions** 卡片，点 `check` 旁的运行——输出在下方的 run tab 工作区实时流出。这就是完整闭环：写配置 → 面板点击 → 看输出。保存配置文件即自动生效，无需刷新。

## 一份配置，两个面

同一个 `actions.json`，对人和对 Agent 是两种用法，背后是同一份定义——不是两套东西互相同步：

|  | 怎么发现 | 怎么用 |
| --- | --- | --- |
| **人** | 右侧栏 Actions 面板 | 一次点击；带参数的弹出表单；输出流式可见 |
| **Agent** | `actions_list` | 调用 `actions_run`，结构化返回结果 |

Agent 侧一共 6 个工具：`actions_list` / `actions_run` / `actions_inspect` / `actions_cancel` / `actions_set_params` / `actions_register`，语义与取舍见 [Agent 集成](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.md)。其中 `actions_register` 把会话中发现的流程注册成会话层任务，**必经你批准**——Agent 给自己造可执行命令属高危操作。

插件还随包带了一个 `dsh-actions-authoring` skill：你让 Agent 写 `actions.json` 时，它自己就会拿到全字段参考和策展指导，不用你翻文档。

## 使用场景

三个典型场景各有详述文档：

- **[策展散落的脚本入口](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/01-curate-scripts.md)**：npm scripts / Makefile / Taskfile / `scripts/` 目录太分散？让 Agent 一次性策展固化成 `.dsh/actions.json`，面板与 Agent 共用统一入口，原始入口一个都不动；
- **[打通 CI/发布流水线](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/02-ci-pipeline.md)**：以 Jenkins 为例，把平台 API 固化成 Actions——触发构建、查询状态、参数化发布（`inputs` + `approval` 的真实用法）；
- **[会话草稿本](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.md)**：只在当前会话有意义、但需要反复执行的临时任务，Agent 注册、随用随弃、用得好再提升到文件层。

更完整的示例（`runOptions`、`inputs`、`approval`）见[配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md)。

> 欢迎补充：告诉我们你是怎么用的、你有什么需求——场景库会随真实用法持续生长。

## 三层设计

同一个动作，放在哪一层决定了**谁能看到它、它活多久**——这是 DSH Actions 最有特色的设计。三层按优先级 `全局 < 工作区 < 会话` 逐字段合并，同名时上层胜出：

| 层 | 位置 | 谁能看到 | 生命周期 | 典型用途 |
|---|---|---|---|---|
| **全局** | `~/.dsh/actions.json` | 你的所有工作区 | 跟随文件 | 个人习惯命令（查版本、查磁盘、开常用工具） |
| **工作区** | `<workspace>/.dsh/actions.json` | 该工作区的所有人与 Agent | 随目录/仓库提交 | 项目的 build/test/部署——新同事 clone 即有全套 |
| **会话** | 会话自己的目录 | 仅当前会话 | 会话结束即归档 | 临时任务；以及聚合目录下本会话实际涉及的仓库 |

三层不是并列的三个配置，而是一条**任务的成长路径**：

```text
会话层（Agent 随手固化）  ──提升──▶  工作区层（团队共享）  ──提炼──▶  全局层（个人通用）
   用完即弃                    随仓库走                     跨项目复用
```

- **合并而非隔离**：工作区可以在全局的同名任务上只改一个字段（比如覆盖 `command` 加参数、或补一个 `detail`），其余字段继承；
- **会话层由 Agent 写入**：`actions_register` 注册必经你的批准；你觉得好用的，一句话提升到文件层变成长期资产；
- **人的同一面板**：三层任务在同一个列表里分区展示，运行方式完全一致——来源只是元信息，不是使用门槛。

### 一个工作区包含多个仓库

如果会话工作区是若干 Git 仓库的上层目录，不必把所有仓库的任务复制到根配置。每个仓库继续维护自己的 `.dsh/actions.json`，当前会话只在自己的配置里记录本次涉及的目录：

```jsonc
{
  "version": "1.0.0",
  "folders": ["frontend", "services/api"],
  "actions": []
}
```

`folders` **仅在会话层有效**，含义只有一个：额外加载这些目录各自的 `.dsh/actions.json`。它是会话的动态目录选择，不参与三层继承、并集或覆盖；根工作区和全局 Actions 仍照常加载。不同会话可以选择不同目录，也不会改写上层目录或仓库中的共享配置。

字段级细节见 [配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md)，会话层的存储与生命周期见 [会话层](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.md)。

## 项目起源

日常工作中经常会遇到需要反复执行的步骤或流程。每次临时组织这些步骤，开始时看起来很方便，但执行结果可能不稳定，也难以可靠复现。把它们固定成 CLI、MCP 服务或自定义 Slash Command，虽然获得了复用能力，却也可能过早固化接口，使后续持续调整和优化变得笨重。

把脚本放进 Agent Skill 则走向了另一个方向：它足够灵活，也可以由 Agent 推动演进，但这意味着脚本的完整生命周期需要由 Agent 主导。这样的脚本不容易作为项目的共享能力被统一发现、治理和维护，也很难把完全相同的工具同时暴露到 Web UI，让人可以直接发现和使用。

| 固化方式 | 能复用 | 人可发现 | 代价 |
|---|---|---|---|
| 每次临时组织 | ✕ | ✓ | 结果不稳定、难以复现 |
| CLI / MCP / 自定义 Slash Command | ✓ | 部分 | 接口过早固化，后续调整笨重 |
| Agent Skill | ✓ | ✕ | 生命周期归 Agent，统一发现与治理缺位 |
| 项目内的 `actions.json`（本方案） | ✓ | ✓ | 每次改动都要走一遍 git |

这构成了 DSH Actions 的起点。我们设想的方案在一个重要方面与 Apple 快捷指令、VS Code Tasks 和 GitHub Actions 相似：使用一份跟随工作区的定义来描述可重复执行的 Action 或流程。这份定义既可以由人有意识地持续改进，也可以在 Agent 驱动下逐步演进，同时保持可审查、可管理。随后，同一个 Action 以两种形态对外提供：

- 作为结构化工具，供 Agent 发现和调用；
- 作为 DSH Web 中的可视化界面，供人查看和操作。

Skills 和 MCP 已经为面向 Agent 的能力提供了很好的实现范式。Agent 不需要一开始就在上下文中获得所有实现细节：系统可以先提供有限、精炼的能力描述，只在真正需要时渐进式披露参数、约束、执行细节和结果。DSH Actions 希望把这种渐进式披露方式用于项目中的可重复操作，同时避免让 Agent 成为这些脚本生命周期的唯一所有者，也不把人排除在同一套工具之外。

由此留下的一个开放问题，也是这个项目到现在没想明白的：**脚本的生命周期，应该由人拥有、由 Agent 拥有，还是共享？** 放进 Agent Skill，演进快，但人失去统一入口和治理能力；放进项目配置，可审查可共享，但每次改动都要走一遍 git。DSH Actions 押的是第三条路——代价是**人和 Agent 都得学会在同一份文件上协作**。这条路对不对，得等真实用法来验证。

## 文档地图

文档均为中英双语：中文为 `.md`，英文为同名 `.en.md`，放在同一目录下。完整索引见 [docs/README.md](https://github.com/pure-craft/dsh-actions/blob/main/docs/README.md)。

**场景**（什么时候用、怎么用）：

- [策展散落的脚本入口](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/01-curate-scripts.md)（[English](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/01-curate-scripts.en.md)）
- [打通 CI/发布流水线（Jenkins 示例）](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/02-ci-pipeline.md)（[English](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/02-ci-pipeline.en.md)）
- [会话草稿本（会话级临时任务）](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.md)（[English](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.en.md)）

**功能**（分主题的细节参考）：

- [配置参考：actions.json 全字段](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md)（[English](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md)）
- [Actions 面板](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.md)（[English](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md)）
- [Agent 集成](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.md)（[English](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.en.md)）
- [会话层](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.md)（[English](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md)）

> 注：`AGENTS.md` 是本地贡献指南，不对外分发（既不在 git 仓库，也不随 npm 包发布）；路线图、待办与设计调研为团队私有文档，同样不在公开仓库中。

## 包身份

| | |
|---|---|
| 产品 | **DSH Actions** |
| 仓库 | `pure-craft/dsh-actions` |
| npm 包 | `dsh-actions` |
| Cordis 插件 id | `dsh-actions` |

## 致谢

`actions.json` 的字段设计、逐条容错与实例复用语义，参考了 [VS Code Tasks](https://code.visualstudio.com/docs/editor/tasks)（tasks.json v2）并精简为子集；Action / Run 这套产品语言——执行状态、日志、运行历史、受控自动化——参考了 [GitHub Actions](https://docs.github.com/en/actions)。

三层合并与会话层是两者都没有的：那一部分是为了让同一份定义**既能被人点击、又能被 Agent 调用**才加的。字段全集与本项目的有意差异见 [配置参考](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md)。

## License

MIT
