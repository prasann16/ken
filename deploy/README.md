# Deploying ken to a server

One-command Docker Compose deploy. Tested on Hetzner; works on any Linux box with Docker.

## What you get

- ken (web UI + chat) at `https://your-domain.com`
- Local Ollama for embeddings (privacy: memory content stays on your server, never to a third party)
- Caddy reverse proxy with auto Let's Encrypt TLS
- Bearer token auth so randos hitting the URL get rejected
- All data in `/srv/ken/data/` — a regular file you can `rsync` for backups

## One-time setup

Run on the server:

```sh
# 1. Install Docker (Debian/Ubuntu)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Clone this repo
git clone <your-ken-repo-url> ~/ken
cd ~/ken/deploy

# 3. Set env vars
cp .env.example .env
echo "KEN_TOKEN=$(openssl rand -hex 32)" >> .env
# Then edit .env to add your ANTHROPIC_API_KEY

# 4. Pick the right Caddy config
#    With a domain (recommended — auto-TLS):
sed -i "s/ken.yourdomain.com/<your.domain>/g" Caddyfile
#    Without a domain (self-signed cert, browser warns once):
cp Caddyfile.iponly Caddyfile

# 5. Make data dirs (host-side, bind-mounted by compose)
sudo mkdir -p /srv/ken/data /srv/ken/ollama /srv/ken/caddy
sudo chown -R $USER:$USER /srv/ken

# 6. Up
docker compose up -d

# 7. Pull the embedding model (one time, ~270MB download)
docker exec ken-ollama ollama pull nomic-embed-text
```

If you used a domain, point its A record at this server's IP. Caddy will get a Let's Encrypt cert automatically on first request to `https://<your.domain>`.

## Open in your browser

`https://<your.domain>` (or `https://<server-ip>` if IP-only).

You'll see a token prompt. Paste the value of `KEN_TOKEN` from your `.env`. It's stored in your browser's localStorage so you only do this once per device.

## Updates

```sh
cd ~/ken && git pull
cd deploy && docker compose build ken && docker compose up -d ken
```

`ollama` and `caddy` rarely need updates; pull them when you want:
```sh
docker compose pull ollama caddy && docker compose up -d
```

## Logs

```sh
docker compose logs -f ken      # ken's stdout/stderr
docker compose logs -f caddy    # tls / proxy events
docker compose logs -f ollama   # embedding requests
```

## Backups

The database is at `/srv/ken/data/ken.db`. Two simple options:

**Hetzner snapshots** (recommended): toggle on in Hetzner console. ~5% of monthly cost. Whole-disk snapshot daily, restore is one click.

**rsync to another machine**:
```sh
# On the other machine, daily cron:
rsync -a user@hetzner:/srv/ken/data/ ~/backups/ken/$(date +%F)/
```

**Git versioned offsite** (fancier):
```sh
cd /srv/ken/data
git init
git remote add origin git@github.com:you/ken-backup.git
# Daily cron:
0 3 * * * cd /srv/ken/data && git add -A && git commit -m "$(date)" && git push
```

## Where data lives

| Path | What |
|---|---|
| `/srv/ken/data/ken.db` | The SQLite database. **This is your memories.** |
| `/srv/ken/data/config.toml` | Server config (auto-created on first run) |
| `/srv/ken/ollama/` | Ollama model cache (~300MB once `nomic-embed-text` is pulled) |
| `/srv/ken/caddy/` | Caddy's data dir (TLS certs, etc.) |

`docker compose down` removes containers but keeps these directories. `docker compose down -v` does NOT touch them either, since they're bind mounts not named volumes.

## Stopping

```sh
docker compose stop          # pause everything (data preserved)
docker compose down          # remove containers (data preserved on host)
docker compose down -v       # also remove named volumes (we don't use them; data still safe)
```

To fully nuke including data: `sudo rm -rf /srv/ken`.
