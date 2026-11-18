/**
 * The audio items of a playlist (videoPlaylist.js lists them as `kind: 'audio'`),
 * played in this same video player: a playlist with videos and podcast episodes or
 * songs in it plays all of them, in order.
 *
 * Loaded only when a playlist reaches an audio item, so a video never downloads it.
 *
 *  - Where the file is comes from the audio player's own API (snapieaudio
 *    GET /api/audio?a=<permlink>), so its gateway rules stay in one place. Its MP3
 *    copy goes first (a webm, ogg or wav upload does not play on iOS), then the
 *    original, each on the audio player's gateway and on ipfs-3speak.b-cdn.net, which
 *    the audio player tries too. A gateway that fails moves on to the next one.
 *  - A listen counts as the audio player counts it, never as a video view:
 *      - its plays counter: POST {audioApi}/api/audio/play-start, then play-beat while
 *        it plays; the server counts the play once 66% was really streamed. Beats it
 *        wants encrypted (LISTEN_BEAT_KEY) are not sent: this player has no key.
 *      - listening time, measured by the 3Speak checker (POST {checker}/audio/listen/
 *        start and /beat), anonymous, as the audio embed does (listen-time.js there).
 *    No view, watch session, sponsor break or replay heatmap for an audio: main.js
 *    leaves the video bookkeeping out while one plays.
 */

const BROWSER_GATEWAY = 'https://ipfs-3speak.b-cdn.net';
const CHECKER_API = 'https://checker.3speak.tv';
const TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  webm: 'audio/webm', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
};

/** The audio's sources, best first: [{ src, type }]. Throws when it does not load. */
export async function audioSources(api, permlink) {
  const r = await fetch(`${api}/api/audio?a=${encodeURIComponent(permlink)}`);
  if (!r.ok) throw new Error('Audio not found');
  const a = await r.json();
  const type = TYPES[String(a.format || '').toLowerCase()] || 'audio/mpeg';
  const list = [];
  const add = (src, t) => { if (src && !list.some((s) => s.src === src)) list.push({ src, type: t }); };
  if (a.mp3_cid) {
    add(a.mp3Url, 'audio/mpeg');
    add(`${BROWSER_GATEWAY}/ipfs/${a.mp3_cid}`, 'audio/mpeg');
  }
  add(a.audioUrl, type);
  if (a.audio_cid) add(`${BROWSER_GATEWAY}/ipfs/${a.audio_cid}`, type);
  add(a.audioUrlFallback, type);
  if (!list.length) throw new Error('Audio has no file');
  return list;
}

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  keepalive: true,
});

/** One audio's listen: its plays counter and its listening time. */
class Listen {
  constructor(api, permlink, checker) {
    this.api = api;
    this.permlink = permlink;
    this.checker = checker;
    this.plays = { sid: null, token: null, beatMs: 10000, lastBeatAt: 0, done: false };
    this.time = { sid: null, token: null, beatMs: 10000, lastBeatAt: 0 };
    this.started = false;
    this.lastTime = 0;
    this.disposed = false;
  }

  /** On the first play. Each half is best effort: listening without counting is fine. */
  start(player) {
    if (this.started) return;
    this.started = true;
    post(`${this.api}/api/audio/play-start`, { permlink: this.permlink })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.sid || this.disposed || d.encrypted) return;
        Object.assign(this.plays, { sid: d.sid, token: d.token, beatMs: (d.beatSeconds || 10) * 1000, lastBeatAt: Date.now() });
      })
      .catch(() => {});
    const duration = player.duration();
    post(`${this.checker}/audio/listen/start`, {
      kind: 'audio',
      id: this.permlink,
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      position: player.currentTime() || 0,
      source: 'embed',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.sid || this.disposed) return;
        Object.assign(this.time, { sid: d.sid, token: d.token, beatMs: Math.max(2000, (Number(d.beatSeconds) || 10) * 1000), lastBeatAt: Date.now() });
      })
      .catch(() => {});
  }

  /** Both beats now: on pause, at the end, before a seek and when the page goes away. */
  beat(player, position = player.currentTime()) {
    if (this.disposed) return;
    const P = this.plays;
    if (P.sid && !P.done) {
      P.lastBeatAt = Date.now();
      post(`${this.api}/api/audio/play-beat`, { sid: P.sid, token: P.token })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && (d.done || d.credited)) P.done = true; })
        .catch(() => {});
    }
    const T = this.time;
    if (T.sid) {
      T.lastBeatAt = Date.now();
      post(`${this.checker}/audio/listen/beat`, {
        sid: T.sid, token: T.token, position, rate: player.playbackRate() || 1,
        hidden: document.visibilityState === 'hidden',
      }).catch(() => {});
    }
  }

  /** While playing: remember the position (a seek moves it first) and beat on schedule. */
  tick(player) {
    this.lastTime = player.currentTime();
    if (player.paused()) return;
    const now = Date.now();
    if ((this.plays.sid && !this.plays.done && now - this.plays.lastBeatAt >= this.plays.beatMs)
      || (this.time.sid && now - this.time.lastBeatAt >= this.time.beatMs)) this.beat(player);
  }

  /** Another item: credit what was heard of this one (unless it ended, which beat), then stop. */
  dispose(player) {
    if (this.disposed) return;
    if (!player.paused() && !player.ended()) this.beat(player, this.lastTime || player.currentTime());
    this.disposed = true;
  }
}

let current = null;
let sources = [];
let wired = false;

function wire(player) {
  if (wired) return;
  wired = true;
  player.on('play', () => current && current.start(player));
  player.on('pause', () => current && current.beat(player));
  player.on('ended', () => current && current.beat(player));
  player.on('timeupdate', () => current && current.tick(player));
  // 'seeking' fires with the new time set: credit the stretch up to the jump.
  player.on('seeking', () => current && current.beat(player, current.lastTime));
  const away = () => { if (current && !player.paused()) current.beat(player); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') away(); });
  window.addEventListener('pagehide', away);
  // A gateway that does not answer: the next one, from where it was.
  player.on('error', () => {
    if (!current || !sources.length) return;
    const at = current.lastTime;
    const wasPlaying = current.started;
    player.error(null);
    player.src(sources.shift());
    if (at) player.one('loadedmetadata', () => player.currentTime(at));
    if (wasPlaying) {
      const p = player.play();
      if (p && p.catch) p.catch(() => {});
    }
  });
}

/** Play this audio (from audioSources) in `player`, counting its listen. */
export function loadAudio(player, { api, permlink, list, checker = CHECKER_API }) {
  wire(player);
  stopAudio(player);
  current = new Listen(api, permlink, checker);
  sources = list.slice(1);
  player.src(list[0]);
  player.load();
}

/** A video next: close the audio's listen. */
export function stopAudio(player) {
  if (current) current.dispose(player);
  current = null;
  sources = [];
}
