# 独立的相似标签页 core

Status: ready-for-agent
State: closed

规格见 [spec.md](../spec.md)。

交付：无依赖的公开入口、JSON 命令行、示例数据、行为测试和使用说明。

## Comments

- 用户已确认本地 Markdown、默认任务状态与 AGENTS.md，并授权开始 core。
- 从单一公开入口进行行为验证，浏览器接入另行安排。
- 2026-10-18：已完成 core、JSON 命令行、示例与使用说明。
- 验证：`npm test` 共 11 项通过；语法与差异检查通过；时间排序示例输出符合规则。
- 独立审查：Standards 与 Spec 两项均未发现可操作问题。
- 尚未使用真实浏览器标题验证识别准确性；结果仍由人工确认。
