/**
 * Server-measured watch-duration + timeline-coverage tracking — ported from the
 * snapieaudio pay-per-listen heartbeat (server/controllers/listenController.js)
 * and extended with per-position coverage for a YouTube-style "most replayed"
 * heatmap.
 *
 * Watch time can NEVER be trusted from a single client-reported number (trivially
 * forged with curl). Instead:
 *   1. POST /api/watch/start → opens a server-side session bound to
 *      (sid, owner, permlink, ip) via an HMAC token, returns a heartbeat interval.
 *   2. POST /api/watch/beat  → sent every ~BEAT_SECONDS while the video is really
 *      playing (plus a final beat on pause/end/tab-hide). Each beat reports the
 *      current playback `position`. The server credits only the wall-clock gap it
 *      measures between beats (clamped) for the watched-seconds total, AND fills
 *      the timeline buckets the playhead actually traversed since the last beat.
 *
 * Two durable stores:
 *   • `view-durations` — one upserted row per session: video, viewer IP, watched
 *     seconds, % of duration, plus WHERE the session started (startPosition) and
 *     the last position seen (lastPosition).
 *   • `view-heatmaps`  — one aggregate doc per video: a fixed-size `buckets`
 *     array counting how often each slice of the timeline was watched across all
 *     sessions. Replaying/scrubbing back over a moment increments its bucket
 *     again, so hot spots emerge — exactly what the player renders above the
 *     scrubber. A contiguous playhead advance fills the buckets it crossed; a
 *     seek (jump/rewind) is NOT filled (only real watching counts).
 *
 * Ephemeral sessions live in `view-sessions` (TTL-expired), used only for the
 * anti-forge measurement + per-session position/accumulation state.
 *
 * NOTE: tracks watch behaviour only — it does NOT touch the `views` counter.
 */

const crypto = require('crypto');
const db = require('./db');

const LOG_COLLECTION = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const SESSION_COLLECTION = process.env.WATCH_SESSION_COLLECTION || 'view-sessions';
const HEATMAP_COLLECTION = process.env.WATCH_HEATMAP_COLLECTION || 'view-heatmaps';
const BEAT_SECONDS = Math.max(1, parseInt(process.env.WATCH_BEAT_SECONDS, 10) || 5);
// Number of timeline slices in the heatmap (YouTube uses 100). Fixed per video
// so the buckets array stays a stable length the player can render directly.
const BUCKET_COUNT = Math.max(10, parseInt(process.env.WATCH_BUCKET_COUNT, 10) || 100);
// A single beat can credit at most this much real time (covers a slightly late
// beat / tab throttling). A long gap from a paused/backgrounded tab is clamped,
// so idle time is never counted as watched.
const MAX_BEAT_CREDIT_MS = Math.max(BEAT_SECONDS * 1000 * 1.6, 8000);
// Per-process secret. Sessions live only minutes (< a few video-lengths), so
// losing them on restart is fine and we don't need a configured secret.
const SESSION_SECRET = crypto.randomBytes(32);

const ID_RE = /^[a-z0-9._-]+$/i;

let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    const database = db.getDb();
    const log = database.collection(LOG_COLLECTION);
    await log.createIndex({ sid: 1 }, { unique: true });     // one row per session
    await log.createIndex({ owner: 1, permlink: 1, updatedAt: -1 }); // per-video reporting
    await log.createIndex({ ip: 1, updatedAt: -1 });                 // per-IP reporting
    const sess = database.collection(SESSION_COLLECTION);
    await sess.createIndex({ sid: 1 }, { unique: true });
    await sess.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL cleanup
    const heat = database.collection(HEATMAP_COLLECTION);
    await heat.createIndex({ owner: 1, permlink: 1 }, { unique: true }); // one doc per video
  } catch (err) {
    indexesEnsured = false;
    console.error('Failed to ensure watch-duration indexes:', err.message);
  }
}

