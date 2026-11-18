# Flash Server

A private release feed, update server and plugin marketplace for TheFlashMaster. It uses only the Python standard
library (3.10+) and SQLite, so it runs on a stock Ubuntu 22.04 or 24.04 with nothing to `pip install`.
The HTTP contract is in [API.md](API.md).

```
server/flashserver/   the server (copied to /opt/flash-server on the box)
deploy/               install.sh, update.sh, uninstall.sh, flash-server.service, nginx example
tests/                pytest suite:  python3 -m pytest -q flash-server/tests
```

## Quick deploy (without the admin GUI)

```bash
scp -r flash-server you@server:/tmp/
ssh you@server
sudo /tmp/flash-server/deploy/install.sh                      # listens on 127.0.0.1:8787 (use nginx or an SSH tunnel)
sudo /tmp/flash-server/deploy/install.sh --host 0.0.0.0 --open-firewall   # reachable from the LAN on port 8787
```

The last line of the output is `{"adminToken": "fs_…"}`. That token is shown **once**. Keep it in a password manager.
Running the script again is safe: it upgrades the code, keeps config and data, and prints `{"adminToken": null}`.

The script does the following:
- creates the `flash` system user
- copies the code to `/opt/flash-server`
- writes `/etc/flash-server/config.json` if it is missing
- creates `/var/lib/flash-server`
- runs `init`
- installs and starts `flash-server.service`

Other options: `--port N`, `--name "Body SW"`.

- Update the code: `sudo ./deploy/update.sh` from a newer unpacked copy. It takes a backup first, then restarts the service.
- Remove the server: `sudo /opt/flash-server/deploy/uninstall.sh`. Add `--purge` to also delete the config, the data and the user.
- Logs: `journalctl -u flash-server -f`. Each request is one line. Tokens are never logged.

## Config: `/etc/flash-server/config.json`

```json
{ "name": "Flash Server", "description": "", "host": "127.0.0.1", "port": 8787, "dataDir": "/var/lib/flash-server", "publicRead": false }
```

- `name` and `description`: shown in `/api/v1/health` and in the marketplace `index.json`.
- `publicRead: true`: anyone can read `/updates/…` and `/marketplace/…` without a token. Every other route still needs a token.
- If you move `dataDir`, also add the new path to `ReadWritePaths=` in the systemd unit.

Restart after editing: `sudo systemctl restart flash-server`.

## CLI

Run the CLI as the service user:

```bash
alias fs='sudo -u flash env PYTHONPATH=/opt/flash-server python3 -m flashserver'
```

Add `--json` to any command and it prints a JSON object on its last line.

| Command | Purpose |
|---|---|
| `fs serve --config /etc/flash-server/config.json` | Run the server. systemd does this for you. |
| `fs init --config …` | Create the data dir and DB and run migrations. Prints the first admin token, only once. |
| `fs create-user ana [--admin] --config …` | Create a user and print their token. |
| `fs import-marketplace /path/to/marketplace-example --config …` | Publish a `plugins-src/` folder as approved plugins. `files/` attachments are copied. |
| `fs publish-release ./release --version 0.5.0 --channel stable [--notes …] --config …` | Upload a local release folder and publish it. |
| `fs backup [/path/file.tar.gz] --config …` | Back up the DB (a consistent snapshot), releases, marketplace and submissions. The default location is `<dataDir>/backups/`. |
| `fs restore file.tar.gz --config …` | Restore a backup. Stop the service first. |
| `fs rebuild-index --config …` | Re-hash the published packages and rewrite `marketplace/index.json`. |

To publish releases from a build machine, use `flash-server/tools/publish_release.py` with an admin token.

## Point the app at the server

Set Settings → Server URL to `http://host:8787` (or your HTTPS URL) and paste a user token. Updates come from
`/updates/<channel>/latest.json`. The marketplace source is `<url>/marketplace`.

## Backup and restore

```bash
fs backup --config /etc/flash-server/config.json      # -> /var/lib/flash-server/backups/flash-<UTC time>.tar.gz
sudo systemctl stop flash-server
fs restore /var/lib/flash-server/backups/flash-20261118-060000.tar.gz --config /etc/flash-server/config.json
sudo systemctl start flash-server
```

Copy backups off the machine, for example with a nightly cron job that runs `backup` and then `rsync`.

## TLS with nginx

The server speaks plain HTTP. For HTTPS:
1. Keep `"host": "127.0.0.1"`.
2. Install nginx (`sudo apt install nginx`).
3. Adapt `deploy/nginx-flash-server.conf`: set the server name and certificate paths.

The example config already sets `client_max_body_size 2g` and turns off request buffering, so release uploads stream
through. Don't use `--open-firewall` for 8787. Open 443 instead: `sudo ufw allow 443/tcp`.
