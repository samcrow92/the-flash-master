# Marketplace — sharing agents, workflows and instructions across teams

Each department can run its own **marketplace**: a folder of plugins served by any plain HTTP server on the internal
network. Users add one or more marketplaces in **Settings → Marketplace** (name, department and `IP:port`), then browse and
install plugins in **🧩 Marketplace** in the sidebar.

## What a plugin can contain

| Content | Becomes in TheFlashMaster |
|---|---|
| `agents/*.md` | Specialists in the sidebar, `@mention`-able, and available to the coordinator for delegation (same format as `agents/_template.md`) |
| `workflows/*.md` | Slash commands in every chat (`/command`). The header needs `name:`, `command:` and `description:` |
| `skills/*.md` | Skills, installed like workflows (`/command`); the command is the header's `command:` or the file name |
| `scripts/*` | Helper scripts (`.py .ps1 .sh .js .mjs .bat .cmd .txt .json .yml .yaml`, ≤ 200 KB each), stored in `<data folder>/plugins/<id>/scripts/`; agents get a line listing their paths so they can run them |
| `instructions.md` | Team rules added to every agent while the plugin is installed. Users can switch this off per plugin |
| `mcp.json` | Tool servers (`[{ "id", "label", "command", "args", "env" }]`). They run programs, so they are only enabled when policy allows; otherwise they are added disabled under Settings → MCP |

## Publish a marketplace (team side)

```
my-marketplace/
  plugins-src/
    body-sw-test-pack/
      plugin.json        { "id": "body-sw-test-pack", "name": "…", "version": "1.0.0", "description": "…", "team": "…", "tags": [] }
      agents/hil-tester.md
      workflows/hil-campaign.md
      skills/hil-report.md    (optional)
      scripts/collect-logs.py (optional)
      instructions.md    (optional)
      mcp.json           (optional)
```

```bash
node scripts/marketplace/build-index.mjs my-marketplace --name "Body Electronics" --description "Agents and workflows of the Body teams"
cd my-marketplace && python -m http.server 8080          # or IIS, nginx, any static server
```

The script validates every plugin and writes `index.json` plus `plugins/<id>-<version>.json` with a **sha256** per package.
Users add `http://<server-ip>:8080` in Settings → Marketplace. See `marketplace-example/` for a working example.

**Updating:** bump `version` in `plugin.json` and re-run the script. Users get an "updates available" notice and an
**Update all** button. An update replaces exactly the files the previous version installed.

## Rules the app enforces

- If the index lists a sha256 for a package (the script always adds it), the downloaded package must match it.
- Every agent and workflow is validated before anything is written, so a bad plugin never half-installs.
- A plugin cannot overwrite a user's own agent or an agent/workflow owned by another plugin.
- Uninstall removes exactly what the plugin installed. Installed plugins keep working if the marketplace goes offline.
- Marketplace hosts always bypass the corporate proxy (they are internal servers).
- Administrators can preset and lock the marketplace list in `%PROGRAMDATA%\TheFlashMaster\policy.json`:
  `{"settings":{"marketplace":{"sources":[{"id":"body","name":"Body Electronics","department":"Body","url":"http://10.1.2.3:8080","enabled":true}]}},"lock":["marketplace.sources"]}`

## Flash server

A Flash server (`flash-server/`, contract in `flash-server/API.md`) is a private marketplace with review. Set its URL and your
token in **Settings → Flash server** (or ship the URL in `package.json → flashmaster.server.url`, or preset/lock `server.url`
by policy) and press **Test connection**. Then:

- The server's catalogue appears in the Marketplace as the source **flash-server** (named after the server). Its requests carry
  your token; plugins install exactly like the ones above.
- **Submit** sends a plugin for review: pick a folder in the `plugins-src/<id>/` layout above, or single files (an agent, a
  workflow or skill `.md`, a script) and fill id / name / version. **Check** validates it with the same rules install uses
  (nothing is sent); **Submit** posts it. Errors are listed one per line.
- **My submissions** shows each submission's status (pending, approved, changes requested, rejected, withdrawn), the reviewer's
  feedback, and lets you withdraw a pending one or resubmit after *changes requested*. The app checks every 15 minutes and on
  Refresh, and shows a notice when a status changes.

