/**
 * Video playlists behind the video embed URL: play.3speak.tv/watch?v=<owner>/<playlist id>.
 *
 * Hive frontends only embed links of that shape and keep nothing but `v` (see
 * audioEmbed.js), so a 3Speak playlist rides on it like a video does. When `v` is not
 * a video, audioEmbed.js tells an audio playlist (-> the audio player) from a video
 * one (-> `videoPlaylist`), and the page asks GET /api/playlist for the videos in
 * order; playlist.js then plays them one after another in the same player.
 *
 * Items are Hive posts (author/permlink), as in the `playlists` collection. Each is
 * resolved the way /api/watch resolves a post (legacy `videos` by permlink, then the
 * embed collection by permlink or hive_permlink), so `v` of an item is exactly what
 * /api/watch takes. Items that do not play (no video, still encoding, failed,
 * deleted, an expired story) and items by banned or hidden creators are left out.
 */
const PLAYLIST_ID = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_ITEMS = 200;
const CACHE_MS = 5 * 60 * 1000;
const HIVE_TIMEOUT_MS = 4000;

const legacyCol = (db) => db.collection(process.env.MONGODB_COLLECTION_LEGACY);
const embedCol = (db) => db.collection(process.env.MONGODB_COLLECTION_NEW);

/** A public playlist of that owner, or null. */
async function findPublicPlaylist(db, owner, id, projection = { name: 1, type: 1, items: 1 }) {
  if (!PLAYLIST_ID.test(String(id || ''))) return null;
  return db.collection('playlists').findOne({ _id: id, owner, access: 'public' }, { projection });
}

/** The playlist's items as Hive post refs, in playlist order. */
function itemRefs(list, max = MAX_ITEMS) {
  return (list.items || [])
    .filter((i) => i && i.author && i.permlink)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .slice(0, max)
    .map((i) => ({ author: String(i.author), permlink: String(i.permlink) }));
}

/** Legacy and embed rows for these refs, keyed 'author/permlink' (legacy first, as /api/watch). */
async function videoRows(db, refs) {
  if (!refs.length) return new Map();
  const [legacy, embed] = await Promise.all([
    legacyCol(db).find({ $or: refs.map((r) => ({ owner: r.author, permlink: r.permlink })) }).toArray(),
    embedCol(db).find({
      $or: refs.flatMap((r) => [
        { owner: r.author, permlink: r.permlink },
        { owner: r.author, hive_permlink: r.permlink },
      ]),
    }).toArray(),
  ]);
  const rows = new Map();
  for (const v of embed) {
    for (const p of [v.permlink, v.hive_permlink]) if (p) rows.set(`${v.owner}/${p}`, { video: v, isEmbed: true });
  }
  for (const v of legacy) rows.set(`${v.owner}/${v.permlink}`, { video: v, isEmbed: false });
  return rows;
}

/** Whether any of the first `probe` items is a video (decides video vs audio playlist). */
async function hasVideo(db, list, probe = 50) {
  const refs = itemRefs(list, probe);
  return (await videoRows(db, refs)).size > 0;
}

/**
 * A snap (a comment) has no title: use the first line of its text, without
 * images, links, embeds and markup, cut to 80 characters.
 */
function snapTitle(body) {
  const line = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:#{1,6}|>|[-*])\s*/, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim())
    .find(Boolean) || '';
  return line.length > 80 ? `${line.slice(0, 79).replace(/\s+\S*$/, '')}…` : line;
}

/** Hive titles for these refs in one JSON-RPC batch; {} when the node is slow or down. */
async function hiveTitles(refs) {
  if (!refs.length) return {};
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HIVE_TIMEOUT_MS);
  try {
    const r = await fetch(process.env.HIVE_API || 'https://api.hive.blog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(refs.map((ref, id) => ({
        jsonrpc: '2.0', method: 'condenser_api.get_content', params: [ref.author, ref.permlink], id,
      }))),
      signal: ac.signal,
    });
    if (!r.ok) return {};
    const answers = await r.json();
    const titles = {};
    for (const a of Array.isArray(answers) ? answers : []) {
      const post = a && a.result;
      const title = post && post.author && (post.title || snapTitle(post.body));
      if (title) titles[`${post.author}/${post.permlink}`] = String(title);
    }
    return titles;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** A title from the row itself, for a post without one (a snap) or a slow Hive node. */
function dbTitle({ video, isEmbed }) {
  if (!isEmbed) return video.title || '';
  if (video.embed_title && video.embed_title !== 'Comment') return video.embed_title;
  return String(video.originalFilename || '').replace(/\.[a-z0-9]{2,4}$/i, '');
}

const cache = new Map(); // 'owner/id' -> { until, value }

/**
 * { id, owner, name, items: [{ v, title, thumbnail, duration }] } for a public playlist
 * with videos in it, or null. `playable(video, isEmbed)` answers null for a video that
 * does not play, else { thumbnail }; it lives in server.js with the status rules.
 */
async function videoPlaylist(db, owner, id, playable) {
  const key = `${owner}/${id}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const list = await findPublicPlaylist(db, owner, id);
  if (!list) return null;
  const refs = itemRefs(list);
  const authors = [...new Set([owner, ...refs.map((r) => r.author)])];
  const [rows, blockedRows] = await Promise.all([
    videoRows(db, refs),
    db.collection('contentcreators')
      .find({ username: { $in: authors }, $or: [{ banned: true }, { hidden: true }] })
      .project({ username: 1 }).toArray(),
  ]);
  const blocked = new Set(blockedRows.map((c) => c.username));
  if (blocked.has(owner)) return null;

  const picked = [];
  for (const ref of refs) {
    const row = rows.get(`${ref.author}/${ref.permlink}`);
    if (!row || blocked.has(ref.author)) continue;
    const ok = playable(row.video, row.isEmbed);
    if (ok) picked.push({ ref, row, thumbnail: ok.thumbnail });
  }
  if (!picked.length) return null;

  // The title lives on the Hive POST. An item may name an embed asset by its own
  // permlink (shorts do), so ask Hive for the post the asset is linked to.
  const postOf = ({ ref, row }) => (row.isEmbed && row.video.hive_permlink
    ? { author: row.video.owner, permlink: row.video.hive_permlink }
    : ref);
  const titles = await hiveTitles(picked.map(postOf));
  const value = {
    id,
    owner,
    name: String(list.name || ''),
    items: picked.map((p) => {
      const { ref, row, thumbnail } = p;
      const post = postOf(p);
      return {
        v: `${ref.author}/${ref.permlink}`,
        title: titles[`${post.author}/${post.permlink}`] || dbTitle(row) || ref.permlink,
        thumbnail: thumbnail || null,
        duration: Number(row.video.duration) || 0,
      };
    }),
  };
  cache.set(key, { until: Date.now() + CACHE_MS, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = { findPublicPlaylist, itemRefs, hasVideo, videoPlaylist, PLAYLIST_ID };
