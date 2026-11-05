<p align="center">
  <img src="docs/images/readme/hero.svg" alt="课桌 · 由你确认，再行动。QQ 通知整理、手机核对、主机执行与回读。" width="100%">
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

<p align="center">
  <strong>校园里的通知、待办与表格，在一个工作流里处理。</strong><br>
  电脑整理消息、准备资料，手机核对计划；每一次填写，都由你批准。
</p>

<p align="center">
  <a href="#界面预览">界面预览</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#验证与限制">验证与限制</a> ·
  <a href="#目录与文档">文档</a>
</p>

**课桌（Campus Desk）** 是面向个人的校园助手：从指定 QQ 群或好友的消息中整理待办，为腾讯在线表格准备填写计划，并通过 Android 或桌面端核对、补充和审批。

当前为 **单用户、单主机的开发原型**，主要在 Windows 上验证。Android 已实现至 **0.5.0**；金山文档处于可行性分析阶段。

## 界面预览

### 电脑整理消息，手机决定行动

实际桌面前端中的消息中心：原始通知、附件、合并候选和文档审批入口集中展示。

<img src="docs/images/readme/desktop-inbox.png" alt="桌面消息中心：课程通知、合并待办候选、信息登记表审批入口和已提取文字的 PDF 附件。全部为合成演示数据。" width="100%">

### 从待处理，到逐项核对，再到自己的待办

<table>
  <tr>
    <th width="33%">待处理</th>
    <th width="33%">填写计划审批</th>
    <th width="33%">我的待办</th>
  </tr>
  <tr>
    <td><img src="docs/images/readme/android-inbox.png" alt="Android 待处理：待办候选与文档计划" width="100%"></td>
    <td><img src="docs/images/readme/android-plan.png" alt="Android 审批：展示目标行、原值、拟填值与批准按钮" width="100%"></td>
    <td><img src="docs/images/readme/android-todos.png" alt="Android 待办：保留的事项、完成与删除操作" width="100%"></td>
  </tr>
  <tr>
    <td align="center">合并相关通知，保留值得做的事</td>
    <td align="center">先看清改哪里、填什么，再批准</td>
    <td align="center">完成、恢复、二次确认删除</td>
  </tr>
</table>

<details>
<summary><strong>查看桌面审批界面与手机技术早报</strong></summary>

<br>
<img src="docs/images/readme/desktop-approval.png" alt="桌面审批详情：计划版本、身份定位方式、单元格原值与拟填值" width="100%">

<p align="center">
  <img src="docs/images/readme/android-briefing.png" alt="Android 技术早报详情，展示合成资讯与来源说明" width="300">
</p>

</details>

<sub>截图均使用合成数据。桌面图来自实际 React 界面；Android 图来自实际 Compose 界面的 Robolectric 渲染，不是真机截图。图片不作为真实平台写入或后台通知的验收证据。[配图来源与复现](docs/images/readme/README.md)</sub>

## 核心能力

| 消息整理 | 个人待办 | 审批填写 |
| --- | --- | --- |
| 指定 QQ 群、成员或好友，按稳定账号标识过滤 | 合并同一事务的多条通知，保留或忽略候选 | 读取腾讯表格，定位本人行，准备单元格修改计划 |
| PDF / DOCX 文字提取，图片本地 OCR | 手机完成、恢复、确认删除 | 缺资料先询问，展示原值和拟填值，再人工批准 |
| 保留原始消息与来源，方便回看 | 技术早报、来源链接与定时设置 | 电脑写前复核、写后回读，结果未知时不自动重写 |

| 客户端与组件 | 技术与职责 |
| --- | --- |
| Android | Kotlin / Jetpack Compose，Keystore 加密设备令牌，查看、补充、审批 |
| 桌面 | React / TypeScript / Vite，Tauri 2 Windows 壳使用 Credential Manager |
| 主机 | Node.js 24+ / SQLite / Playwright，消息处理、计划、执行与核对 |
| 私网 | Tailscale Serve HTTPS + Android 用户态 tsnet，独立业务设备配对 |
| 模型与附件 | DeepSeek 负责分析与摘要；PDF / DOCX 提取，Tesseract 本地图片 OCR |

手机不直接操作 QQ 或文档浏览器。主机服务与网关只监听回环地址，手机通过私网访问；Android 内嵌传输不占系统 `VpnService`，已在一台保留原 VPN 的手机上验证连接。

## 工作流程

```mermaid
flowchart LR
    Q[QQ 指定来源] --> H[主机入库与分析]
    H --> T[合并待办候选]
    T --> K[手机保留 / 忽略]
    H --> P[只读准备填写计划]
    P --> A[手机或桌面核对审批]
    A --> W[主机写前复核与填写]
    W --> V[回读确认 / 结果未知]
```

保留待办不等于批准填写。写入开始后结果不明时进入 `outcome_unknown`，先核对，不自动重写。

