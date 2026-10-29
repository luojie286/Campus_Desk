# 校园个人助手

接手入口：[HANDOFF.md](HANDOFF.md)。可直接发送给 DeepSeek 的提示：[DEEPSEEK_PROMPT.md](DEEPSEEK_PROMPT.md)。

当前阶段：最小技术原型验证。已通过“真实 QQ 历史消息 → 腾讯文档链接 → SQLite 资料 → 无头填表 → 新进程回读”闭环，实时新消息和长期运行仍待验证。最新证据见 [后台验证记录](docs/verification/2026-10-29-background.md)。完整产品设计留待后续。

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

## 当前结论

指定 QQ 好友历史消息到腾讯在线表格的真实后台闭环已通过；本地模拟与界面点击不作为该结论的证据。实时新消息回调和群聊需另行验证。

下一步验证 example-contact 新消息实时触发及长期运行；当前程序从 SQLite 读取个人信息，仅允许配置中的测试表和来源。群聊替换、多平台和安卓客户端后续推进。
