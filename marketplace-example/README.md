# Example team marketplace

Build and serve:

```bash
node scripts/marketplace/build-index.mjs marketplace-example --name "Example department"
cd marketplace-example && python -m http.server 8080
```

Then, in TheFlashMaster: Settings → Marketplace → Add marketplace → `http://<this-PC-IP>:8080`.
