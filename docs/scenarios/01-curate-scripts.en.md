# Scenario: curating scattered script entry points

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/01-curate-scripts.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: [Configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md) ｜ scenarios: [CI pipeline](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/02-ci-pipeline.en.md) ｜ [Session scratchpad](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.en.md)

## The pain

The commands you can run already exist — they are just scattered: scripts in `package.json`, a Makefile, a Taskfile, scripts in a `scripts/` directory… Scattered entry points mean nobody remembers all of them, and the agent has to go digging again every time. DSH Actions does not build a runtime adapter for those formats (explicitly rejected); it offers a one-shot answer instead: **curate and pin them down**.

## How

Have the agent do one scan-and-curate pass and pin the common tasks down into `.dsh/actions.json`:

1. In the empty state, click "have the agent create it for me" in the section header — the attached prompt draft is exactly this: have the agent scan `package.json` scripts, the Makefile, the Taskfile and other entry points, then curate them into the config;
2. Or just say it in the session: "turn this repo's common script entry points into DSH Actions".

Afterwards every task has a unified `label` / `detail` / run policy, and the original script entry points stay untouched (an Action's `command` merely calls them).

## What you get

- **One entry point**: the same list shows up both in the panel (one click for a person) and as agent tools (discoverable and callable via `actions_list`);
- **Curation on the way**: this is the moment to add the missing `detail` descriptions, mark exclusive tasks `runOptions.instancePolicy: "reject"`, and mark high-risk tasks with `approval` — behavioral constraints the original format could not express all have a place in `actions.json`;
- **Room to evolve**: the definition follows the repo, reviews go through the normal git flow, and the agent can keep improving it afterwards.

## Example

```jsonc
{
  "version": "1.0.0",
  "actions": [
    // bridging npm scripts
    { "label": "check", "command": "pnpm check", "detail": "typecheck + lint + full test suite" },
    // bridging a Makefile target
    { "label": "proto", "command": "make proto", "detail": "regenerate protobuf code" },
    // bridging a script in scripts/
    { "label": "release", "command": "node scripts/release.mjs", "detail": "tag and publish", "approval": "always" }
  ]
}
```

Note that this is a **one-shot curation, not a runtime bridge**: the plugin does not parse `package.json`/Makefile on every run — `actions.json` is the single source of project definitions (importing or bridging external formats was explicitly rejected).
