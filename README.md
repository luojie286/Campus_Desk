# 校园个人助手

私网连接：Android 0.3.0 已实现 Tailscale HTTPS 网关与邀请配对、独立设备令牌及撤销；本机真实后台只读联调通过，139 项后端、47 项手机端测试通过。当前 Tailscale 账号尚未启用 Serve，手机无线仍待验证。见 [连接方案与步骤](docs/private-network.md) 和 [本轮验证](docs/verification/2026-11-03-private-network.md)。

技术早报：Android 0.2.0 已新增每日技术资讯与重大事件摘要，支持定时设置、来源链接和历史阅读。见 [功能设计](docs/morning-briefing.md) 与 [最新验证](docs/verification/2026-11-03-briefing.md)。默认不自动开启主机定时。

2026-11-03：Android 原生审批客户端已实现，见 [整体实施计划](docs/android-implementation.md) 与 [手机端运行说明](mobile/android/README.md)。USB 真机认证读取、Keystore 跨进程读取与通知可见已验证；长期锁屏与真实手机审批仍待验收。

接手入口：[HANDOFF.md](HANDOFF.md)。可直接发送给 DeepSeek 的提示：[DEEPSEEK_PROMPT.md](DEEPSEEK_PROMPT.md)。

当前阶段：消息中心、候选合并与文档审批后端 + Web/Tauri 桌面端。真实群消息、PDF 提取、文档审批写入和回读已在 2026-10-30 验证；多消息过滤/合并已完成本地测试，尚待真实群聊复测。

## 现在能做什么

- 指定来源的 QQ 消息入库、去重、规则分类；桌面端可添加群聊/好友监听对象，显示群名、群备注和好友备注。
- 文档适配器预留腾讯文档、WPS/金山文档和飞书表格接口；当前只实现腾讯文档，其他平台不创建任务。
- 文本消息和已提取的 PDF/DOCX 文字进入同一会话批次：先做本地寒暄过滤，再由会话级 LLM 过滤无行动价值的闲聊；同一事务的多条来源通过 `thread_key` 合并成一个候选。
- 接受候选时，所有来源消息都会关联到同一个 todo；候选详情显示合并来源。
- PDF/DOCX/图片附件下载到 `.private/files`：PDF/DOCX 提取文字，图片用本地 Tesseract OCR；不支持的格式会忽略并生成站内通知，旧式 `.doc` 明确显示不支持。
- 文档任务准备：读表、定位身份、生成计划、缺字段问答、待审批状态。
- 审批后执行：文档锁、写前复核、写入、独立回读；写入中断进入 `outcome_unknown`，不会自动重写。
- 恢复入口：结果未知任务可在桌面发起只读核对；登录暂停和写前可重试任务可重新准备，之后仍需重新审批才会写入。
- 桌面端：消息中心、待办清单、审批请求、计划差异和批准/取消；提供 Tauri 2 Windows 壳。

## 运行

```powershell
npm start                 # 后台服务，默认 http://127.0.0.1:9087
npm run desktop:dev       # 桌面 Web，默认 http://127.0.0.1:5173
npm test                  # 后端测试
npm run desktop:build     # 桌面构建
```

桌面端说明见 [desktop/README.md](desktop/README.md)：包含 React/Vite Web MVP 和 Tauri 2 Windows 壳；Tauri 使用 Windows Credential Manager 保存访问令牌。

## 文档导航

- [最小技术测试](docs/minimal-poc.md)：当前优先范围、组件、处理流程和通过标准。
- [账号切换与重登](docs/account-switching.md)：专用 QQ、同号重新登录、独立文档会话及写入暂停规则。
- [原型实现与验证](docs/poc-implementation.md)：代码入口、运行命令、真实验证结果及剩余条件。
- [真实后台接入进展](docs/verification/2026-10-29-background.md)：QQ 好友列表、真实历史消息、链接提取和去重的实测证据。
- [原始课程说明](PRD.md)：保留实验原文。
- [已确认需求基线](docs/requirements.md)：用户在 2026-10-28 确认的目标、流程、操作边界与范围。
- [技术可行性分析](docs/feasibility.md)：公开资料、本机只读检查、能力限制及概念验证方案。
- [架构草案](docs/architecture.md)：模块、状态、数据边界、执行与迁移方案；接入选型尚待实测。
- [后台技术设计](docs/backend-design.md)：2026-10-29 修订，含后台接入、数据契约、任务恢复、App API 和平台验证门槛。
- [术语表](CONTEXT.md)：已统一的业务词汇。
- [2026-10-29 技术验证记录](docs/verification/2026-10-29.md)：实际执行结果及等待条件；与文档研究结论分开记录。
- [2026-10-30 真实消息与审批验证](docs/verification/2026-10-30.md)：群消息、PDF 提取、仅学号匹配、审批写入和回读证据。
- [2026-10-31 DOCX 验证](docs/verification/2026-10-31-docx.md)：真实 Word 附件提取、状态展示和不支持格式边界。

## 当前结论

2026-10-30 已完成真实群消息验收：指定 QQ 群消息经 NapCat HTTP 进入后台；真实 PDF 完成下载、文字提取和待办候选；真实腾讯文档完成“任务 → 计划 → 审批 → 写入 → 回读”，包括仅学号匹配和新增行两种身份模式。验证记录只保留任务号、状态和脱敏后的字段数量，不记录真实姓名、学号或文档内容。

真实消息验证通过后，配置已切到 `v2`，避免同一文档链接同时产生旧 run 和新任务。Tauri 2 Windows 壳已生成并通过启动检查，令牌改存 Windows Credential Manager；Android 当前进度见页首和手机端运行说明。
