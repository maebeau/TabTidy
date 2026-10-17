# 自动重连与浏览器来源选择

Status: ready-for-agent
State: closed

规格见 [spec.md](../spec.md)。

## Comments

- 2026-10-18：用户确认实现“首次配对一次，以后自动重连；桌面显示 Chrome / Edge 来源及连接状态，可选择全部或单个来源”。已授权修改。
- 原行为已通过实际扩展脚本的模拟接口复现：桌面不可用时同步失败，桌面恢复后无自动重试，手动同步才恢复。连接码已有持久化，因此本次复用配对信息并补齐浏览器闹钟恢复流程。
- 方案：扩展 0.3.0 注册 30 秒周期的浏览器闹钟，未配对不创建；后台启动检查并重建。断线后重新同步再恢复指令连接，不重放关闭。要求 Chrome / Edge 120 及以上，调度、超时、休眠可能使实际重连延后。
- 桌面 0.5.0 增加全部或单个配置来源选择及连接状态；统计和关闭清单遵循当前范围，切换保留手动选择。桥接按同步递增快照编号，仅连接变化时只更新来源信息，保留候选组节点及焦点。
- 回归：已通过 35 项测试及正式 Electron 桌面测试，覆盖未配对、首次离线、桌面重启、后台重启、闹钟丢失、来源稳定、关闭不重放、连接断开状态、状态更新不重建列表、来源筛选统计与关闭隔离、隐藏选择保留。
- API 依据：[扩展后台生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[浏览器闹钟](https://developer.chrome.com/docs/extensions/reference/api/alarms)。采用浏览器闹钟恢复，避免仅使用可能随后台休眠消失的定时器。
- Windows 便携包已生成，包内 HTML / CSS / renderer / bridge / README 及扩展文件与源码一致；桌面元数据及 EXE 的 ProductVersion / FileVersion 均为 0.5.0，扩展为 0.3.0，最低浏览器版本及 alarms 权限已核对，ZIP 完整性检查通过。界面截图已检查。
- 限制：浏览器接口与闹钟事件使用模拟接口验证，桌面交互在 macOS Electron 验证，未做 Windows 实机 Chrome / Edge 安装与后台唤醒验证。用户须更新并重新加载扩展一次，现有配对信息保留。
