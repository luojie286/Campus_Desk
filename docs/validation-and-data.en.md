# Validation Coverage, Runtime Limitations, and Data Handling

This document contains details moved out of the README. Historical validation does not establish the current runtime state.

[Back to the English README](../README_EN.md) · [简体中文](validation-and-data.md)

## Validation and Limitations

The following results are from **November 3, 2026**. They do not mean the services or phone are currently online:

- 140 backend tests, 53 Android tests, and Android debug/release builds and lint passed.
- Historical evidence covers real QQ message intake, extraction of some real attachments, and approved Tencent test-spreadsheet writes with readback. Consult the corresponding records for source and layout coverage.
- The official Android app passed real-device checks for private-network pairing, authenticated reads, reuse across process restarts, and completing, reopening, and deleting synthetic tasks.
- A synthetic task suggestion triggered a notification while the phone was on its home screen, and the user confirmed it was visible. This does not establish real QQ end-to-end notifications, validation of all three notification types, or all-day background operation.

Known limitations:

- Notifications use background polling. Automatic recovery after vendor process termination is not reliable; prolonged screen lock, network switching, and reconnection of the existing VPN remain unvalidated.
- v2 interruption recovery, browser-session mutual exclusion, and complex spreadsheet layouts need further work. Unattended filling of arbitrary spreadsheets is not guaranteed.
- KDocs/WPS and Feishu have recognition placeholders only, without implemented executors. WeChat integration is not implemented. See the [KDocs feasibility analysis (Chinese)](kdocs-feasibility.md).
- Technology briefings require scheduling configuration. An implemented feature does not mean daily delivery is enabled.
- Linux deployment, multi-user service operation, and production installer distribution are not ready for delivery.

## Data and Credentials

`.private/` stores account configuration, personal profiles, SQLite data, attachments, browser sessions, and private-network state. `.gitignore` excludes this directory, private `.env` files, database sidecars, signing files, logs, installers, and major build outputs. Dependency lockfiles and the Gradle wrapper remain in source control. Sanitized `.env` example templates may be tracked.

Model features send the content needed for processing to the configured DeepSeek service. Local storage does not mean all processing is offline. Image OCR currently runs on the host; column-mapping requests include cropped headers and the user's row. Refer to the source and design documents for the exact data boundaries.

Uploading to GitHub does not back up ignored databases, accounts, or sessions. Keep separate private backups. Before publishing a public repository, review the full Git history, commit author information, document links, and screenshots. See the [GitHub publishing guide (Chinese)](github-publishing.md).

## Evidence

The following source records are in Chinese:

- [Notification and task validation](notification-and-todos.md)
- [Embedded private networking in the official Android app](embedded-tailscale.md)
- [Real QQ and Tencent spreadsheet validation](verification/2026-10-30.md)
- [README image provenance](images/readme/README.md)
