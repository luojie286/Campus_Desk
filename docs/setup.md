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

## 桌面知识库

知识库复用主机配置中的当前账号和本机 SQLite。先按上文初始化主机并填好 `account_id`。首次导入和知识库启动脚本使用固定的 Windows x64 Node.js 24.22.2。将发布包中的 `node.exe` 和官方 `SHASUMS256.txt` 放在 `.private/runtime/node-v24.22.2/`，按清单中的 `win-x64/node.exe` 核对 SHA-256，再运行。启动脚本也会校验该文件。 [Node.js 发布目录](https://nodejs.org/dist/v24.22.2/)

### 首次导入

在仓库根目录运行以下命令。将 `C:\Notes` 换成你授权的实际目录，将 `archive` 换成想排除的子目录。填入一个不存在的子目录名可保留目录内所有支持的文字资料。入口路径若经过 Windows 目录联接，应填写解析后的实际目录。

```powershell
$kbNode = '.\.private\runtime\node-v24.22.2\node.exe'
$notes = 'C:\Notes'
$exclude = 'archive'
& $kbNode tools/import-notes.cjs plan $notes $exclude
```

`plan` 只读取目录中的 Markdown、TXT、DOCX 和 PDF，输出数量、字节数与清单摘要。核对范围后，将下面的占位符替换为返回的 `digest`。`apply` 校验清单摘要，首次为原数据库创建备份，再保存本机副本和索引，并创建缺失的 `.private/assistant.config.json`。原始文件保留在源目录。图片可在桌面知识库的导入预览中单独批准。

```powershell
& $kbNode tools/import-notes.cjs apply $notes $exclude '<digest>'
```

已有知识库 schema 1 的主机可在服务停止后运行 `& $kbNode tools/upgrade-assistant.cjs`。它先备份数据库，再升级到 schema 2，保留现有资料。

### 连接、问答和研究

```powershell
.\tools\start-assistant.ps1 -CopyDesktopToken
```

该命令启动本机知识库服务，并将独立令牌复制到剪贴板。保持终端打开，在课桌侧栏选择「个人知识库」，粘贴令牌并连接。Windows 桌面客户端会把令牌保存到 Credential Manager。下次连接可省略 `-CopyDesktopToken`。

可选模型在 `.private/assistant.config.json` 中配置。首次导入生成 DeepSeek 示例，凭证从启动终端的 `DEEPSEEK_API_KEY` 读取。先在资料列表批准模型处理权限，再开启模型问答或进入 Deeper Research。研究报告与过程保存使用写入预览审批，关窗后可重新连接查看主机中的进度。

需要同时运行消息、待办和填表功能时，在同一端口的服务停止后使用以下命令。`-WithLegacy` 启用原有工作者，并沿用当前的执行开关和获批任务队列。

```powershell
.\tools\start-assistant.ps1 -WithLegacy
```

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