// Real client IP — the player sits behind nginx which sets X-Real-IP /
// X-Forwarded-For. Fall back to the socket address for direct hits.
function clientIp(req) {
  const xri = req.headers['x-real-ip'];
  if (xri) return String(xri).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

function sessionToken(sid, owner, permlink, ip) {
  return crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${sid}.${owner}.${permlink}.${ip}`).digest('hex');
}
function tokenMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

// Map a playback position (seconds) to a timeline bucket index [0, n-1].
function bucketIndex(pos, durationSec, n) {
  if (!(durationSec > 0)) return 0;
  const i = Math.floor((pos / durationSec) * n);
  return Math.min(n - 1, Math.max(0, i));
}
// Resolve + bound the duration used for %/bucketing. The player-reported
// duration reflects the ACTUAL media timeline the viewer scrubs, so we prefer it
// (the stored doc value is sometimes stale/wrong); fall back to the doc.
function resolveDuration(clientDur, docDur) {
  const c = Number(clientDur);
  if (Number.isFinite(c) && c > 0 && c < 86400) return c;
  const d = Number(docDur);
  if (Number.isFinite(d) && d > 0 && d < 86400) return d;
  return 0;
}
function clampPos(pos, durationSec) {
  const p = Number(pos);
  if (!Number.isFinite(p) || p < 0) return 0;
  return durationSec > 0 ? Math.min(p, durationSec) : p;
}
// Where the view happened. Sanitized to a short slug; defaults to 'player'
// (the embed iframe) when unset — that's what unlabelled/older clients are.
function normalizeSource(s) {
  const v = String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
  return v || 'player';
}

/**
 * POST /api/watch/start — open a measured watch session.
 * body: { owner, permlink, type: 'legacy'|'embed', duration?, position? }
 * `duration` (player.duration()) is preferred for %/heatmap alignment; `position`
 * is where playback currently is (non-zero if the viewer opened at a timestamp).
 */
async function watchStart(req, res) {
  try {
    await ensureIndexes();

    const owner = typeof req.body?.owner === 'string' ? req.body.owner.trim() : '';
    const permlink = typeof req.body?.permlink === 'string' ? req.body.permlink.trim() : '';
    const type = req.body?.type === 'legacy' ? 'legacy' : 'embed';
    if (!ID_RE.test(owner) || !ID_RE.test(permlink)) {
      return res.status(400).json({ error: 'Invalid owner/permlink' });
    }

    const video = type === 'legacy'
      ? await db.findLegacyVideo(owner, permlink)
      : await db.findEmbedVideo(owner, permlink);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const duration = resolveDuration(req.body?.duration, video.duration);
    if (duration <= 0) {
      // Can't measure a %/heatmap without a duration.
      return res.json({ tracked: false, reason: 'no_duration' });
    }
    const durationSec = Math.round(duration);
    // Canonical key for the row + heatmap: the embed collection resolves
    // permlink → hive_permlink, so use the real doc permlink.
    const keyPermlink = video.permlink || permlink;

    // Ensure the per-video heatmap doc exists with a stable duration + zeroed
    // buckets, and bump its session count. Beats bucket against the doc's stored
    // duration so every session aligns to the same axis.
    const database = db.getDb();
    const now = new Date();
    const hm = await database.collection(HEATMAP_COLLECTION).findOneAndUpdate(
      { owner, permlink: keyPermlink },
      {
        $setOnInsert: {
          owner, permlink: keyPermlink, type,
          duration: durationSec, bucketCount: BUCKET_COUNT,
          buckets: new Array(BUCKET_COUNT).fill(0),
          createdAt: now,
        },
        $inc: { sessions: 1 },
        $set: { updatedAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const hmDoc = hm?.value ?? hm;
    const heatmapDuration = hmDoc?.duration || durationSec;
    const bucketCount = hmDoc?.bucketCount || BUCKET_COUNT;

    // Private mode: the client asks us NOT to store the IP — we keep only the
    // pseudonymous viewer id it sends. `viewerId` is the distinct-viewer key in
    // BOTH modes (a stable per-browser id, better than a shared/NAT IP); the `ip`
    // is retained only for coarse country demographics, and null in private mode.
    const isPrivate = req.body?.private === true || req.body?.private === 'true';
    const rawViewerId = String(req.body?.viewerId || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
    const ip = isPrivate ? null : clientIp(req);
    const viewerId = rawViewerId || ip || null; // prefer the client id; fall back to IP (non-private)
    const userAgent = req.headers['user-agent'] || '';
    const sid = crypto.randomBytes(16).toString('hex');
    const durationMs = Math.round(duration * 1000);
    const startPosition = clampPos(req.body?.position, heatmapDuration);
    // Where the view happened: 'player' (embed iframe) | '3speak' (native site).
    const source = normalizeSource(req.body?.source);

    await database.collection(SESSION_COLLECTION).insertOne({
      sid,
      owner,
      permlink: keyPermlink,
      type,
      source,
      durationMs,
      heatmapDuration,     // seconds — stable axis for bucketing
      bucketCount,
      ip,
      viewerId,
      private: isPrivate,
      userAgent,
      accumulatedMs: 0,    // wall-clock attention (real seconds spent)
      contentMs: 0,        // video content consumed (playhead advance) — speed-correct
      startPosition,       // where the watch began on the timeline
      lastPosition: startPosition,
      maxPosition: startPosition, // furthest point reached (drop-off / retention)
      coveredBuckets: [],  // distinct timeline buckets this session actually watched
      rateSum: 0,          // Σ playbackRate over beats → avg speed
      rateBeats: 0,
      startedAt: now,
      lastBeatAt: now,
      // Generous TTL: a few video-lengths so a paused tab can resume.
      expiresAt: new Date(Date.now() + durationMs * 4 + 5 * 60 * 1000),
    });

    res.json({
      sid,
      token: sessionToken(sid, owner, keyPermlink, ip),
      beatSeconds: BEAT_SECONDS,
    });
  } catch (error) {
    console.error('Error starting watch session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/watch/beat — heartbeat while the video is really playing.
 * body: { sid, token, position? }
 * Advances the watched-seconds total (clamped wall-clock) and fills the timeline
 * buckets the playhead traversed since the last beat.
 */
async function watchBeat(req, res) {
  try {
    const sid = typeof req.body?.sid === 'string' ? req.body.sid : '';
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!sid || !token) return res.status(400).json({ error: 'Invalid beat' });

    const database = db.getDb();
    const sessions = database.collection(SESSION_COLLECTION);
    const s = await sessions.findOne({ sid });
    if (!s) return res.status(410).json({ error: 'no_session' });

    // Token is bound to the session's video + the IP seen at start.
    if (!tokenMatches(token, sessionToken(sid, s.owner, s.permlink, s.ip))) {
      return res.status(403).json({ error: 'bad_token' });
    }

    const now = Date.now();
    const gap = Math.max(0, now - new Date(s.lastBeatAt).getTime());
    // Credit only the real elapsed time between beats, capped so one delayed/
    // forged beat can't claim a huge span.
    const credit = Math.min(gap, MAX_BEAT_CREDIT_MS);
    const accumulatedMs = s.accumulatedMs + credit;

    // ---- timeline coverage --------------------------------------------------
    const durSec = s.heatmapDuration || Math.round(s.durationMs / 1000);
    const n = s.bucketCount || BUCKET_COUNT;
    const lastPos = Number(s.lastPosition) || 0;
    const curPos = clampPos(req.body?.position, durSec);
    // The playhead is "watching" (contiguous) if it advanced forward by no more
    // than the real time elapsed × a tolerance (covers up-to-~2.5x playback and
    // a late beat). A rewind or a big jump is a SEEK — we don't fill the gap,
    // only real playback counts toward the heatmap.
    const contiguousMax = Math.max((credit / 1000) * 2.5, 12);
    const incs = {};
    let contentMs = s.contentMs || 0;
    const covered = new Set(Array.isArray(s.coveredBuckets) ? s.coveredBuckets : []);
    if (durSec > 0 && curPos >= lastPos && (curPos - lastPos) <= contiguousMax) {
      // Content consumed = playhead advance. This is SPEED-CORRECT: at 1.5x the
      // playhead moves 1.5x faster, so more content accrues per wall-second —
      // exactly the fix for fast playback under-counting watch progress.
      contentMs += (curPos - lastPos) * 1000;
      const b0 = bucketIndex(lastPos, durSec, n);
      const b1 = bucketIndex(curPos, durSec, n);
      for (let b = b0; b <= b1; b++) {
        incs[`buckets.${b}`] = (incs[`buckets.${b}`] || 0) + 1; // aggregate replay count
        covered.add(b);                                          // this session's unique coverage
      }
    }

    const maxPosition = Math.max(Number(s.maxPosition) || 0, curPos);
    // Average playback speed this session (for analytics), if the client reports it.
    const rate = Number(req.body?.rate);
    const rateSum = (s.rateSum || 0) + (Number.isFinite(rate) && rate > 0 ? rate : 0);
    const rateBeats = (s.rateBeats || 0) + (Number.isFinite(rate) && rate > 0 ? 1 : 0);

    await sessions.updateOne(
      { sid },
      {
        $set: {
          accumulatedMs, contentMs, lastBeatAt: new Date(now),
          lastPosition: curPos, maxPosition,
          coveredBuckets: Array.from(covered), rateSum, rateBeats,
        },
      },
    );

    if (Object.keys(incs).length) {
      await database.collection(HEATMAP_COLLECTION).updateOne(
        { owner: s.owner, permlink: s.permlink },
        { $inc: incs, $set: { updatedAt: new Date(now) } },
      );
    }

    const watchedSeconds = Math.round(accumulatedMs / 1000);       // wall-clock attention
    const contentSeconds = Math.round(contentMs / 1000);           // content consumed (speed-correct)
    const videoDuration = durSec;
    // % of the video actually SEEN = distinct buckets covered (speed- AND
    // replay-correct; replays don't push it past 100, a skipped middle isn't counted).
    const watchedPct = Math.min(100, Math.round((covered.size / n) * 1000) / 10);
    const avgRate = rateBeats > 0 ? Math.round((rateSum / rateBeats) * 100) / 100 : null;

    await database.collection(LOG_COLLECTION).updateOne(
      { sid },
      {
        $set: {
          owner: s.owner,
          permlink: s.permlink,
          type: s.type,
          source: s.source || 'player',
          ip: s.ip,
          viewerId: s.viewerId || s.ip || null,
          private: !!s.private,
          userAgent: s.userAgent,
          watchedSeconds,   // wall-clock time actually spent watching
          contentSeconds,   // seconds of video content consumed (handles >1x speed)
          videoDuration,
          watchedPct,       // unique % of the timeline seen
          lastPosition: curPos,
          maxPosition,      // furthest point reached (retention / where they left)
          avgRate,          // average playback speed
          updatedAt: new Date(now),
        },
        $setOnInsert: { sid, startPosition: Number(s.startPosition) || 0, startedAt: new Date(s.startedAt) },
      },
      { upsert: true },
    );

    res.json({ watchedSeconds, contentSeconds, watchedPct, videoDuration, position: curPos });
  } catch (error) {
    console.error('Error recording watch beat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/heatmap?v=owner/permlink[&type=embed|legacy]
 * Returns the aggregate timeline-coverage buckets for a video so the player can
 * render a "most replayed" heatmap above the scrubber.
 * → { tracked, bucketCount, duration, sessions, max, buckets:[...], normalized:[0..1] }
 */
async function getHeatmap(req, res) {
  try {
    const v = typeof req.query?.v === 'string' ? req.query.v : '';
    const slash = v.indexOf('/');
    const owner = slash > 0 ? v.slice(0, slash).trim() : '';
    const rawPermlink = slash > 0 ? v.slice(slash + 1).trim() : '';
    const type = req.query?.type === 'legacy' ? 'legacy' : 'embed';
    if (!ID_RE.test(owner) || !ID_RE.test(rawPermlink)) {
      return res.status(400).json({ error: 'Invalid v=owner/permlink' });
    }

    // Resolve to the canonical asset permlink the beats keyed on.
    const video = type === 'legacy'
      ? await db.findLegacyVideo(owner, rawPermlink)
      : await db.findEmbedVideo(owner, rawPermlink);
    const keyPermlink = video?.permlink || rawPermlink;

    const doc = await db.getDb().collection(HEATMAP_COLLECTION)
      .findOne({ owner, permlink: keyPermlink });
    if (!doc || !Array.isArray(doc.buckets)) {
      return res.json({ tracked: false, bucketCount: BUCKET_COUNT, buckets: [], normalized: [] });
    }
    const buckets = doc.buckets.map((x) => Number(x) || 0);
    const max = buckets.reduce((m, x) => (x > m ? x : m), 0);
    const normalized = max > 0 ? buckets.map((x) => Math.round((x / max) * 1000) / 1000) : buckets.map(() => 0);
    res.json({
      tracked: true,
      owner: doc.owner,
      permlink: doc.permlink,
      duration: doc.duration,
      bucketCount: doc.bucketCount || buckets.length,
      sessions: doc.sessions || 0,
      max,
      buckets,
      normalized,
    });
  } catch (error) {
    console.error('Error fetching heatmap:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { watchStart, watchBeat, getHeatmap };
