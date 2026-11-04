<p align="center">
  <img src="docs/images/readme/hero-en.svg" alt="Campus Desk · Review first. Then act. Organize QQ updates, review plans on your phone, and verify spreadsheet edits on your computer." width="100%">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <strong>Campus updates, personal tasks, and spreadsheets in one workflow.</strong><br>
  Your computer organizes messages and prepares plans. You review and approve each edit.
</p>

<p align="center">
  <a href="#preview">Preview</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#validation-and-limitations">Limitations</a> ·
  <a href="#project-layout-and-documentation">Documentation</a>
</p>

**Campus Desk** is a personal campus assistant. It turns messages from selected QQ groups or contacts into task suggestions, prepares fill plans for Tencent Docs spreadsheets, and lets you review, supplement, and approve those plans from Android or the desktop.

This is a **single-user, single-host development prototype**, primarily validated on Windows. The Android client is at **0.5.0**. KDocs support is still being assessed for technical feasibility.

## Preview

### Organize on your computer. Decide on your phone.

The actual desktop message center brings together original updates, attachments, merged task suggestions, and spreadsheet approval requests.

<img src="docs/images/readme/desktop-inbox.png" alt="Desktop message center showing synthetic course updates, a merged task suggestion, a spreadsheet approval link, and an extracted PDF attachment." width="100%">

### Review incoming items, approve a plan, and manage your tasks

<table>
  <tr>
    <th width="33%">Incoming items</th>
    <th width="33%">Spreadsheet approval</th>
    <th width="33%">Personal tasks</th>
  </tr>
  <tr>
    <td><img src="docs/images/readme/android-inbox.png" alt="Android inbox with task suggestions and document plans" width="100%"></td>
    <td><img src="docs/images/readme/android-plan.png" alt="Android plan review showing the target row, existing values, proposed values, and approval button" width="100%"></td>
    <td><img src="docs/images/readme/android-todos.png" alt="Android task list with completion and deletion controls" width="100%"></td>
  </tr>
  <tr>
    <td align="center">Merge related updates and keep useful tasks</td>
    <td align="center">Review the destination and values before approval</td>
    <td align="center">Complete, reopen, or confirm deletion</td>
  </tr>
</table>

<details>
<summary><strong>Desktop plan review and Android technology briefing</strong></summary>

<br>
<img src="docs/images/readme/desktop-approval.png" alt="Desktop plan review with the plan version, identity matching method, existing cell values, and proposed values" width="100%">

<p align="center">
  <img src="docs/images/readme/android-briefing.png" alt="Android technology briefing with synthetic stories and source notes" width="300">
</p>

</details>

<sub>The current application UI is in Chinese. All screenshots use synthetic data. Desktop images show the actual React UI; Android images are Robolectric renders of the actual Compose UI, not device captures. These images are not evidence of real-platform writes or background notifications. [Image provenance and reproduction (Chinese)](docs/images/readme/README.md)</sub>

## Features

| Message organization | Personal tasks | Approved spreadsheet edits |
| --- | --- | --- |
| Select QQ groups, members, or contacts; filter by stable account identifiers | Merge updates about the same activity and keep or dismiss suggestions | Read Tencent spreadsheets, locate your row, and prepare cell-level changes |
| Extract PDF and DOCX text; run image OCR locally | Complete, reopen, or confirm deletion on Android | Ask for missing information; show existing and proposed values before approval |
| Preserve original messages and their sources | Read technology briefings with source links and scheduling settings | Recheck before writing and read back afterward; never automatically repeat an uncertain write |

| Component | Technology and responsibilities |
| --- | --- |
| Android | Kotlin / Jetpack Compose; Keystore-encrypted device tokens; review, input, and approval |
| Desktop | React / TypeScript / Vite; Tauri 2 Windows shell with Credential Manager |
| Host | Node.js 24+ / SQLite / Playwright; message processing, plans, execution, and verification |
| Private network | Tailscale Serve HTTPS and Android userspace tsnet; separate application device pairing |
| Models and attachments | DeepSeek for analysis and summaries; PDF / DOCX extraction and local Tesseract image OCR |

The phone does not operate QQ or the document browser directly. The host service and gateway bind to loopback addresses, and the phone connects over the private network. The embedded Android transport does not use the system `VpnService`; connectivity has been verified on one phone while its existing VPN remained active.

## Workflow

```mermaid
flowchart LR
    Q[Selected QQ sources] --> H[Host storage and analysis]
    H --> T[Merge task suggestions]
    T --> K[Keep or dismiss on phone]
    H --> P[Prepare a plan without writing]
    P --> A[Review and approve on phone or desktop]
    A --> W[Host rechecks and writes]
    W --> V[Read back or mark outcome unknown]
```

Keeping a task does not approve a spreadsheet edit. If the outcome becomes uncertain after a write begins, the task enters `outcome_unknown`. The system verifies first and does not automatically write again.

