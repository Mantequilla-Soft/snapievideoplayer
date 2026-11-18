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
 *
 * A playlist with a video in it may hold audio too (podcast episodes, songs): those
 * play in this same player, as `kind: 'audio'` items naming the audio permlink.
 * The page asks the audio player's API (`audioApi`) where the file is, as the audio
 * player does, so the gateway rules stay in one place (src/playlistAudio.js).
 */
const PLAYLIST_ID = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_ITEMS = 200;
const CACHE_MS = 5 * 60 * 1000;
const HIVE_TIMEOUT_MS = 4000;
const AUDIO_COLLECTION = process.env.MONGODB_COLLECTION_AUDIO || 'embed-audio';
// The audio player (snapieaudio): its /api/audio says where an audio's file is.
const AUDIO_API = (process.env.AUDIO_EMBED_BASE || 'https://audio.3speak.tv').replace(/\/$/, '');

const legacyCol = (db) => db.collection(process.env.MONGODB_COLLECTION_LEGACY);
const embedCol = (db) => db.collection(process.env.MONGODB_COLLECTION_NEW);

/** A public playlist of that owner, or null. */
async function findPublicPlaylist(db, owner, id, projection = { name: 1, type: 1, items: 1, thumbnail: 1 }) {
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

/** The last part of an audio's post_permlink: a few rows store "author/permlink". */
const postOfAudio = (row) => String(row.post_permlink || '').split('/').pop();

/**
 * Published audio for these refs, keyed 'author/permlink'. An item names the audio's
 * Hive post (post_permlink), or now and then the audio itself (its permlink).
 */
async function audioRows(db, refs) {
  if (!refs.length) return new Map();
  const found = await db.collection(AUDIO_COLLECTION).find({
    status: 'published',
    $or: refs.flatMap((r) => [
      { owner: r.author, post_permlink: { $in: [r.permlink, `${r.author}/${r.permlink}`] } },
      { owner: r.author, permlink: r.permlink },
    ]),
  }).project({ permlink: 1, owner: 1, title: 1, originalFilename: 1, duration: 1, mp3_duration: 1, thumbnail_url: 1, post_permlink: 1 })
    .toArray();
  const rows = new Map();
  for (const a of found) {
    rows.set(`${a.owner}/${a.permlink}`, a);
    if (postOfAudio(a)) rows.set(`${a.owner}/${postOfAudio(a)}`, a);
  }
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

/**
 * Hive titles for these refs in one JSON-RPC batch, as 'author/permlink' ->
 * { title, text } (text: a snap's first line, snapTitle). {} when the node is slow or down.
 */
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
      if (!post || !post.author) continue;
      titles[`${post.author}/${post.permlink}`] = { title: String(post.title || ''), text: snapTitle(post.body) };
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

/** The audio's own name: its title, else the uploaded file's name. */
function audioName(row) {
  return String(row.title || '').trim() || String(row.originalFilename || '').replace(/\.[a-z0-9]{2,4}$/i, '');
}

/**
 * { id, owner, name, audioApi, items } for a public playlist with videos in it, or
 * null. Items are { v, title, thumbnail, duration } for a video and the same plus
 * `kind: 'audio'` and `audio` (its permlink) for an audio. `playable(video, isEmbed)`
 * answers null for a video that does not play, else { thumbnail }; it lives in
 * server.js with the status rules.
 */
async function videoPlaylist(db, owner, id, playable) {
  const key = `${owner}/${id}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const list = await findPublicPlaylist(db, owner, id);
  if (!list) return null;
  const refs = itemRefs(list);
  const authors = [...new Set([owner, ...refs.map((r) => r.author)])];
  const [rows, audio, blockedRows] = await Promise.all([
    videoRows(db, refs),
    audioRows(db, refs),
    db.collection('contentcreators')
      .find({ username: { $in: authors }, $or: [{ banned: true }, { hidden: true }] })
      .project({ username: 1 }).toArray(),
  ]);
  const blocked = new Set(blockedRows.map((c) => c.username));
  if (blocked.has(owner)) return null;

  const picked = [];
  const seenAudio = new Set();
  for (const ref of refs) {
    if (blocked.has(ref.author)) continue;
    const key = `${ref.author}/${ref.permlink}`;
    const row = rows.get(key);
    if (row) {
      const ok = playable(row.video, row.isEmbed);
      if (ok) picked.push({ ref, row, thumbnail: ok.thumbnail });
    } else if (audio.has(key) && !seenAudio.has(audio.get(key).permlink)) {
      seenAudio.add(audio.get(key).permlink);
      picked.push({ ref, audio: audio.get(key) });
    }
  }
  // A video decides that this player plays the list (audioEmbed.js); audio alone does not.
  if (!picked.some((p) => p.row)) return null;

  // The title lives on the Hive POST. An item may name an embed asset by its own
  // permlink (shorts do), so ask Hive for the post the asset is linked to; an audio
  // likewise for its post_permlink.
  const postOf = ({ ref, row, audio: a }) => {
    if (a) return postOfAudio(a) ? { author: a.owner, permlink: postOfAudio(a) } : ref;
    return row.isEmbed && row.video.hive_permlink ? { author: row.video.owner, permlink: row.video.hive_permlink } : ref;
  };
  const titles = await hiveTitles(picked.map(postOf));
  const cover = typeof list.thumbnail === 'string' && /^https:\/\//.test(list.thumbnail) ? list.thumbnail : null;
  const value = {
    id,
    owner,
    name: String(list.name || ''),
    audioApi: AUDIO_API,
    items: picked.map((p) => {
      const { ref, row, thumbnail, audio: a } = p;
      const post = postOf(p);
      const hive = titles[`${post.author}/${post.permlink}`] || {};
      if (a) {
        // A reply (an album track) has no title of its own ("RE: ..."): the upload's name.
        const postTitle = /^re:/i.test(hive.title || '') ? '' : hive.title;
        return {
          v: `${ref.author}/${ref.permlink}`,
          kind: 'audio',
          audio: a.permlink,
          title: postTitle || audioName(a) || hive.text || ref.permlink,
          thumbnail: a.thumbnail_url || cover,
          duration: Math.round(Number(a.mp3_duration || a.duration) || 0),
        };
      }
      return {
        v: `${ref.author}/${ref.permlink}`,
        title: hive.title || hive.text || dbTitle(row) || ref.permlink,
        thumbnail: thumbnail || null,
        duration: Number(row.video.duration) || 0,
      };
    }),
  };
  cache.set(key, { until: Date.now() + CACHE_MS, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = { findPublicPlaylist, itemRefs, hasVideo, videoPlaylist, PLAYLIST_ID, AUDIO_API, AUDIO_COLLECTION };
