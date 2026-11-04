# Usage Limitations and Data Handling

[Back to README](../README_EN.md) · [简体中文](validation-and-data.md)

## Usage Limitations

- The current target is a single-user, single-host Windows setup. Some tool paths need adjustment for your machine.
- Spreadsheet execution is implemented for Tencent Docs. KDocs/WPS, Feishu, and WeChat integration are not implemented.
- Spreadsheets need readable headers and a uniquely identifiable user row. Complex sections, protected ranges, and different editor layouts are not guaranteed to work.
- Phone notifications use background polling. The OS or device vendor may delay or stop synchronization; automatic recovery after process termination and all-day reliability still need work.
- The host must remain online and awake. Daily briefings require scheduling configuration. Private-network connectivity does not establish QQ login status.
- v2 interruption recovery and browser-session mutual exclusion need further work. An uncertain write enters `outcome_unknown`; verify before taking further action instead of repeating the write.
- The Android native library currently targets arm64. Debug APKs are for testing, and production signing is not configured.

## Data and Credentials

Account configuration, personal profiles, SQLite data, attachments, browser sessions, and private-network state live under `.private/` and are excluded by `.gitignore`. Private `.env` files, database sidecars, signing files, logs, and major build outputs should also remain untracked. Sanitized configuration templates, dependency lockfiles, and the Gradle wrapper may be distributed with the source.

DeepSeek performs some message analysis, column mapping, and briefing summarization. Requests send the content needed for processing; column mapping includes cropped headers and the user's row. Local storage does not imply fully offline processing. Image OCR currently runs on the host.

Private phone access uses a separate device token; newly paired phones do not receive the host master token. Keep tokens, invitations, QR codes, and sessions out of public screenshots and logs. If a phone is lost, revoke both its application access and its private-network node.

GitHub stores version-controlled source, not ignored private data. Back up databases and sessions separately. Before public distribution, review the complete Git history as well as the current files.

See the [runtime and pairing guide (Chinese)](setup.md) for setup steps.
