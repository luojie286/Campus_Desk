# 课桌桌面端

消息中心与文档填写审批的桌面工作台。当前包含 **React + TypeScript + Vite Web MVP** 和 **Tauri 2 Windows 原生壳**；原生壳使用 Windows Credential Manager 保存访问令牌，不再依赖浏览器 localStorage。

窄屏响应式样式只是桌面窗口缩小时的 Web 预览，不是手机端交付。手机端按计划是独立的 Android 原生 App（Kotlin/Compose），不会复用这个网页作为最终客户端。

## 运行

```powershell
cd desktop
npm install
npm run dev
```

开发地址是 `http://127.0.0.1:5173`。Vite 会把 `/api` 代理到 `http://127.0.0.1:9087`，所以先在仓库根目录启动后台：

```powershell
npm start
```

打开页面后进入“连接设置”，填入后台服务地址与访问令牌。令牌来自本机 `.private/config.json`，不要提交到 Git 或发给别人。

Web 生产构建：

```powershell
npm run build
```

Tauri 原生开发/构建（需要 Rust MSVC 工具链和 WebView2）：

```powershell
npm run tauri:dev
npm run tauri:build
```

Tauri 构建产物在 `src-tauri/target/release/` 下；首次编译需要下载并编译 Rust 依赖，时间较长。

## 第一版范围

- 消息中心：来源列表、未读数、消息详情、下载/提取/不支持等附件状态、文档链接入口；支持 PDF 和 DOCX 文字提取。
- 待办候选：会话级 LLM 过滤闲聊，文本和已提取的附件文字按同一事务合并；详情显示合并来源。
- 待办清单：聊天/文件总结出的正式待办，保留后只进入清单，不自动执行。
- 审批请求：文档填写任务、拟填单元格、原值/拟填值、缺字段问答、批准并写入、取消。
- 连接设置：服务地址、令牌、健康检查。

第一版不做 Agent 自由对话、多 Agent 编排或其他文档平台。

## 隐私与凭据

- 消息、附件和审批保存在本机 SQLite；页面不接触浏览器会话或腾讯账号。
- 浏览器开发版把令牌放在 `localStorage`，只适合本机。
- Tauri 版通过 Rust `keyring` 写入 Windows Credential Manager，前端只保留内存中的令牌；设置页保存/清除令牌会调用原生命令。
- 页面不硬编码用户、群、文档 URL、平台或执行器；来源、计划和问题都由 API 返回。

## Tauri 壳

`src-tauri/` 已包含 Tauri 2 窗口、Windows Credential Manager 令牌存储和默认 capability。后端只对 `localhost:5173`、`127.0.0.1:5173` 与 Tauri 本机来源放行 CORS，接口仍需 Bearer 令牌。

仍待完善：Windows 安装包图标/签名、系统通知、开机自启和崩溃恢复。
