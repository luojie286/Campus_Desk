# README 配图与截图来源

- `hero.svg`、`hero-en.svg`：本项目原创中英文 SVG 横幅，仅作为处理流程示意，不是界面截图。
- `desktop-chat.png`：实际 React 构建的粉色聊天首页，展示首次打开时的提示与输入框。
- `desktop-knowledge.png`、`desktop-research.png`：新版 Python 工作台的聊天引用与深度研究，展示合成回答、资料、预算及评审记录。
- `desktop-inbox.png`、`desktop-approval.png`：桌面业务记录与新版填写计划，使用合成消息和修改预览。
- `android-*.png`：实际 Android Compose 界面，由 Robolectric 原生图形模式渲染。使用 debug 离线演示数据，不是手机实拍或模拟器截图。

图片中的消息、资料、群名和链接均为合成示例，不能作为真实 QQ 接入或平台执行验收证据。

## 重新生成

先按 `mobile/android/README.md` 配好 JDK、SDK 和 Gradle 环境，在 `mobile/android/` 中运行：

```powershell
.\gradlew.bat :app:testDebugUnitTest --tests com.campusdesk.mobile.ScreenTest --rerun-tasks --offline --console=plain
```

该命令重新运行 Compose 界面测试，生成 `app/build/reports/mobile-preview/` 下的图片。`--offline` 适用于依赖已缓存的环境，可在首次准备依赖时去掉；`--rerun-tasks` 强制重新生成，避免复用旧图片。它只使用本机测试运行库，不操作已配对的手机。

然后回到仓库根目录构建桌面前端并截图：

```powershell
npm run desktop:build
node tools/capture-readme.cjs
```

需要已安装的根目录和桌面 npm 依赖以及 Edge。脚本在临时 Vite 预览中打开构建产物，通过 Playwright 提供合成 API 响应并阻止远程资源和修改请求。结束后关闭浏览器与预览进程，并复制上一步的 Android 图片。横幅 SVG 独立维护。

只更新桌面图片时，可跳过 Android 测试，在构建后运行：

~~~powershell
node tools/capture-readme.cjs --desktop-only
~~~

`--assistant-only` 可只更新聊天首页、引用和研究三张截图。
