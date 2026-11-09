<p align="center">
  <img src="docs/images/readme/hero-en.svg" alt="Campus Desk · Review first. Then act. Organize QQ updates, review plans on your phone, and verify spreadsheet edits on your computer." width="100%">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <strong>Open Campus Desk and start a conversation with your knowledge base.</strong><br>
  Run research, organize QQ updates, and review spreadsheet plans on the desktop.
</p>

<p align="center">
  <a href="#preview">Preview</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#changelog">Changelog</a> ·
  <a href="#validation-and-limitations">Limitations</a> ·
  <a href="#project-layout-and-documentation">Documentation</a>
</p>

**Campus Desk** is a personal campus workbench. The desktop opens to a pink AI chat with local knowledge search and source citations. The sidebar opens **Deeper Research**, the QQ inbox, and tasks and spreadsheet plans.

The Python host manages local retrieval, model orchestration, and workflow state. QQ and spreadsheets can be enabled separately. The legacy Android client has its own interface.

This is a **single-user, single-host development prototype**, primarily validated on Windows. The Android client is at **0.5.0**. KDocs support is still being assessed for technical feasibility.

## Preview

### Pink AI chat home

The desktop starts with suggested prompts and a message composer. Open the local workbench connection when setting up the app for the first time.

<img src="docs/images/readme/desktop-chat.png" alt="Pink Campus Desk AI chat home with suggested prompts, a message composer, and workspace navigation." width="100%">

### Source citations and Deeper Research

Chat searches the local knowledge base by default. Open the Q&A options to select sources or let a model summarize approved excerpts. Select a citation to check its text and location.

<img src="docs/images/readme/desktop-knowledge.png" alt="Desktop knowledge Q&A with a synthetic answer, two citations, and an expanded PDF excerpt." width="100%">

Deeper Research shows budget usage, the best report so far, and the agents’ review process.

<img src="docs/images/readme/desktop-research.png" alt="Desktop Deeper Research with a synthetic report, source citations, budget usage, and agent review." width="100%">

### Desktop message records and legacy Android previews

The desktop retains a business-records section. The message center below shows synthetic updates, attachments, and task suggestions.

<img src="docs/images/readme/desktop-inbox.png" alt="Desktop message center showing synthetic course updates, a merged task suggestion, a spreadsheet approval link, and an extracted PDF attachment." width="100%">

### Legacy Android workbench

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

| Desktop feature | What you can do |
| --- | --- |
| Personal knowledge base | Import Markdown, TXT, DOCX, PDF, PNG, and JPEG. Text extraction and OCR run locally. Open search results at a source excerpt and its page, paragraph, or line. |
| AI chat | Search local notes and profile fields by default. Use the Q&A options to select sources or generate a cited answer from approved excerpts. |
| Tasks and profile | Approve source admission when keeping a task, or admit sources from existing tasks in batches. Completed or deleted tasks leave search. Approved profile changes trigger fresh preparation and approval of affected spreadsheet plans. |
| Deeper Research | Configure two to four agents to explore independently, review each other's findings, revise, and compare results. Set limits for tokens, calls, rounds, and active time. Pause, resume, cancel, or add requirements. |
| Tasks and spreadsheets | Open tasks from the sidebar or submit a Tencent spreadsheet URL to prepare a plan. Review the target and proposed changes before approval. The host writes and reads back the cells. |

Research runs in the host process. Reopen the desktop window to check progress. Saving a report requires approval of a write preview, and the host releases unsaved research when it exits.

| Message organization | Personal tasks | Approved spreadsheet edits |
| --- | --- | --- |
| Select QQ groups, members, or contacts; filter by stable account identifiers | Merge updates about the same activity and keep or dismiss suggestions | Read Tencent spreadsheets, locate your row, and prepare cell-level changes |
| Extract PDF and DOCX text; run image OCR locally | Complete, reopen, or confirm deletion on Android | Ask for missing information; show existing and proposed values before approval |
| Preserve original messages and their sources | Read technology briefings with source links and scheduling settings | Recheck before writing and read back afterward; never automatically repeat an uncertain write |

| Component | Technology and responsibilities |
| --- | --- |
| Android | Kotlin / Jetpack Compose; Keystore-encrypted device tokens; review, input, and approval |
| Desktop | React / TypeScript / Vite; Tauri 2 Windows shell with Credential Manager |
| Host | Python and SQLite FTS5 for the workbench, research, and approvals; Node.js 24 and Playwright for the Tencent spreadsheet adapter |
| Private network | Tailscale Serve HTTPS and Android userspace tsnet; separate application device pairing |
| Models and attachments | Configure Chat Completions compatible models in a local file; PDF / DOCX extraction and local Tesseract OCR for images and scanned pages |

The Python desktop host binds to loopback. Private network access in the legacy Android setup uses a separate gateway and device pairing.

## Workflow

```mermaid
flowchart LR
    Q[Selected QQ sources] --> H[Host storage and analysis]
    H --> T[Merge task suggestions]
    T --> K[Confirm on desktop]
    K -->|Approve source admission| L[Local knowledge base]
    D[Import documents] --> L
    L --> R[Local search and citations]
    R -->|Grant model access| S[Q&A or Deeper Research]
    K --> P[Prepare a plan without writing]
    M[Submit spreadsheet URL on desktop] --> P
    P --> A[Review and approve on desktop]
    A --> W[Host rechecks and writes]
    W --> V[Read back or mark outcome unknown]
```

Keeping a task does not approve a spreadsheet edit. If the outcome becomes uncertain after a write begins, the task enters `outcome_unknown`. The system verifies first and does not automatically write again.

## Quick Start

### Requirements

