# 课桌 Android

USB 真机已验证：Android 13 上认证读取、Keystore 跨进程保存、通知及空闲后重连通过；修复 GET 自动重连后，本机测试为 43 项。见 [真机记录](../../docs/verification/2026-11-03-usb.md)。实际批准写表与长期锁屏仍待验收。

0.2.0 新增“早报”页：公开技术资讯与重大事件的 AI 中文摘要、原文链接、来源覆盖、今日生成及每日时间/时区设置。最新手机端 41 项测试，见 [早报验证](../../docs/verification/2026-11-03-briefing.md)。早报生成在电脑端运行，默认关闭定时，需要连接更新后的后台后在“早报 → 定时设置”开启。

原生 Kotlin + Jetpack Compose 客户端。整体计划见 [实施文档](../../docs/android-implementation.md)。

## 已实现功能

- 待处理：候选来源与摘要、保留/忽略、文档待审批和待补资料任务。
- 任务详情：单元格原值/拟填值、计划版本、身份定位方式、警告、问答、批准二次确认、取消与状态轮询。
- 待办：正式待办只读列表。
- 设置：主机地址、Keystore 加密访问令牌、健康及认证检查、清除本机连接。
- 用户启动的后台同步与通知：默认 25 秒，失败退避、通知去重、详情跳转、权限撤销/认证失败停止、系统超时退出。
- debug 默认进入离线演示，示例数据只在内存中。release 源集不包含演示数据。

App 不持有 QQ 登录，不在手机直接写腾讯文档；批准后由电脑执行。系统通知使用通用文案，不显示字段值。聊天、计划和资料只在界面/内存中使用，不做请求日志。

## 本机构建

在项目根目录运行：

```powershell
.\tools\build-android.ps1
```

脚本依次执行 Android JVM/Robolectric 测试、lint 和 debug APK 构建，并输出 APK 路径及 SHA256。首次运行会下载依赖与 Robolectric Android 运行库；依赖齐全后可加 `-Offline`。测试会用 Node 启动临时内存后端，需 Node 24+ 在 PATH。

可用 `-JavaHome`、`-AndroidSdk`、`-GradleCache` 指定工具目录。脚本仅生成被忽略的构建产物与本机 SDK 路径，不读取本项目 `.private/`，不启动真实账号或表格写入。

产物：`app/build/outputs/apk/debug/app-debug.apk`。这是调试签名的测试包；不应作为正式分发包。编译 SDK/目标 SDK 36，最低 Android 8.0（API 26）。

## USB 连接（之后有设备时）

电脑运行后端、手机开启 USB 调试并连接后，在电脑执行：

```powershell
adb reverse tcp:9087 tcp:9087
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

第一条将手机 9087 转发到电脑后端；第二条安装或更新 App，`-r` 保留现有应用数据。手机设置中关闭演示、保留默认地址 `http://127.0.0.1:9087`，填写本机后端访问令牌并保存，再测试连接。令牌不能通过聊天、公开日志或提交分发。

目前后端只监听电脑回环地址。USB 断开后，默认地址无法访问电脑；本版没有远程访问、设备配对或独立设备令牌。release 禁止明文 HTTP，当前 USB 路线使用 debug 包。

## 验证层级

- 纯 Kotlin / MockWebServer：接口解析、身份计划规则、请求摘要、401/409、重定向、网络结果、通知去重与退避。
- 合约：真实 `createV2Handler` + SQLite 内存库 + Android HTTP 客户端；所有数据合成，无 worker 和真实写表。
- Robolectric：本机 Android 模拟运行库中的 Compose 页面交互；不等于模拟器或真机。
- 真机待验：Keystore 重启持久化、权限弹窗、USB 连接、通知点击、锁屏、国产 ROM 后台策略及真实审批。

列表受现有后端限制：最多 100 条当前候选、200 条最近任务。首次同步默认不提醒旧数据，可在设置调整。正在待审批的计划版本变化只更新界面，不重复提醒。应用进程被杀后不会自行重启同步。

Android 15+ 的 dataSync 前台服务存在时长限制，本版收到超时会停服务，不能保证全天实时通知。后续远程访问和可靠推送需另行设计。

## 目录

`app/src/main/.../data`：DTO、HTTP、设置与加密存储；`domain`：审批和通知纯逻辑；`ui`：Compose 与 ViewModel；`sync`：前台服务；`app/src/debug`：演示；`app/src/test`：自动测试。

最新验收结果见 [手机端验证记录](../../docs/verification/2026-11-03-android.md)。旧 Android 设计中的依赖版本要求 SDK 37，本次按实际构建证据改用 SDK 36 兼容依赖，详见验证记录。
