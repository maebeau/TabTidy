# Windows 桌面版与 Chrome / Edge 同步扩展

Status: ready-for-agent
State: open

规格见 [spec.md](../spec.md)。

## Comments

- 2026-10-18：用户已选择读取运行中的浏览器，并确认桌面应用＋配套扩展方案，授权开始实现。
- 改动涉及桌面壳、渲染界面、本机传输、扩展、Windows 打包配置、测试与使用文档；既有 core 及 CLI 保持可用。
- Windows 打包工具使用命名导出；用户确认后修正导入并已成功生成 x64 PE 便携版。
- 审查发现同步重绘丢失键盘焦点、辅助文字对比度不足；用户确认后完成修复，真实窗口回归测试覆盖两项问题。
