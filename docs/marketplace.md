# Marketplace — sharing agents, workflows and instructions across teams

Each department can run its own **marketplace**: a folder of plugins served by any plain HTTP server on the internal
network. Users add one or more marketplaces in **Settings → Marketplace** (name, department, `IP:port` or URL, and an optional
access token), then browse and install plugins in **🧩 Marketplace** in the sidebar.

## What a plugin can contain

| Content | Becomes in TheFlashMaster |
|---|---|
| `agents/*.md` | Specialists in the sidebar, `@mention`-able, and available to the coordinator for delegation (same format as `agents/_template.md`) |
| `workflows/*.md` | Slash commands in every chat (`/command`). The header needs `name:`, `command:` and `description:` |
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
      instructions.md    (optional)
      mcp.json           (optional)
```

```bash
node scripts/marketplace/build-index.mjs my-marketplace --name "Body Electronics" --description "Agents and workflows of the Body teams"
cd my-marketplace && python -m http.server 8080          # or IIS, nginx, any static server
```

The script validates every plugin and writes `index.json` plus `plugins/<id>-<version>.json` with a **sha256** per package.
Users add `http://<server-ip>:8080` in Settings → Marketplace. See `marketplace-example/` for a working example.

**Updating:** bump `version` in `plugin.json` and re-run the script. Users see "Update available" (or get it automatically
if *Install updates automatically* is on). An update replaces exactly the files the previous version installed.

**Access control:** for a protected server, require an `Authorization: Bearer <token>` header (reverse proxy) and give users
the token. It is stored encrypted on their PC.

## Rules the app enforces

- Packages must match the sha256 in the index (unless *Require integrity checksums* is switched off).
- Every agent and workflow is validated before anything is written, so a bad plugin never half-installs.
- A plugin cannot overwrite a user's own agent or an agent/workflow owned by another plugin.
- Uninstall removes exactly what the plugin installed. Installed plugins keep working if the marketplace goes offline.
- Marketplace hosts always bypass the corporate proxy (they are internal servers).
- Administrators can preset and lock the marketplace list in `%PROGRAMDATA%\TheFlashMaster\policy.json`:
  `{"settings":{"marketplace":{"sources":[{"id":"body","name":"Body Electronics","department":"Body","url":"http://10.1.2.3:8080","enabled":true,"hasToken":false}]}},"lock":["marketplace.sources"]}`