- Workspace commands require **Python 3.11+**. The desktop build and compatibility adapters use Node.js 24 and npm. The pinned Windows runtime is **Node.js 24.22.2**. Real Tencent spreadsheet execution uses Microsoft Edge.
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

### Use desktop knowledge search and research

The Python workbench can read an existing knowledge workspace. For a new workspace, run `python -m campusdesk init-knowledge`. Preview a file with `python -m campusdesk import-knowledge <file>`, then pass `--approve <digest>` to publish it.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\tools\start-python-workbench.ps1 -CopyToken
```

The first two commands create an isolated Python environment and install dependencies. The last command starts the loopback workbench and copies its token. From AI chat, open the local workbench connection and paste the token. Model calls use the host's DeepSeek configuration and environment. Use `python -m campusdesk knowledge-cloud <document-id> allow` or the legacy document manager to approve cloud processing for specific material.

After cutover, `serve` starts the Python workbench by default. Use `python -m campusdesk serve --legacy-assistant --copy-token` for the legacy document manager. This mode starts no QQ, spreadsheet, or briefing workers.

To enable an ability on the Python workbench, pass `-SearchProvider crossref` for scholarly metadata search, or `-SearchProvider brave` with `BRAVE_SEARCH_API_KEY` set for web search. Only the explicit public query field is sent to the search service.

Pass `-QQAbility` to enable the Python QQ inbox. Reuse an authorized account binding and source list, and point NapCat's HTTP callback at `http://127.0.0.1:9089/api/v1/abilities/qq/callback`. The callback uses the local OneBot token by default or a separate `CAMPUSDESK_QQ_CALLBACK_TOKEN`. Select one callback consumer for a source during testing or cutover. History requires separate read permission, and only generates suggestions with `-QQHistorySuggestions`. The Python ability stores its messages and candidate decisions separately.

To transfer existing todo and spreadsheet work, stop the legacy and Python hosts. Run `.\.venv\Scripts\python.exe -m campusdesk business-cutover` to review counts and the migration digest. Repeat with `--approve <digest>` to back up SQLite and transfer ownership. Historical records remain available. Interrupted writes go to readback recovery, and the legacy business worker refuses to start after the transfer.

Start with `python -m campusdesk serve --qq --sheets --copy-token` for read-only planning. After signing in to the project QQ account, `node tools/configure-qq.cjs --python-callback` backs up and switches the project callback. Writing requires `--execute-sheets`, an enabled execution setting, and approval of the current plan.

### Configure real use before starting

First configure your accounts, profile, and dedicated sessions. See the [runtime and connection guide (Chinese)](docs/setup.md).

Host configuration lives in `.private/config.json`; profiles and tasks live in `.private/poc.sqlite`. Check the source and account, use `pipeline=v2` and `messageCenter=true`, and keep `execute=false` during connection and login checks. DeepSeek features read `DEEPSEEK_API_KEY` from the host process environment; creating an `.env` file alone does not load it automatically.

First-run configuration does not include a real spreadsheet address. Set your own authorized test spreadsheet in the local configuration.

```powershell
.\.venv\Scripts\python.exe -m campusdesk serve --qq --sheets
```

After cutover, this starts the Python workbench on `127.0.0.1:9089` with QQ ingress and read-only spreadsheet preparation. Keep the terminal open.

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
- Deeper Research currently uses authorized knowledge base excerpts. Synthetic runs covered agent collaboration, budget controls, and reconnection. Web evidence gathering and comparisons across effort levels are planned.
- Phone notifications depend on background polling. Recovery after process termination and all-day reliability still need work.
- Complex spreadsheet handling, deployment scope, and recovery capabilities have limits. See [usage limitations and data handling](docs/validation-and-data.en.md).

## Data and Credentials

- Accounts, profiles, attachments, and sessions are stored locally under `.private/` and are not distributed with the source. Supply your own credentials and platform logins.
- OCR for images and scanned pages runs locally. The knowledge base sends relevant excerpts to the selected model after you grant access to a file or folder. Existing message analysis, spreadsheet field mapping, and briefings use their own model configuration.
- GitHub does not back up ignored private data; keep separate backups. See [data and credential details](docs/validation-and-data.en.md#data-and-credentials).

## Project Layout and Documentation

```text
campusdesk/             Python workspace, migration, message policies, and model tools
src/                    Host APIs, knowledge base, research, message processing, and spreadsheet execution
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

## Changelog

### 2026-11-09 · Pink AI chat home

- The desktop opens directly to AI chat with suggested prompts, citations, and Q&A options.
- The sidebar opens Deeper Research, the QQ inbox, and tasks and spreadsheets.

### 2026-11-06 · Local workspace and Python commands

- Initialize, import, and search a knowledge base independently of QQ. Use Python for workspace setup, migration, and capability selection.
- Use one message ingestion service for QQ callbacks and history import. Authorized history stays available when ingress is disabled.
- Prepare spreadsheet plans from desktop submissions or QQ messages through the same workflow. Q&A offers opt-in tools for authorized lookup and spreadsheet preparation.

### 2026-11-05 · Knowledge base, task integration, and research

- Added desktop imports, local search, citations, and model Q&A with source authorization.
- Added approval-based task source admission and preparation of fresh spreadsheet plans after relevant profile changes.
- Added the Deeper Research workspace with agent discussion, budgets, controls, and report previews.

### 2026-11-03 · Android workspace

- Added Android task management, technology briefings, spreadsheet plan review, and separate device pairing.

## License

This project is licensed under the [MIT License](LICENSE), which permits use, modification, distribution, and commercial use, subject to retaining the required copyright and permission notices. The software is provided as is, without warranty.

Third-party code and dependencies remain subject to their respective licenses. Distributions must comply with the applicable copyright notice and license requirements.
