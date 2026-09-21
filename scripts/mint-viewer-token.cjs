#!/usr/bin/env node
/**
 * Mint a partner viewer token. This is the ~15 lines a partner's BACKEND runs.
 *
 * Usage: node scripts/mint-viewer-token.cjs <app> <viewer> <owner/permlink> [ttlSeconds]
 *
 * 🚨 The secret never leaves the partner's server. A token is minted per page view,
 * bound to one viewer and one video, and expires in minutes.
 */
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The whole algorithm, for copying into a partner's codebase. */
function mintViewerToken({ app, secret, viewer, video, ttlSeconds = 600 }) {
  const payload = b64url(JSON.stringify({
    v: String(viewer).toLowerCase(),   // the Hive account to credit
    a: app,                            // which app is asserting it
    p: String(video).toLowerCase(),    // "owner/permlink" this token is good for
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}
module.exports = { mintViewerToken };

if (require.main === module) {
  require('dotenv').config({ path: `${__dirname}/../.env` });
  const [app, viewer, video, ttl] = process.argv.slice(2);
  if (!app || !viewer || !video) {
    console.error('usage: mint-viewer-token.cjs <app> <viewer> <owner/permlink> [ttlSeconds]');
    process.exit(1);
  }
  const entry = String(process.env.AD_PARTNER_KEYS || '').split(',')
    .map((p) => { const i = p.indexOf(':'); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; })
    .find(([a]) => a === app);
  if (!entry) { console.error(`no key configured for app "${app}"`); process.exit(1); }
  console.log(mintViewerToken({ app, secret: entry[1], viewer, video, ttlSeconds: Number(ttl) || 600 }));
}