## Quick Start

### Requirements

- Backend: Node.js **24+** and npm. Real Tencent spreadsheet execution uses an installed Microsoft Edge browser.
- Desktop web: npm dependencies in both the repository root and `desktop/`. Building the Tauri shell also requires the Rust MSVC toolchain and WebView2.
- Android: JDK 21 and Android SDK 36. Rebuilding the embedded transport also requires Go and the NDK; see the build scripts and `mobile/tsnet-probe/go/go.mod` for versions.
- Real use: configure your own QQ / NapCat setup, dedicated Tencent Docs login session, personal profile, and DeepSeek API access. Private phone access additionally requires Tailscale configuration and device pairing.

The repository does not include accounts, databases, browser sessions, third-party QQ adapter installers, or prebuilt APK/AAR files. Some scripts still contain machine-specific tool paths that need adjustment. One-command deployment is not yet available.

### Install dependencies and run checks

From the repository root:

```powershell
npm ci
npm --prefix desktop ci
npm test
npm run desktop:build
```

The first two commands install backend and desktop dependencies from their lockfiles. `npm test` runs backend tests; the final command checks desktop TypeScript and builds the web UI. `npm ci` recreates the corresponding `node_modules` directory. These commands do not configure real accounts or fill online spreadsheets.

### Configure real use before starting

First configure your accounts, profile, and dedicated sessions. See the [runtime and connection guide (Chinese)](docs/setup.md).

Host configuration lives in `.private/config.json`; profiles and tasks live in `.private/poc.sqlite`. Check the source and account, use `pipeline=v2` and `messageCenter=true`, and keep `execute=false` during connection and login checks. DeepSeek features read `DEEPSEEK_API_KEY` from the host process environment; creating an `.env` file alone does not load it automatically.

First-run configuration does not include a real spreadsheet address. Set your own authorized test spreadsheet in the local configuration.

```powershell
npm start
```

This starts the host service on `127.0.0.1:9087`; keep the terminal open. It initializes or migrates the local database and starts workers according to the current configuration. An existing installation may have execution enabled and previously approved tasks queued, so check the configuration and tasks before starting. Starting the service is not a read-only inspection.

Open another terminal for the desktop development UI:

```powershell
npm run desktop:dev
```

Open `http://127.0.0.1:5173` and configure the connection. NapCat and the mobile gateway must be prepared and started separately; see the [runtime and connection guide (Chinese)](docs/setup.md). Do not start duplicate instances on occupied ports.

### Build Android

```powershell
.\tools\build-android.ps1
```

The script runs Android tests and lint, then builds a debug APK under `mobile/android/app/build/outputs/apk/debug/`. On another machine, use `-JavaHome`, `-AndroidSdk`, and `-GradleCache` to specify tool directories. A missing or outdated AAR triggers a Go bridge rebuild. The first build requires dependency downloads; Gradle offline mode does not imply Go dependencies are cached.

See the [Android guide (Chinese)](mobile/android/README.md) for details. The current native library targets arm64. The debug APK is for testing; release builds do not yet have a production signing configuration.

## Validation and Limitations

- This is a single-user, single-host Windows development prototype. Spreadsheet execution is implemented for Tencent Docs; KDocs/WPS, Feishu, and WeChat integration are not implemented.
- Phone notifications depend on background polling. Recovery after process termination and all-day reliability still need work.
- Complex spreadsheet handling, deployment scope, and recovery capabilities have limits. See [usage limitations and data handling](docs/validation-and-data.en.md).

## Data and Credentials

- Accounts, profiles, attachments, and sessions are stored locally under `.private/` and are not distributed with the source. Supply your own credentials and platform logins.
- Analysis and summaries send necessary content to DeepSeek. Image OCR runs locally.
- GitHub does not back up ignored private data; keep separate backups. See [data and credential details](docs/validation-and-data.en.md#data-and-credentials).

## Project Layout and Documentation

```text
src/                    Host APIs, tasks, message processing, and document execution
mobile/android/         Native Android client and tests
mobile/tsnet-probe/go/   Shared userspace private-network bridge source
desktop/                Web workspace and Tauri shell
test/                   Backend automated tests
tools/                  Build, runtime, and diagnostic scripts
docs/                   Runtime guides, usage limitations, and README images
```

- [Runtime and connection guide (Chinese)](docs/setup.md)
- [Android build and usage (Chinese)](mobile/android/README.md) / [desktop development (Chinese)](desktop/README.md)
- [Usage limitations and data handling](docs/validation-and-data.en.md)
- [Image provenance and reproduction (Chinese)](docs/images/readme/README.md)

## License

A project license has not yet been selected. Publishing to GitHub and choosing an open-source license are separate decisions. Before public distribution, define the project's usage terms and review the licenses and distribution requirements of its third-party components.
