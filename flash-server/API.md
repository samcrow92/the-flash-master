# Flash Server — API contract

The single source of truth shared by the three parts:

- `flash-server/server/` — the server (Python 3.10+ standard library only, SQLite). Runs on Ubuntu under systemd.
- `flash-server/admin/` — the admin GUI Mari runs locally (PySide6 + paramiko + pyte). Talks to the server over an SSH tunnel.
- `src/main/*` — TheFlashMaster app (updates, marketplace browse/install/upload, submission status).

Change this file first when the contract changes.

## Basics

- Base URL: `http(s)://<host>[:port]` (default port **8787**; nginx/TLS in front is optional). No path prefix.
- JSON everywhere (`Content-Type: application/json; charset=utf-8`), UTF-8, timestamps are ISO-8601 UTC strings.
- Errors: HTTP status + `{ "error": "<human readable>", "code": "<snake_case>" }`.
  Codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `too_large` (413), `invalid` (400/422).
- Auth: `Authorization: Bearer <token>`. `Authorization: token <token>` is accepted too (the app's updater sends that form).
  Tokens are random (`fs_` + 40 url-safe chars), stored as SHA-256 hashes, shown once.
- Roles: `user` (browse, download, submit, see own submissions) and `admin` (everything).
- The server is **private**: every route except `GET /api/v1/health` needs a valid token, unless the server config sets
  `public_read = true` (then the read routes in "Compatible static routes" work anonymously; submitting still needs a token).
- Request body limit: 2 MB for JSON (same as the app's `MAX_PACKAGE`); release file uploads are streamed (limit 2 GB).

## Compatible static routes (what the app already understands)

These keep the exact formats the app already reads, so an older app build works with only a URL change.

| Route | Body | App code |
|---|---|---|
| `GET /updates/<channel>/latest.json` | `UpdateManifest` (below) | `src/main/updater.ts` folder feed |
| `GET /updates/<channel>/<file name>` | the release file (streamed, `Content-Length`, `Range` not required) | updater download |
| `GET /updates/latest.json` | alias of `stable` | |
| `GET /marketplace/index.json` | `{ name, description, plugins: PluginEntry[] }` — approved, newest version per id | `src/main/marketplace.ts` |
| `GET /marketplace/plugins/<id>-<version>.json` | `PluginPackage` | marketplace install |
| `GET /marketplace/files/<name>` | attachment file (e.g. the EXAM RESTapi jar) | `ExamPreset.pluginPackage` |

`<channel>` is `stable` or `beta`. `beta/latest.json` is the newest of stable and beta.

```jsonc
// UpdateManifest (unchanged from scripts/release-manifest.mjs)
{ "version": "0.5.0", "date": "2026-11-18T06:00:00Z", "notes": "…",
  "files": [ { "kind": "setup" | "portable", "name": "TheFlashMaster-0.5.0-x64-setup.exe", "sha256": "<hex>", "size": 123 } ] }
```

`PluginEntry` (index entry): `{ id, name, version, description, team, kinds, tags, package: "plugins/<id>-<version>.json", sha256, updated, author }`.
`sha256` is the SHA-256 of the exact bytes served at `package`.

### PluginPackage (extended)

Same as `src/shared/types.ts` `PluginPackage`, with two new optional arrays. Content is inline text.

```jsonc
{
  "id": "body-sw-test-pack",            // ^[a-z0-9][a-z0-9._-]{1,63}$
  "name": "Body SW test pack", "version": "1.2.0", "description": "…", "team": "Body",
  "tags": ["hil"],
  "agents":    [ { "file": "hil-tester.md",   "content": "---\nname: …" } ],   // ^[\w.-]+\.md$
  "workflows": [ { "file": "hil-campaign.md", "content": "---\ncommand: …" } ], // slash commands
  "skills":    [ { "file": "unslop.md",       "content": "---\nname: …" } ],   // NEW: skills, installed like workflows (command = header `command:` or file name)
  "scripts":   [ { "file": "flash.ps1",       "content": "…" } ],              // NEW: ^[\w.-]+\.(py|ps1|sh|js|mjs|bat|cmd|txt|json|ya?ml)$, ≤ 200 KB each
  "instructions": "Team rules …",
  "mcpServers": [ { "id": "can-tools", "label": "CAN tools", "command": "python", "args": "-m can_mcp", "env": "" } ], // "tools"
  "exam": { /* ExamPreset */ }
}
```

`kinds` (derived by the server, never trusted from the client): `agent`, `workflow`, `skill`, `script`, `instructions`, `mcp`, `exam`.
An item that is a single agent / workflow / skill / script is still a package with one entry, so everything installs and
updates the same way.

## Account

`GET /api/v1/health` (no auth) → `{ "ok": true, "name": "<server name>", "version": "<server version>", "publicRead": false }`

`GET /api/v1/me` → `{ "id": 3, "name": "ana", "role": "user" | "admin" }`

## Submissions (users, from the app)

```jsonc
// Submission
{ "id": 12, "pluginId": "body-sw-test-pack", "version": "1.2.0", "name": "…", "kinds": ["agent","workflow"],
  "status": "pending" | "approved" | "rejected" | "changes_requested" | "withdrawn",
  "notes": "what the author wrote", "feedback": "what the reviewer wrote" | null,
  "author": "ana", "createdAt": "…", "reviewedAt": "…" | null, "reviewer": "mari" | null }
```

- `POST /api/v1/submissions` body `{ "package": PluginPackage, "notes": "…" }` → `201 Submission`.
  Server checks: id/version format, file name patterns, size limits, at least one item, `version` not already published
  for that id (`409 conflict`), and plugin **ownership**: the first approved author owns the id; another user's submission
  for an owned id → `403 forbidden` (admins can submit any id). A `pending` or `changes_requested` submission for the
  same id+version by the same author is replaced and goes back to `pending` (returns the updated one, `200`); the
  reviewer's last feedback stays on it.
- `GET /api/v1/submissions` → `{ "submissions": Submission[] }` — the caller's own, newest first. Admins get their own too
  (use the admin route for everyone's).
- `GET /api/v1/submissions/<id>` → `Submission` plus `"package": PluginPackage` (own only, or admin).
- `DELETE /api/v1/submissions/<id>` → withdraw a `pending` / `changes_requested` one → `Submission`.

## Admin (admin GUI, release script)

- `GET /api/v1/admin/stats` → `{ users, plugins, pendingSubmissions, releases: { stable, beta }, diskFreeBytes, dataDir, uptimeSeconds }`
- `GET /api/v1/admin/submissions?status=pending` (status optional, `all` = everything) → `{ "submissions": Submission[] }`
- `GET /api/v1/admin/submissions/<id>` → `Submission` + `package` + `"diff": { "previousVersion": "1.1.0" | null, "files": [ { "path": "agents/x.md", "change": "added"|"removed"|"modified", "before": "…", "after": "…" } ] }`
- `POST /api/v1/admin/submissions/<id>/review` body `{ "decision": "approve" | "reject" | "changes_requested", "feedback": "…" }` → `Submission`.
  `reject` and `changes_requested` need non-empty feedback. `approve` publishes the package (writes
  `marketplace/plugins/<id>-<version>.json`, regenerates `index.json`) atomically.
- `GET /api/v1/admin/plugins` → `{ "plugins": [ { id, name, owner, versions: [ { version, publishedAt, sha256 } ], latest } ] }`
- `DELETE /api/v1/admin/plugins/<id>` (all versions) or `DELETE /api/v1/admin/plugins/<id>/<version>` → `{ "ok": true }` (unpublish, index regenerated)
- `GET /api/v1/admin/users` → `{ "users": [ { id, name, role, createdAt, lastSeenAt, disabled } ] }`
- `POST /api/v1/admin/users` body `{ "name": "ana", "role": "user" }` → `{ "user": User, "token": "fs_…" }` (token shown once)
- `POST /api/v1/admin/users/<id>/token` → `{ "token": "fs_…" }` (rotate; the old token stops working)
- `PATCH /api/v1/admin/users/<id>` body `{ "disabled": true, "role": "admin" }` → `User`
- `DELETE /api/v1/admin/users/<id>` → `{ "ok": true }`

### Releases

- `GET /api/v1/admin/releases` → `{ "releases": [ { version, channel, date, notes, files: [ {kind,name,sha256,size} ], published } ], "current": { stable, beta } }`
- `PUT /api/v1/admin/releases/<version>/files/<name>?sha256=<hex>` raw body (`application/octet-stream`, streamed)
  → `{ name, size, sha256 }`. Creates a draft release if needed. The server verifies the hash when given (`422` on mismatch).
  `<name>` must match `^[\w.-]+$`; `latest.json` / `SHA256SUMS.txt` uploads are accepted and kept as files.
- `POST /api/v1/admin/releases/<version>/publish` body `{ "channel": "stable" | "beta", "notes": "…" }` → release.
  Needs at least one `.exe` whose name contains the version. The server writes the release's `latest.json`
  (`kind` = `portable` when the name contains "portable", else `setup`) and points the channel at it.
- `POST /api/v1/admin/releases/<version>/promote` body `{ "channel": "stable" }` → release (move a beta to stable, or roll back
  stable to an older version).
- `DELETE /api/v1/admin/releases/<version>` → `{ "ok": true }` (refused with `409` while a channel points at it).

## Server layout on Ubuntu

```
/opt/flash-server/            code (flashserver package) — replaced on every deploy
/etc/flash-server/config.json { "name", "host": "127.0.0.1" | "0.0.0.0", "port": 8787, "dataDir", "publicRead": false }
/var/lib/flash-server/        dataDir (owned by the `flash` system user)
  flash.db                    SQLite (users, tokens, plugins, versions, submissions, releases)
  releases/<version>/…        release files
  marketplace/plugins/*.json  published packages (generated)
  marketplace/files/*         attachments
  marketplace/index.json      generated
  submissions/<id>.json       submitted packages
  backups/                    `flashserver backup` output
systemd unit: flash-server.service (python3 -m flashserver serve --config /etc/flash-server/config.json)
```

CLI on the server (`sudo -u flash python3 -m flashserver <cmd> --config …`): `serve`, `init`, `create-user <name> [--admin]`,
`import-marketplace <dir>` (a `plugins-src/` folder as used by `scripts/marketplace/build-index.mjs`, published as approved),
`publish-release <dir> --version X --channel stable [--notes …]`, `backup <file.tar.gz>`, `restore <file.tar.gz>`, `rebuild-index`.
Commands print JSON on the last line when `--json` is given (the admin GUI parses it).

## App settings

`Settings.server = { url: string; hasToken: boolean }` (token kept in the app's secret store, like the updater token).
Built-in default: `package.json → flashmaster.server.url`. When a server is set:
- updates check `<url>/updates/<channel>/latest.json` with the token first; on a network/HTTP error they fall back to the
  repository feed (`flashmaster.updates.url` / `updates.feedUrl`) when one is configured.
- the server is listed as the marketplace source `flash-server` (requests carry the token).
- the Marketplace view gets **Submit** (folder in the `plugins-src/<id>/` layout, or single `.md`/script files) and
  **My submissions** (status + reviewer feedback). A status change shows a notice.
