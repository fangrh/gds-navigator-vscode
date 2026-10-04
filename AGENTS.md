# AGENTS.md

本仓库运行在 research-triz 技能系统上：每个操作先路由 `routes.yaml`，
会话收尾与 Skill 反馈写入 `ISSUES.md`，操作日志在 `logs/`（已 gitignore）。
入口技能：`using-triz`。

## Agent-owned application shutdown

After using a test-owned browser or isolated VS Code instance, verify that its
main process and helper processes have exited. Automation uses
`scripts/process-cleanup.cjs`: `closeOwnedBrowser` for launched browsers and
`closeOwnedProcess` with the unique profile directory for VS Code.
The cleanup must finish before reporting completion or removing its temporary
workspace; retain the workspace if shutdown cannot be verified. Close only
agent-owned instances or tabs and preserve the user's other windows.
