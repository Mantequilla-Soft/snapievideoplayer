#!/usr/bin/env node
/**
 * Inspect the watch-duration tracking (`view-durations` collection).
 *
 * Usage (run from this dir as prodops):
 *   node watch-durations.cjs                 # last 20 rows, newest first
 *   node watch-durations.cjs -f              # live tail — reprints rows as they update
 *   node watch-durations.cjs -n 50           # last 50 rows
 *   node watch-durations.cjs --video meno/p723so6v   # only this video
 *   node watch-durations.cjs --ip 1.2.3.4    # only this viewer IP
 *   node watch-durations.cjs --recent 10     # only rows touched in the last 10 min
 *   node watch-durations.cjs --sessions      # also show live (in-progress) sessions
 *   node watch-durations.cjs --heatmap meno/p723so6v  # ASCII "most replayed" heatmap
 *
 * The rows you want to see while testing: watchedSeconds climbing and watchedPct
 * rising as you keep a video playing. A fresh play = a new row (new sid). `start`
 * = where on the timeline the watch began; `pos` = latest playhead position.
 */
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');

const LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const SESS = process.env.WATCH_SESSION_COLLECTION || 'view-sessions';
const HEAT = process.env.WATCH_HEATMAP_COLLECTION || 'view-heatmaps';

// -- tiny arg parser -------------------------------------------------------
const argv = process.argv.slice(2);
const has = (...names) => names.some((n) => argv.includes(n));
const val = (...names) => {
  for (const n of names) { const i = argv.indexOf(n); if (i !== -1) return argv[i + 1]; }
  return undefined;
};
const follow = has('-f', '--follow');
const limit = parseInt(val('-n', '--limit'), 10) || 20;
const video = val('--video');            // owner/permlink
const ip = val('--ip');
const recentMin = val('--recent') ? parseInt(val('--recent'), 10) : null;
const showSessions = has('--sessions');
const heatmapVideo = val('--heatmap'); // owner/permlink

function baseFilter() {
  const f = {};
  if (video) {
    const [owner, permlink] = video.split('/');
    if (owner) f.owner = owner;
    if (permlink) f.permlink = permlink;
  }
  if (ip) f.ip = ip;
  if (recentMin) f.updatedAt = { $gt: new Date(Date.now() - recentMin * 60 * 1000) };
  return f;
}

const pad = (s, w) => String(s ?? '').padEnd(w).slice(0, w);
const padL = (s, w) => String(s ?? '').padStart(w);
const hhmmss = (d) => (d ? new Date(d).toISOString().slice(11, 19) : '--:--:--');

function header() {
  return [
    pad('updated', 8), pad('owner/permlink', 24), pad('type', 6), pad('ip', 20),
    padL('watch(s)', 8), padL('dur(s)', 7), padL('pct', 6),
    padL('start', 6), padL('pos', 6), pad('sid', 10),
  ].join('  ');
}
const secs = (v) => (v == null ? '' : Math.round(Number(v)) + 's');
function fmtRow(r) {
  return [
    hhmmss(r.updatedAt),
    pad(`${r.owner}/${r.permlink}`, 24), pad(r.type, 6), pad(r.ip, 20),
    padL(r.watchedSeconds, 8), padL(r.videoDuration, 7),
    padL(r.watchedPct != null ? r.watchedPct + '%' : '', 6),
    padL(secs(r.startPosition), 6), padL(secs(r.lastPosition), 6), pad(r.sid, 10),
  ].join('  ');
}

