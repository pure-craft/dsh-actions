---
name: dsh-actions-authoring
description: Use whenever working with DSH Actions in either direction — writing or editing actions.json entries (adding a build/check/dev/test task to a project, choosing visibility/runOptions/presentation fields, declaring inputs 参数, marking approval 审批, extends 继承现有任务, 编写或修改 actions 配置、把项目任务固化到 .dsh/actions.json 或 ~/.dsh/actions.json), and also when running or managing project tasks through the actions_list/actions_run/actions_inspect/actions_cancel/actions_set_params/actions_register tools (启动项目任务、传 params 带参运行、用 actions_set_params 把参数固定到本会话、用 actions_register 把会话中发现的流程注册为会话级任务、查看运行输出、管理 dev server 等长驻服务、处理 already-running/rejected 冲突、处理 approval-declined 审批拒绝、重启或停止某个 run). Load this skill before authoring any action definition or driving the actions_* tools, even when the task looks simple — the conflict protocol and session scoping have non-obvious rules.
---

# DSH Actions authoring guide

DSH Actions discovers deterministic project actions from standalone `actions.json` files and exposes each one twice: as a visual entry in the DSH Web Actions tab (for people) and as the `actions_list` / `actions_run` / `actions_inspect` / `actions_cancel` / `actions_set_params` / `actions_register` tools (for agents). One definition serves both. This skill ships inside the `dsh-actions` package and always matches the installed plugin version.

Work with DSH Actions falls into two domains. Read the routing section, load the one reference your task needs, and keep the core constraints below in mind either way — they are the rules that bite in both domains.

## Core constraints (both domains)

- **Single definition source.** Actions are defined only in `~/.dsh/actions.json` (personal, global), `<workspace>/.dsh/actions.json` (shared, committed with the repo), and the session layer (written by `actions_register`, visible only to that session). There are no package.json/Taskfile/Makefile importers — never generate or "convert" those.
- **Version gate.** Every file must declare `"version": "1.0.0"`. It is an enum whitelist, not semver: any other value degrades the entire file with an `unsupported-version` error.
- **Session-scoped run state.** You only see your own session's runs. Another session on the same workspace may run the same action concurrently — that is normal, not a conflict. The human working in *your* session sees the runs you start appear in their Actions tab in realtime (and can cancel them).
- **Conflict protocol baseline.** The Host never interrupts an active instance implicitly. A duplicate run request returns a structured `already-running` (reuse) or `rejected` (exclusive) outcome — never a silently killed process. Stopping a run is always an explicit `actions_cancel` call; "stop and rerun" is two explicit calls, never one.
- **High-risk actions carry `approval`.** Anything destructive, deploying, or writing to external systems must declare `approval: "agent"` or `"always"` when authored, so no agent can start it silently. When a run returns `approval-declined`, respect the refusal — never retry on your own or route around the gate. Registering a session-layer action (`actions_register`) always asks the user first — an agent-authored command is high-risk by definition.

## Route to a reference

Pick the domain your current task belongs to and read only that file:

- **Writing or editing action definitions** (creating `actions.json`, adding/changing entries, choosing fields, deciding the layer, `extends` inheritance) → read [references/authoring.md](references/authoring.md): the full schema reference, merge semantics, variable substitution, and the unsupported-fields list.
- **Running or managing actions** (starting a task, following output, judging readiness, pinning params, registering session actions, handling conflicts, stopping or restarting runs) → read [references/operating.md](references/operating.md): the list → run → inspect → cancel rhythm, session-layer registration, long-running service management, and runId addressing.

The tool descriptions are the authoritative parameter reference. These files deliberately do not repeat them — they add the judgment the descriptions don't carry.