## 快速开始

### 环境要求

- 后端：Node.js **24+**、npm；真实腾讯表格执行使用已安装的 Microsoft Edge。
- 桌面 Web：根目录和 `desktop/` 各自的 npm 依赖。构建 Tauri 壳另需 Rust MSVC 工具链和 WebView2。
- Android：JDK 21、Android SDK 36；内嵌传输重建另需 Go 工具链及 NDK，版本见构建脚本和 `mobile/tsnet-probe/go/go.mod`。
- 真实业务：自行配置 QQ / NapCat、腾讯文档专用登录会话、本人资料和 DeepSeek API 访问。手机私网连接另需 Tailscale 配置与设备配对。

仓库不包含账号、数据库、浏览器会话、第三方 QQ 适配器安装包或预构建 APK/AAR。当前部分脚本仍带本机工具路径，换机需调整，尚未实现一键部署。

### 安装依赖与检查

在仓库根目录运行：

```powershell
npm ci
npm --prefix desktop ci
npm test
npm run desktop:build
```

前两条按锁文件安装后端和桌面依赖；`npm test` 运行后端测试，最后一条检查桌面 TypeScript 并生成 Web 构建。`npm ci` 会重建对应目录的 `node_modules`，不初始化真实账号，不填写在线表格。

### 配置真实业务后启动

首次使用需完成独立账号、资料和会话配置，参阅 [运行与连接说明](docs/setup.md)。

主机配置位于 `.private/config.json`，资料与任务位于 `.private/poc.sqlite`。先确认来源、账号、`pipeline=v2`、`messageCenter=true`，在接入与登录检查期间保持 `execute=false`。DeepSeek 相关功能读取主机进程环境变量 `DEEPSEEK_API_KEY`；仅创建 `.env` 文件不会自动加载它。

首次配置不预置任何真实表格地址，需在本机配置中指定自己获授权的测试表。

```powershell
npm start
```

启动本机 `127.0.0.1:9087` 主服务，窗口需保持打开。它会初始化/迁移本地数据库并按当前配置启动 worker；已有配置可能启用执行并保留获批准的任务，启动前应核对配置与任务，不能把启动当作只读检查。

另开窗口启动桌面开发界面：

```powershell
npm run desktop:dev
```

访问 `http://127.0.0.1:5173`，按界面配置连接。NapCat 和手机网关需要分别准备和启动；查看 [运行与连接说明](docs/setup.md)，不要重复启动占用同一端口的实例。

### Android 构建

```powershell
.\tools\build-android.ps1
```

该脚本运行手机端测试、lint 和 debug APK 构建，产物位于 `mobile/android/app/build/outputs/apk/debug/`。换机时用 `-JavaHome`、`-AndroidSdk`、`-GradleCache` 指定工具目录。缺失或过期的 AAR 会触发 Go 桥接库重建；首次需要下载依赖，Gradle 离线模式不代表 Go 依赖已缓存。

完整步骤见 [Android 运行说明](mobile/android/README.md)。当前原生库构建目标为 arm64，debug APK 仅供测试，release 尚未配置正式发布签名。

## 验证与限制

- 当前是单用户、单主机的 Windows 开发原型；文档填写已实现腾讯表格，金山/WPS、飞书和微信接入尚未实现。
- 手机通知依赖后台轮询，进程被清理后的恢复和全天可靠性仍待完善。
- 复杂表格、部署范围与恢复能力仍有边界，见 [详细验证与限制](docs/validation-and-data.md)。

## 数据与凭据

- 账号、资料、附件和会话保存在本机 `.private/`，不随源码提供；密钥和平台登录需自行配置。
- 分析与摘要会将必要内容发送到 DeepSeek；图片 OCR 在本机执行。
- GitHub 不备份被忽略的私人数据，需单独保存；详见 [数据与凭据说明](docs/validation-and-data.md#数据与凭据)。

## 目录与文档

```text
src/                    主机 API、任务、消息处理和文档执行
mobile/android/         Android 原生客户端与测试
mobile/tsnet-probe/go/   共享用户态私网桥接库源码
desktop/                Web 工作台和 Tauri 壳
test/                   后端自动测试
tools/                  构建、运行和诊断脚本
docs/                   运行说明、使用限制与 README 配图
```

- [运行与连接说明](docs/setup.md)
- [Android 构建与使用](mobile/android/README.md) / [桌面开发](desktop/README.md)
- [使用限制与数据说明](docs/validation-and-data.md)
- [配图来源与重新生成](docs/images/readme/README.md)

## 许可证

本项目采用 [MIT 许可证](LICENSE)，允许使用、修改、分发和商业使用，须按许可证要求保留版权和许可声明。软件按原样提供，不附带任何担保。

第三方代码与依赖仍适用各自的许可证；分发时须遵守相应的版权声明与许可要求。
