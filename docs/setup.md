# 运行与连接说明

这里仅说明使用与连接步骤。环境要求和构建命令见 [中文 README](../README.md) / [English README](../README_EN.md)。

## 主机配置

首次使用需初始化本机配置和数据库。可在仓库根目录运行：

```powershell
node src/poc.cjs status
```

该命令会创建缺失的 `.private/config.json` 与 SQLite 数据库，并执行所需迁移；不会启动业务 worker。它不是对磁盘完全只读的命令。已有配置不会被重置，真实数据需先单独备份。

在本机私有配置中核对以下项目，不把配置内容提交或粘贴到公开日志：

- `token`：主机访问令牌，首次初始化自动生成。
- `account_id` 与 `source`：当前 QQ 账号及指定来源的稳定标识。
- `allowed_document`：本人获授权的测试表地址，首次初始化时为空。
- `pipeline` 设为 `v2`、`messageCenter` 设为 `true`。
- 接入和登录检查期间保持 `execute=false`。

本人资料保存在 `.private/poc.sqlite`。字段映射和早报等功能需要主机进程环境中的 `DEEPSEEK_API_KEY`；项目不会自动加载 `.env` 文件。

## QQ 与文档会话

QQ 适配器使用固定的 NapCat 发布包，当前启动脚本读取 `.private/vendor/napcat-4.18.41/`，QQ 程序路径仍需按本机安装位置调整。包文件不随源码提供。

```powershell
.\tools\start-napcat.ps1
```

此命令隐藏启动项目专用适配器；端口已占用时停止，避免重复实例。首次需要本人用专用 QQ 正常扫码登录，不能把管理页面可打开等同于 QQ 已在线。

登录后运行：

```powershell
node tools/configure-qq.cjs
```

它会配置当前项目 OneBot API 与消息回调，并保存当前账号绑定。随后可在桌面连接设置中添加监听群聊、群成员或好友。不要仅因普通 QQ 已运行就关闭所有 QQ 进程。

腾讯文档使用项目专用浏览器会话：

```powershell
node src/poc.cjs login
```

该命令打开专用 Edge，由本人正常登录。登录辅助器正常退出后，后台才能复用会话；不提取私人浏览器凭证，也不绕过扫码或验证码。

## 启动桌面服务

在两个独立终端依次运行：

```powershell
npm start
```

启动 `127.0.0.1:9087` 主服务，初始化/迁移数据库并按配置运行 worker，保持终端打开。已有配置若启用了执行且存在获批任务，启动后可能恢复处理，启动前应核对。

```powershell
npm run desktop:dev
```

启动桌面 Web 开发界面，访问 `http://127.0.0.1:5173` 并配置本机连接。浏览器开发版使用本机 localStorage，Tauri 壳使用 Windows Credential Manager。

## 手机私网连接

电脑安装并登录 Tailscale，确认在线。在主服务就绪后运行：

```powershell
.\tools\start-private-gateway.ps1
node tools/private-network.cjs tailscale-setup
node tools/private-network.cjs probe
```

第一条隐藏启动回环网关 `9090`；第二条首次配置私网 HTTPS 入口，如已有配置会拒绝覆盖；第三条检查 HTTPS 网关。不要启用 Funnel 或将业务接口直接暴露到公网。

主机 Serve 已配置的日常启动不需重复执行 `tailscale-setup`。探测成功不代表 QQ 已登录。

首次业务配对时运行：

```powershell
node tools/private-network.cjs invite
```

它创建一次性邀请，保存到 `.private/pairing-invitation.json`，5 分钟内有效；通过可信渠道传给自己的手机，不上传仓库或公开发送。

手机设置中先连接内嵌私网、授权节点加入同一 tailnet，再使用邀请配对。节点授权与业务设备配对是两步；正常配对后无需反复生成邀请或清除手机数据。内嵌传输不需要启动第二个系统 VPN。

主机需保持联网且不睡眠。手机后台同步由用户在前台开启；长期后台可靠性仍受系统与厂商策略影响。

## 停止与账号操作

- 关闭前台主服务可在对应终端按 `Ctrl+C`；网关可运行 `tools/stop-private-gateway.ps1` 停止，不影响主服务和 Tailscale。
- 切换账号需先暂停写入，并按 `tools/switch-account.ps1` 提供的 `switch-qq`、`relogin-qq`、`relogin-document` 模式处理；这些操作可能停止本项目进程和更改绑定，不能当作普通连接检查。
- 配对令牌可通过 `node tools/private-network.cjs revoke DEVICE_ID` 撤销；将 `DEVICE_ID` 换成目标设备 ID，撤销后该设备无法继续访问。
- 所有在线表格修改仍需先核对计划并批准。网络结果未知时先读取核对，不重复提交写入。
