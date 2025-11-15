# Deployment Checklist

## Pre-Deployment
- [ ] Run `./safety-check.sh` - all checks pass
- [ ] `.env` is NOT committed to git
- [ ] No hardcoded credentials in code
- [ ] README.md is up to date
- [ ] All features tested locally

## VPS Deployment
- [ ] VPS has Node.js v16+ installed
- [ ] PM2 installed globally (`sudo npm install -g pm2`)
- [ ] Clone repository to VPS
- [ ] Create `.env` file on VPS with production values
- [ ] Run `npm install --production`
- [ ] Run `npm run build`
- [ ] Start with `pm2 start server.js --name "3speak-player"`
- [ ] Configure `pm2 startup` for auto-restart
- [ ] Run `pm2 save`

## Nginx Configuration
- [ ] Create Nginx config at `/etc/nginx/sites-available/play.3speak.tv`
- [ ] Enable site: `ln -s /etc/nginx/sites-available/play.3speak.tv /etc/nginx/sites-enabled/`
- [ ] Test config: `sudo nginx -t`
- [ ] Reload Nginx: `sudo systemctl reload nginx`
- [ ] (Optional) Setup SSL with certbot

## Production .env Settings
```bash
NODE_ENV=production
PORT=3005
MONGODB_URI=mongodb://username:password@host:port/threespeak
IPFS_GATEWAY=https://ipfs.3speak.tv/ipfs
ALLOWED_ORIGINS=https://play.3speak.tv,https://3speak.tv
```

## Verification
- [ ] Check PM2 status: `pm2 status`
- [ ] Check logs: `pm2 logs 3speak-player`
- [ ] Test local: `curl http://localhost:3005/api/watch?v=meno/p723so6v`
- [ ] Test domain: Visit `https://play.3speak.tv/watch?v=meno/p723so6v`
- [ ] Verify thumbnails load
- [ ] Verify videos play
- [ ] Verify quality selector works
- [ ] Check view counter increments
- [ ] Test embed route: `/embed?v=testuser123/ma4k9uzo`

## Post-Deployment
- [ ] Monitor logs for errors
- [ ] Test from multiple browsers
- [ ] Verify CORS works on production domain
- [ ] Document any issues

## Rollback Plan
If something goes wrong:
```bash
pm2 stop 3speak-player
pm2 delete 3speak-player
# Fix issues, then redeploy
```
