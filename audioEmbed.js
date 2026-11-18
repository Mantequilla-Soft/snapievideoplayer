/**
 * Audio and audio playlists behind the video embed URL.
 *
 * Hive frontends (Ecency and its Waves, PeakD, ...) only turn a 3Speak link into an
 * embed when it looks like play.3speak.tv/watch?v=<owner>/<permlink>, and they keep
 * nothing but `v`. An audio post or an audio playlist shared that way lands here, so
 * when `v` is not a video we look for the audio it names and answer with the URL of
 * the audio player (snapieaudio), which the page then opens in place (main.js
 * openAudioEmbed). No audio player lives in this repo: it only points the way.
 *
 *   v=<owner>/<audio permlink or its Hive post permlink>  ->  /play?a=<audio permlink>
 *   v=<owner>/<public playlist id>                        ->  /play?list=<playlist id>
 *
 * Only consulted after the video lookups missed, so videos pay nothing for it.
 */
const AUDIO_EMBED_BASE = (process.env.AUDIO_EMBED_BASE || 'https://audio.3speak.tv').replace(/\/$/, '');
const AUDIO_COLLECTION = process.env.MONGODB_COLLECTION_AUDIO || 'embed-audio';
// As snapieaudio's /api/audio/playlist/:id accepts them (32 hex or a UUID in practice).
const PLAYLIST_ID = /^[a-zA-Z0-9-]{8,64}$/;
// Enough to tell an untyped playlist with audio in it from a video one.
const PLAYLIST_PROBE_ITEMS = 50;

// A few rows store post_permlink as "author/permlink" (see snapieaudio playlistController).
const postPermlinkIs = (owner, permlink) => ({ $in: [permlink, `${owner}/${permlink}`] });

async function findAudio(db, owner, permlink) {
  const row = await db.collection(AUDIO_COLLECTION).findOne(
    { owner, status: 'published', $or: [{ permlink }, { post_permlink: postPermlinkIs(owner, permlink) }] },
    { projection: { permlink: 1 } }
  );
  return row ? `${AUDIO_EMBED_BASE}/play?a=${encodeURIComponent(row.permlink)}` : null;
}

async function findAudioPlaylist(db, owner, id) {
  if (!PLAYLIST_ID.test(id)) return null;
  const list = await db.collection('playlists').findOne(
    { _id: id, owner, access: 'public' },
    { projection: { type: 1, items: { $slice: PLAYLIST_PROBE_ITEMS } } }
  );
  if (!list || list.type === 'video') return null;
  if (list.type !== 'audio') {
    // Untyped (older) playlists: an audio one only if some item is an audio.
    const refs = (list.items || []).filter((i) => i && i.author && i.permlink);
    if (!refs.length) return null;
    const hit = await db.collection(AUDIO_COLLECTION).findOne(
      { status: 'published', $or: refs.map((i) => ({ owner: i.author, post_permlink: postPermlinkIs(i.author, i.permlink) })) },
      { projection: { _id: 1 } }
    );
    if (!hit) return null;
  }
  return `${AUDIO_EMBED_BASE}/play?list=${encodeURIComponent(id)}`;
}

/**
 * `{ audioEmbed: url }` when owner/permlink names an audio or a public audio playlist,
 * `{}` otherwise (also on a lookup error: the caller is already answering 404).
 */
async function audioEmbedFields(db, owner, permlink) {
  try {
    const url = await findAudio(db, owner, permlink) || await findAudioPlaylist(db, owner, permlink);
    return url ? { audioEmbed: url } : {};
  } catch (error) {
    console.error('Audio embed lookup failed:', error.message);
    return {};
  }
}

module.exports = { audioEmbedFields };
