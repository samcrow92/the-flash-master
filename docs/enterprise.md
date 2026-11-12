# Enterprise deployment

## Distribution

- **Portable** (`…-x64-portable.exe`): a single file, nothing to install. Data lives in `%APPDATA%\TheFlashMaster`. To keep the data next to the exe, set the environment variable `FLASH_DATA_DIR=<folder>`.
- **Installer** (`…-x64-setup.exe`): a per-user NSIS installer (`perMachine: false`). It needs no admin rights and lets the user choose the folder.
- **Code signing:** add the repository secrets `WIN_CSC_LINK` (a base64 `.pfx` or a URL) and `WIN_CSC_KEY_PASSWORD`. The release workflow then signs both executables. Unsigned builds work, but SmartScreen will warn.
- **No telemetry, no auto-update, no login.** Updates are new releases that you distribute.

## Policy file (preset and lock settings)

Create `%PROGRAMDATA%\TheFlashMaster\policy.json`:

```json
{
  "settings": {
    "network": { "proxy": "http://proxy.corp.example:8080", "caBundlePath": "C:\\Corp\\ca-bundle.pem" },
    "mcp": { "pipIndexUrl": "https://artifactory.corp.example/api/pypi/pypi/simple" },
    "permissions": { "approval": "auto-read", "blockedCommands": "git push --force\nformat c:" },
    "jazz": { "enabled": true, "serverUrl": "https://jazz.corp.example/ccm", "authType": "form" },
    "tokens": { "dailyBudget": 2000000, "onBudgetExceeded": "pause" }
  },
  "lock": ["network", "mcp.pipIndexUrl", "permissions.blockedCommands", "jazz.serverUrl"]
}
```

Locked keys are greyed out in Settings and ignored if written. If `lock` is omitted, every key in `settings` is locked.

## Network

- The proxy, no-proxy list and CA bundle are passed to the harness processes (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`), to the MCP servers and to pip.
- Jazz requests go through Electron's network stack, which uses the **system proxy and the Windows certificate store**.
- **Offline mode** skips MCP installs at startup.

## Credentials

- **Harnesses:** the app uses whatever sign-in each CLI already has. It never sees or stores those tokens.
- **Jazz:** the password is encrypted with Electron `safeStorage` (Windows DPAPI, bound to the user account) in `jazz.secret`. It is never written to `settings.json`.

## Agent permissions

- **Tool approval:** *Ask* posts an approval message in the chat (react ✅ or ❌). *Auto-approve reads* asks only for edits, deletes, moves and command execution. *Auto-approve all* asks for nothing.
- **Read-only mode:** denies every write and every command, and disables the ACP `fs/write_text_file` capability.
- **Blocked commands:** any tool call containing one of the listed substrings is denied.
- **File access:** file reads and writes served by the app are confined to the project folder.
- **GitLab Duo:** headless mode auto-approves Duo's own tools, so Duo agents are flagged in the UI.

## MCP servers and Python

Python 3.10+ is required only for `vector-autosar` and `winidea`. On first start the app:

1. copies the servers to `%APPDATA%\TheFlashMaster\mcp`
2. creates a private venv
3. installs `requirements.txt` (cantools and pywin32; `isystem.connect` for winIDEA)

If your machines can't reach PyPI, set a mirror with `mcp.pipIndexUrl`. You can also point **Settings → winIDEA → SDK path** at the SDK folder that ships with winIDEA.

## Data

SQLite database: `%APPDATA%\TheFlashMaster\flashmaster.db`. Logs: `…\logs\main.log`.

- **Retention:** *Settings → Data → Retention* removes old usage records, artifacts and finished agent runs at startup.
- **Export:** *Export JSON* dumps everything.
