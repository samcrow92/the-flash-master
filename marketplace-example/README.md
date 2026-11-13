# Example team marketplace

Build and serve:

```bash
node scripts/marketplace/build-index.mjs marketplace-example --name "Example department"
cd marketplace-example && python -m http.server 8080
```

Then, in TheFlashMaster: Settings → Marketplace → Add marketplace → `http://<this-PC-IP>:8080`.

## EXAM setup for a team (`exam-team-setup`)

`plugins-src/exam-team-setup/exam.json` publishes the team's EXAM settings. When someone installs the plugin,
TheFlashMaster fills in the empty fields in **Settings → Integrations → EXAM** (values people set themselves are kept),
installs the EXAM RESTapi plugin and checks the setup.

1. Put the RESTapi plugin package you license from MicroNova in `files/`: a `.jar`, a `.zip` with `plugins/` (and
   `features/`), or a zipped p2 update site.
2. Set `"pluginPackage": "files/<name>"` in `exam.json`. Relative paths are downloaded from this marketplace. An
   `http(s)://` URL or a `\\server\share\…` path also works.
3. Re-run `build-index.mjs`. The build fails if the package file is missing.

Keep the plugin on an internal server: it's licensed software.
