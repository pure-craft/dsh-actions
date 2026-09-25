# 场景：打通 CI/发布流水线（以 Jenkins 为例）

> 返回 [README](../../README.md) ｜ 相关：[配置参考](../features/configuration.md)（inputs / approval 完整语义）｜ 场景：[桥接脚本入口](01-bridge-scripts.md) ｜ [会话草稿本](03-session-scratchpad.md)

## 痛点

构建在 Jenkins 上、发布在另一个系统上：触发一次构建要开浏览器、登平台、找任务、点按钮；查状态要反复刷新页面；发布更是要瞪大眼睛确认环境没选错。这类平台调用其实都是固定的 API 脚本——适合固化成 Actions，人和 Agent 共用。

## 做法

把平台 API 封装成脚本（`scripts/jenkins.mjs` 之类），在**全局层**定义一次，所有工作区可用；用 `inputs` 参数化，用 `approval` 保护高危步骤：

```jsonc
{
  "version": "1.0.0",
  "actions": [
    {
      "label": "ci-build",
      "command": "node scripts/jenkins.mjs build --job ${input:job}",
      "detail": "触发 Jenkins 构建",
      "inputs": [
        { "id": "job", "type": "string", "description": "Jenkins job 名", "required": true }
      ]
    },
    {
      "label": "ci-status",
      "command": "node scripts/jenkins.mjs status --job ${input:job}",
      "detail": "查询最近一次构建状态",
      "extends": "global:ci-build",   // 继承 inputs 声明，只换子命令
      "presentation": { "panel": "append" }
    },
    {
      "label": "ci-release",
      "command": "node scripts/jenkins.mjs release --job ${input:job} --env ${input:env}",
      "detail": "发布到指定环境",
      "approval": "always",            // 高危：人与 Agent 触发都要显式批准
      "inputs": [
        { "id": "job", "type": "string", "required": true },
        { "id": "env", "type": "select", "options": ["staging", "production"], "default": "staging" }
      ]
    }
  ]
}
```

凭据不进配置文件：脚本内读 `JENKINS_TOKEN`，配置里用 `${env:JENKINS_TOKEN}` 传递。

## 运行时的真实节奏

- **触发构建**：面板表单填 job 名（或 Agent 带 `params` 调用），输出实时流出；
- **查状态**：`append` 档让每次查询接在上次下方，形成一条状态时间线；
- **参数化发布**：`select` 下拉把环境收敛到合法取值，`approval: "always"` 保证点错不了——人触发弹确认框，Agent 触发先问你；
- **本周都在验 staging**？把 `env=staging` 固定到本会话（表单勾选 / `actions_set_params`），之后免逐次填写，会话结束自动消失；
- **要一个"发布到 staging"的专用入口**？让 Agent 用 `actions_register` + `extends: "global:ci-release"` + `params: { env: "staging" }` 注册会话级变体（注册必经你批准），用得好再提升到全局层。

## 边界

插件永不内置具体平台——Jenkins/禅道类的集成统一走本场景的轻度路径：API 脚本 + inputs + approval，零新代码（平台深度集成包的方向已评估否决）。
