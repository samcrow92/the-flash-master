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
    "jazz": { "enabled": true, "serverUrl": "https://jazz.corp.example/ccm", "authType": "form", "projectAreas": ["Body Electronics", "Powertrain"] },
    "tokens": { "dailyBudget": 2000000, "onBudgetExceeded": "pause" }
  },
  "lock": ["network", "mcp.pipIndexUrl", "permissions.blockedCommands", "jazz.serverUrl"]
}
```

Locked keys are greyed out in Settings and ignored if written. If `lock` is omitted, every key in `settings` is locked.

## Network

**Default: environment variables.** If `https_proxy` / `http_proxy` / `no_proxy` are set (the usual enterprise setup), TheFlashMaster uses them everywhere, with nothing to configure:
- the Electron binary download during `npm run dev` / build
- harness processes, MCP servers and pip (inherited)
- the app's own network stack for Jazz (applied at startup)

Without them it falls back to the Windows system proxy. `127.0.0.1` / `localhost` are always bypassed for the app's internal bridge. A value in Settings → Network overrides the environment.

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

## IBM Jazz sign-in

| `jazz.authType` | When to use |
|---|---|
| `form` | Default EWM/RTC login page (j_security_check). Expired sessions are renewed automatically. |
| `basic` | Servers that answer `WWW-Authenticate: Basic`, or an application password. |
| `windows` | Kerberos/NTLM single sign-on with the user's domain login (no password stored). The server host is allow-listed for Chromium's integrated auth. Restart the app after changing the URL. |

If a request returns HTTP 401, TheFlashMaster reads the server's `WWW-Authenticate` header and tells the user which mode to pick. Servers behind the Jazz Authorization Server (OIDC) cannot use form login. Use `windows`, or `basic` with an application password.

## Copilot usage meter

`usage.copilotMeter`, `usage.refreshMinutes` and `usage.onlyIfAdvertised` can be preset or locked. With `onlyIfAdvertised: true` (the default), `/usage` is sent only when Copilot CLI lists it as a built-in command, so no premium request is spent.
