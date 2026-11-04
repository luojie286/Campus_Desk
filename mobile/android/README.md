# 课桌 Android

Kotlin + Jetpack Compose 原生客户端，用于查看 QQ 消息整理出的候选、管理待办、补充资料和审批表格填写计划。当前版本为 0.5.0。

## 功能

- 候选保留/忽略；正式待办完成、恢复和二次确认删除。
- 展示计划中的原值、拟填值、身份定位、警告和缺失字段；批准填写需要再次确认。
- 技术早报阅读、来源链接和主机定时设置。
- Keystore 加密业务令牌，内嵌用户态 Tailscale 私网连接。
- 用户开启的后台同步与通知，失败退避和通知去重；不保证全天持续运行。

手机不直接操作 QQ 或在线表格，获批计划由电脑后台执行。debug 包含离线演示，使用合成数据；release 不包含演示数据。

## 构建

在仓库根目录运行：

```powershell
.	oolsuild-android.ps1
```

脚本运行手机端测试、lint 和 debug APK 构建。需要 Node.js 24+、JDK 21、Android SDK 36，以及 Go/NDK 桥接库构建环境。用 `-JavaHome`、`-AndroidSdk`、`-GradleCache` 调整本机路径；依赖齐全后可以加 `-Offline`，但 Gradle 离线模式不代表 Go 模块已缓存。

产物位于 `app/build/outputs/apk/debug/app-debug.apk`，是调试签名测试包。最低 Android 8.0（API 26）；当前原生库目标为 arm64，release 尚未配置正式发布签名。

## 安装与连接

```powershell
adb install --no-streaming -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

从仓库根目录执行，将 APK 安装到已授权设备；`-r` 保留现有应用数据，不要为了重连清空正常配对。

私网使用时，先在主机配置 Tailscale 与手机网关；手机连接内嵌私网并完成节点授权，再通过主机的一次性邀请配对。两种授权分别完成后可复用，不需反复配对。

完整步骤见 [运行与连接说明](../../docs/setup.md)。USB 开发调试可在主机执行 `adb reverse tcp:9087 tcp:9087`，把手机回环端口转发到主机；此路线使用允许明文 HTTP 的 debug 包。

## 同步与隐私

后台同步由用户在前台开启，默认轮询并在失败时退避。首次同步默认不补发旧候选与审批通知，通知点击只进入详情，不直接批准。

Android 系统时长限制、省电与厂商进程回收可能停止同步。内嵌私网不能取消系统后台限制，不能将短时通知成功视为全天可靠。

资料、计划不进入请求日志，令牌不预置在 APK 中。通知使用通用文案，不展示字段值。更多边界见 [使用限制与数据说明](../../docs/validation-and-data.md)。

[返回项目 README](../../README.md)
