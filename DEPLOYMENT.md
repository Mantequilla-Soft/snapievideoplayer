# Deployment

Deployment is automated: `.github/workflows/deploy.yml` runs on every push to
`master` (which only happens via an approved, merged PR — `master` is
protected). It SSHes into the VPS, checks out the merged commit, runs
`npm ci && npm run build`, prunes dev dependencies, and restarts the
`snapie-player` systemd service.

`.github/workflows/ci.yml` runs lint, test, and build on every pull request
and is required to pass before a PR can be merged.

## One-time VPS setup
- [ ] VPS has Node.js v20+ installed (matches `engines` in `package.json` / CI)
- [ ] Repository cloned to `/var/www/snapie-player`
- [ ] `.env` created on the VPS with production values (see below) — never committed to git
- [ ] A systemd service named `snapie-player` runs `node server.js` from that path, with restart-on-failure enabled
- [ ] Nginx configured at `/etc/nginx/sites-available/play.3speak.tv`, enabled via `sites-enabled`, `nginx -t` passes, SSL via certbot

## Production .env settings
```bash
NODE_ENV=production
PORT=3005
MONGODB_URI=mongodb://username:password@host:port/threespeak
IPFS_GATEWAY=https://ipfs.3speak.tv/ipfs
ALLOWED_ORIGINS=https://play.3speak.tv,https://3speak.tv
```

## Verifying a deploy
- [ ] Check the "Deploy to VPS" run in GitHub Actions succeeded
- [ ] `systemctl status snapie-player` is active
- [ ] `journalctl -u snapie-player -f` for logs
- [ ] `curl http://localhost:3005/api/watch?v=meno/p723so6v`
- [ ] Visit `https://play.3speak.tv/watch?v=meno/p723so6v`, verify thumbnails, playback, quality selector, view counter
- [ ] Test embed route: `/embed?v=testuser123/ma4k9uzo`

## Rollback
Push a revert PR through the normal review flow, or manually on the VPS:
```bash
cd /var/www/snapie-player
git checkout --force <last-good-sha>
npm ci && npm run build
sudo systemctl restart snapie-player
```

## Local pre-PR checklist
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `./safety-check.sh` (checks `.env` is gitignored and no hardcoded Mongo credentials are tracked)
