# README 配图与截图来源

- `hero.svg`：本项目原创 SVG 横幅，仅作为处理流程示意，不是界面截图。
- `desktop-inbox.png`、`desktop-approval.png`：实际 React 前端在 Edge 无头浏览器中的截图。Playwright 拦截全部 API，注入合成消息与计划；屏蔽远程资源，禁止修改请求，没有业务后台和真实写表。
- `android-*.png`：实际 Android Compose 界面，由 Robolectric 原生图形模式渲染。使用 debug 离线演示数据，不是手机实拍或模拟器截图。

图片中的消息、资料、群名和链接均为合成示例，不能作为真实 QQ 接入或平台执行验收证据。

## 重新生成

先按 `mobile/android/README.md` 配好 JDK、SDK 和 Gradle 环境，在 `mobile/android/` 中运行：

```powershell
.\gradlew.bat :app:testDebugUnitTest --tests com.campusdesk.mobile.ScreenTest --rerun-tasks --offline --console=plain
```

该命令重新运行 Compose 界面测试，生成 `app/build/reports/mobile-preview/` 下的图片。`--offline` 适用于依赖已缓存的环境，可在首次准备依赖时去掉；`--rerun-tasks` 强制重新生成，避免复用旧图片。它只使用本机测试运行库，不操作已配对的手机。

然后回到仓库根目录运行：

```powershell
node tools/capture-readme.cjs
```

需要已安装的根目录/桌面 npm 依赖与 Edge。脚本启动临时本机 Vite 预览，截图后关闭浏览器与预览进程，并复制上一步的 Android 预览。不会加载 `.private/`、运行业务 worker、调用真实 API 或发送模型请求。横幅 SVG 独立维护。
