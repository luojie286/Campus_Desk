# 课桌桌面端

消息中心与文档填写审批的桌面工作台。当前交付的是可运行的 **React + TypeScript + Vite Web MVP**；Tauri 2 原生壳等本机安装 Rust/MSVC 后再接入，页面和 API 客户端不需要重写。

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

生产构建：

```powershell
npm run build
```

## 第一版范围

- 消息中心：来源列表、未读数、消息详情、附件状态、文档链接入口。
- 待办清单：聊天/文件总结出的正式待办，保留后只进入清单，不自动执行。
- 审批请求：文档填写任务、拟填单元格、原值/拟填值、缺字段问答、批准并写入、取消。
- 连接设置：服务地址、令牌、健康检查。

第一版不做 Agent 自由对话、多 Agent 编排或其他文档平台。

## 隐私与凭据

- 消息、附件和审批保存在本机 SQLite；页面不接触浏览器会话或腾讯账号。
- 开发版把令牌放在浏览器 `localStorage`，只适合本机。Tauri 版本应改用系统安全存储（Windows Credential Manager/Stronghold）。
- 页面不硬编码用户、群、文档 URL、平台或执行器；来源、计划和问题都由 API 返回。

## Tauri 接入待办

本机尚未安装 Rust/Cargo，因此没有生成 `src-tauri/`。安装 Rust 和 MSVC Build Tools 后：

1. 在 `desktop/` 初始化 Tauri 2 工程。
2. 将令牌从 `localStorage` 迁移到系统安全存储。
3. 用 Tauri HTTP 插件或本机代理访问 `127.0.0.1:9087`，避免浏览器 CORS 限制。
4. 配置 Windows 安装包、系统通知和崩溃恢复。
