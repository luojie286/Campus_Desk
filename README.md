# 校园个人助手

接手入口：[HANDOFF.md](HANDOFF.md)。可直接发送给 DeepSeek 的提示：[DEEPSEEK_PROMPT.md](DEEPSEEK_PROMPT.md)。

当前阶段：消息中心与文档审批后端 + 桌面 Web MVP。已有的真实平台证据仍是“真实 QQ 历史消息 → 腾讯文档链接 → SQLite 资料 → 无头填表 → 新进程回读”闭环；新增的 PDF 提取、任务审批和桌面界面目前只完成单元/API/构建验证，真实 QQ 文件和新链路端到端验收仍待进行。

## 现在能做什么

- 指定来源的 QQ 消息入库、去重、规则分类；文档链接直接创建填写任务，不经过待办。
- 聊天/文件消息由 LLM 生成待办候选；PDF 下载到 `.private/files`，提取文字后再总结；扫描件无文字时明确标记，不做 OCR。
- 文档任务准备：读表、定位身份、生成计划、缺字段问答、待审批状态。
- 审批后执行：文档锁、写前复核、写入、独立回读；写入中断进入 `outcome_unknown`，不会自动重写。
- 桌面 Web MVP：消息中心、待办清单、审批请求、计划差异和批准/取消。

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

## 当前结论

2026-10-30 已完成真实群消息验收：指定 QQ 群消息经 NapCat HTTP 进入后台；真实 PDF 完成下载、文字提取和待办候选；真实腾讯文档完成“任务 → 计划 → 审批 → 写入 → 回读”，包括仅学号匹配和新增行两种身份模式。验证记录只保留任务号、状态和脱敏后的字段数量，不记录真实姓名、学号或文档内容。

真实消息验证通过后，配置已切到 `v2`，避免同一文档链接同时产生旧 run 和新任务。Tauri 2 Windows 壳已生成并通过启动检查，令牌改存 Windows Credential Manager；Android 原生端仍待完成。
