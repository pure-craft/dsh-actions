# Scenario: wiring up a CI/release pipeline (Jenkins example)

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/02-ci-pipeline.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: [Configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md) (full `inputs` / `approval` semantics) ｜ scenarios: [Curating scattered script entry points](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/01-curate-scripts.en.md) ｜ [Session scratchpad](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.en.md)

## The pain

Builds run on Jenkins, releases happen in another system: triggering a build means opening a browser, logging into the platform, finding the job, clicking the button; checking status means refreshing the page over and over; and releasing means staring hard at the screen to confirm the environment is the right one. These platform calls are really just fixed API scripts — a good fit for pinning down as Actions, shared by people and agents.

## How

Wrap the platform API in a script (`scripts/jenkins.mjs` or similar), define it once in the **global layer** so every workspace can use it, parameterize with `inputs`, and protect the high-risk step with `approval`:

```jsonc
{
  "version": "1.0.0",
  "actions": [
    {
      "label": "ci-build",
      "command": "node scripts/jenkins.mjs build --job ${input:job}",
      "detail": "trigger a Jenkins build",
      "inputs": [
        { "id": "job", "type": "string", "description": "Jenkins job name", "required": true }
      ]
    },
    {
      "label": "ci-status",
      "command": "node scripts/jenkins.mjs status --job ${input:job}",
      "detail": "query the latest build status",
      "extends": "global:ci-build",   // inherits the inputs declaration, swaps the subcommand
      "presentation": { "panel": "append" }
    },
    {
      "label": "ci-release",
      "command": "node scripts/jenkins.mjs release --job ${input:job} --env ${input:env}",
      "detail": "release to the given environment",
      "approval": "always",            // high risk: both a person and an agent need explicit approval
      "inputs": [
        { "id": "job", "type": "string", "required": true },
        { "id": "env", "type": "select", "options": ["staging", "production"], "default": "staging" }
      ]
    }
  ]
}
```

Credentials never go into the config file: the script reads `JENKINS_TOKEN`, and the config passes it through as `${env:JENKINS_TOKEN}`.

## What it feels like at run time

- **Trigger a build**: fill in the job name in the panel form (or have the agent call with `params`); output streams live;
- **Check status**: the `append` mode puts each query below the previous one, forming a timeline of status;
- **Parameterized release**: the `select` dropdown narrows the environment to legal values, and `approval: "always"` means you cannot click wrong — a person gets a confirmation dialog, an agent asks you first;
- **Spending the week validating staging?** Pin `env=staging` to the session (checkbox in the form, or `actions_set_params`) and you never fill it in again; it disappears when the session ends;
- **Want a dedicated "release to staging" entry?** Have the agent register a session-level variant with `actions_register` + `extends: "global:ci-release"` + `params: { env: "staging" }` (registration always needs your approval), then promote it to the global layer if it earns its keep.

## Boundaries

The plugin never bundles a specific platform. Jenkins/ZenTao-style integrations all go through the light path in this scenario: API script + inputs + approval, zero new code (the direction of deep platform integration packages was evaluated and rejected).
