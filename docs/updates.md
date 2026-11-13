# App updates

TheFlashMaster updates itself from the releases of **your** repository: github.com, GitHub Enterprise
Server (for example `https://github.company.com`), or any web folder (internal mirror).

## 1. Point the app at your repository (once, in the repo)

`package.json`:

```json
"flashmaster": {
  "updates": {
    "url": "https://github.company.com/team/the-flash-master",
    "channel": "stable"
  }
}
```

The value is built into every package, so all installed copies know where to look. It can be overridden
per machine in **Settings → About → Update source**, or for everyone through the enterprise policy
(`updates.feedUrl`, see `docs/enterprise.md`). A build-time override is also possible: `FLASH_UPDATE_URL`.

## 2. What a release must contain

A release tagged `v<version>` (the version in `package.json`) with three files:

| File | Purpose |
|---|---|
| `TheFlashMaster-<version>-x64-setup.exe` | update for installed copies (runs silently, restarts the app) |
| `TheFlashMaster-<version>-x64-portable.exe` | update for the portable exe (replaces itself in place) |
| `latest.json` | manifest: version, file names, SHA-256, size (downloads are verified) |

## 3. Pipeline steps (any CI: GitHub Actions on GHE, Jenkins, Azure DevOps…)

```bash
npm ci
npm version 0.5.0 --no-git-tag-version   # the release version (or set it from the tag)
npm run ci -- --smoke                    # optional: checks
npx electron-builder --win --x64 --publish never
node scripts/release-manifest.mjs --notes "What changed"
# create release v0.5.0 and upload release/*.exe + release/latest.json
```

`npm run dist:win` runs build, packaging and the manifest in one go. The repository's
`.github/workflows/release.yml` shows the complete flow for GitHub Actions (works on GitHub Enterprise with
Actions enabled): it runs on a pushed tag `v*` and uploads the three files with `gh release upload`.
With the GitHub CLI against an Enterprise host, set `GH_HOST=github.company.com`.

Pre-releases are only offered to users who choose **Include pre-releases**.

## 4. Private or internal repositories

Users need read access to the releases. Two ways, both in **Settings → About**:

- **Sign in to GitHub** — opens your GitHub in an app window (company SSO works); the session is kept
  for update checks only.
- **Token** — a read-only token (fine-grained: *Contents: read*) stored encrypted. Useful for kiosk or
  shared machines; can be distributed by IT.

## 5. Internal mirror instead of GitHub

Copy the three files to any web folder and set the update source to that folder (or its `latest.json`).
File names in `latest.json` are resolved relative to it; `baseUrl` in the manifest can point elsewhere.

## Behaviour

- Checks at start (after ~15 s) and every 6 hours; downloads in the background (can be turned off).
- The sidebar shows **Update x.y available** / **Restart to update**; installing always asks.
- Running from source (`npm run dev`) only reports updates; it never installs.
- Proxy settings (Settings → Network or `https_proxy`) are used for update traffic.