// Render the per-video aggregate heatmap as an ASCII sparkline.
const SPARK = '▁▂▃▄▅▆▇█';
async function renderHeatmap(db, video) {
  const [owner, permlink] = video.split('/');
  const heat = db.collection(HEAT);
  // Match the stored key; embed beats key on the resolved asset permlink.
  let doc = await heat.findOne({ owner, permlink });
  if (!doc) {
    // try resolving via embed-video hive_permlink → asset permlink
    const embed = db.collection(process.env.MONGODB_COLLECTION_NEW || 'embed-video');
    const v = await embed.findOne({ owner, $or: [{ permlink }, { hive_permlink: permlink }] }, { projection: { permlink: 1 } });
    if (v?.permlink) doc = await heat.findOne({ owner, permlink: v.permlink });
  }
  if (!doc || !Array.isArray(doc.buckets)) {
    console.log(`\nNo heatmap yet for ${video}. Play it (past a few seconds) first.\n`);
    return;
  }
  const buckets = doc.buckets.map((x) => Number(x) || 0);
  const max = Math.max(1, ...buckets);
  const spark = buckets.map((x) => SPARK[Math.min(SPARK.length - 1, Math.floor((x / max) * (SPARK.length - 1)))]).join('');
  const dur = doc.duration || 0;
  console.log(`\nHeatmap for ${doc.owner}/${doc.permlink}  ·  ${doc.sessions || 0} session(s)  ·  duration ${dur}s  ·  ${buckets.length} buckets  ·  peak ${max} watch(es)\n`);
  console.log('  0s' + ' '.repeat(Math.max(0, buckets.length - 6)) + `${dur}s`);
  console.log('  ' + spark);
  // find the hottest 3 spots (as timestamps)
  const ranked = buckets.map((x, i) => ({ i, x })).filter((b) => b.x > 0).sort((a, b) => b.x - a.x).slice(0, 3);
  if (ranked.length) {
    console.log('\n  most-watched moments:');
    ranked.forEach((b) => {
      const t = Math.round((b.i / buckets.length) * dur);
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      console.log(`    ${mm}:${ss}  (bucket ${b.i}) — ${b.x} watch(es)`);
    });
  }
  console.log('');
}

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE);
  const col = db.collection(LOG);

  if (heatmapVideo) {
    await renderHeatmap(db, heatmapVideo);
    await client.close();
    return;
  }

  if (!follow) {
    const rows = await col.find(baseFilter()).sort({ updatedAt: -1 }).limit(limit).toArray();
    const total = await col.countDocuments(baseFilter());
    const active = await db.collection(SESS).countDocuments();
    console.log(`\n${LOG}: ${total} row(s) match · ${active} live session(s) in ${SESS}\n`);
    console.log(header());
    console.log('-'.repeat(header().length));
    rows.reverse().forEach((r) => console.log(fmtRow(r))); // oldest→newest so newest is at the bottom
    if (showSessions) {
      const sess = await db.collection(SESS).find({}).sort({ lastBeatAt: -1 }).limit(limit).toArray();
      console.log(`\nlive sessions (${SESS}) — accumulatedMs so far:`);
      sess.forEach((s) => console.log(
        `  ${hhmmss(s.lastBeatAt)}  ${pad(`${s.owner}/${s.permlink}`, 26)}  ${pad(s.ip, 22)}  ${padL(Math.round((s.accumulatedMs || 0) / 1000), 5)}s / ${Math.round((s.durationMs || 0) / 1000)}s`
      ));
    }
    console.log('');
    await client.close();
    return;
  }

  // -- live tail ----------------------------------------------------------
  console.log(`Live-tailing ${LOG} (Ctrl-C to stop). Play a video on preview.3speak.tv…\n`);
  console.log(header());
  console.log('-'.repeat(header().length));
  const seen = new Map(); // sid -> `${updatedAt}|${watchedSeconds}`
  const poll = async () => {
    const rows = await col.find(baseFilter()).sort({ updatedAt: -1 }).limit(100).toArray();
    rows.reverse().forEach((r) => {
      const stamp = `${new Date(r.updatedAt).getTime()}|${r.watchedSeconds}`;
      if (seen.get(r.sid) === stamp) return;   // unchanged since last poll
      seen.set(r.sid, stamp);
      console.log(fmtRow(r));
    });
  };
  await poll();
  setInterval(poll, 2000);
}

main().catch((e) => { console.error(e); process.exit(1); });
