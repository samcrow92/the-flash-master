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

## 3b. Release from your own Windows machine

`scripts/release.py` does the whole release locally, standard library only (Python 3.9+):

```powershell
py -3 scripts/release.py --dry-run   # check tools, auth and version; build and change nothing
py -3 scripts/release.py             # suggests the next version, builds, uploads, publishes
```

1. **Preflight**: Windows, git, Node 22.13+, `node_modules`, a clean working tree, the commit already pushed to the
   remote, and write access to the repository. Credentials come from `GH_TOKEN` / `GITHUB_TOKEN`
   (`GH_ENTERPRISE_TOKEN` for Enterprise hosts) or the GitHub CLI login (`gh auth login --hostname <host>`).
2. **Version**: the newest release on the git remote (`--remote`, default `origin`) is the current version;
   package.json is used when there is none. It suggests the patch bump and offers minor, major or a custom version
   (`--bump minor`, `--version 1.0.0-beta.1`). Versions with a suffix are published as pre-releases.
3. **Build**: stamps the version into package.json for the build only (restored afterwards), runs `npm run ci`
   (`--skip-checks` to skip), `electron-builder --win --x64`, `release-manifest.mjs` and writes `SHA256SUMS.txt`.
   Set `CSC_LINK` / `CSC_KEY_PASSWORD` to sign. Full output goes to `release/release-script.log`.
4. **Publish**: creates a draft release on the pushed commit, uploads the executables, `latest.json`,
   `SHA256SUMS.txt` (and `.blockmap` / `latest.yml` when the build makes them) with progress bars, checks every file
   arrived, then publishes. The tag only appears at that last step. If an upload fails the draft is kept:
   `py -3 scripts/release.py --skip-build --version <version>` resumes it.

Publishing creates the tag, which starts `release.yml`; it sees that the release already has `latest.json` and
skips its own build. Other options: `--notes` / `--notes-file`, `--draft`, `--no-publish`, `--yes`, `--help`.
Behind a TLS-inspecting proxy, set `HTTPS_PROXY` and point `SSL_CERT_FILE` at the company root CA if needed.

## 4. Private or internal repositories

Users need read access to the releases. Two ways, both in **Settings → About**:

- **Sign in to GitHub** — opens your GitHub in an app window (company SSO works); the session is kept
  for update checks only.
- **Token** — a read-only token (fine-grained: *Contents: read*) stored encrypted. Useful for kiosk or
  shared machines; can be distributed by IT.

## 5. Internal mirror instead of GitHub

Copy the three files to any web folder and set the update source to that folder (or its `latest.json`).
File names in `latest.json` are resolved relative to it; `baseUrl` in the manifest can point elsewhere.

## 6. Flash server (optional)

When a Flash server is set (**Settings → Flash server**, `package.json → flashmaster.server.url`, or the policy key
`server.url`), the app checks `<server>/updates/<channel>/latest.json` first and downloads the release files from the
same folder, sending the user's server token (`Authorization: Bearer …`). If the server can't be reached or answers
with an HTTP error, the app falls back to the repository feed above (when one is configured). **About → Updates**
shows which source answered (*from Flash server* / *from repository*) and why the server was skipped.
The server token only goes to the server and the GitHub token/sign-in only to the repository; the two never mix.
Publishing releases to the server: see `flash-server/API.md` (Releases) and the server guide.

## Behaviour

- Checks at start (after ~15 s) and every 6 hours; downloads in the background (can be turned off).
- The sidebar shows **Update x.y available** / **Restart to update**; installing always asks.
- Running from source (`npm run dev`) only reports updates; it never installs.
- Proxy settings (Settings → Network or `https_proxy`) are used for update traffic.
