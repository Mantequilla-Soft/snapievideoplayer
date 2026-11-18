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
 *   v=<owner>/<public playlist id, audio only>            ->  /play?list=<playlist id>
 *   v=<owner>/<public playlist id, any video in it>       ->  `videoPlaylist` (videoPlaylist.js,
 *                                                            which plays its audio too)
 *
 * Only consulted after the video lookups missed, so videos pay nothing for it.
 */
const { findPublicPlaylist, hasVideo, AUDIO_API: AUDIO_EMBED_BASE, AUDIO_COLLECTION } = require('./videoPlaylist');
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

/**
 * A public playlist: `{ videoPlaylist }` when any of its items is a video (this player
 * plays those, videoPlaylist.js), else `{ audioEmbed }` when one is an audio (the audio
 * player plays those), else null. A playlist typed 'audio' goes to the audio player.
 */
async function findPlaylist(db, owner, id) {
  const list = await findPublicPlaylist(db, owner, id, { type: 1, items: { $slice: PLAYLIST_PROBE_ITEMS } });
  if (!list) return null;
  const audio = { audioEmbed: `${AUDIO_EMBED_BASE}/play?list=${encodeURIComponent(id)}` };
  if (list.type === 'audio') return audio;
  // Otherwise `type` cannot be trusted: the playlist indexer writes 'video' by default,
  // so most playlists of audio say 'video'. The items decide; a video in it wins.
  if (await hasVideo(db, list, PLAYLIST_PROBE_ITEMS)) return { videoPlaylist: `${owner}/${id}` };
  const refs = (list.items || []).filter((i) => i && i.author && i.permlink);
  if (!refs.length) return null;
  const hit = await db.collection(AUDIO_COLLECTION).findOne(
    { status: 'published', $or: refs.map((i) => ({ owner: i.author, post_permlink: postPermlinkIs(i.author, i.permlink) })) },
    { projection: { _id: 1 } }
  );
  return hit ? audio : null;
}

/**
 * When owner/permlink is not a video: `{ audioEmbed: url }` for an audio or an audio
 * playlist, `{ videoPlaylist: 'owner/id' }` for a playlist with videos, `{}` otherwise
 * (also on a lookup error: the caller is already answering 404).
 */
async function audioEmbedFields(db, owner, permlink) {
  try {
    const url = await findAudio(db, owner, permlink);
    if (url) return { audioEmbed: url };
    return (await findPlaylist(db, owner, permlink)) || {};
  } catch (error) {
    console.error('Audio embed lookup failed:', error.message);
    return {};
  }
}

module.exports = { audioEmbedFields };
