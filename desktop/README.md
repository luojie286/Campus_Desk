# 课桌桌面端

React + TypeScript + Vite 消息工作台，提供 Tauri 2 Windows 原生壳。用于查看消息与附件、保留待办候选、核对和批准文档计划，以及管理监听来源。

## 开发与构建

在仓库根目录安装依赖并运行：

```powershell
npm --prefix desktop ci
npm run desktop:dev
```

第一条按锁文件安装并重建桌面 `node_modules`；第二条启动 `http://127.0.0.1:5173` 开发界面，`/api` 转发到本机 `127.0.0.1:9087`。主机需独立配置并启动，见 [运行与连接说明](../docs/setup.md)。

```powershell
npm run desktop:build
```

检查 TypeScript 并生成 Web 构建，产物位于 `desktop/dist/`。

构建 Tauri 壳还需 Rust MSVC 工具链与 WebView2：

```powershell
npm --prefix desktop run tauri:dev
npm --prefix desktop run tauri:build
```

两条分别用于原生开发和构建，产物位于 `src-tauri/target/`，不提交到源码仓库。

## 连接与凭据

在设置中填写服务地址和本机访问令牌。浏览器开发版使用 localStorage；Tauri 壳使用 Windows Credential Manager，前端仅在内存中使用解密后的令牌。

监听对象选择及名称刷新需要 NapCat 已登录且本机 OneBot API 可用。待办保留不批准文档写入；结果未知任务的核对只读，不自动重写。

Windows 正式安装分发、签名、系统通知和开机自启仍需完善。Android 是独立原生客户端，桌面窄屏布局不是手机端交付。

[返回项目 README](../README.md)
