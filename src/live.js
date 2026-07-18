// Live OpenPods playback (WebRTC / LiveKit).
//
// The general 3Speak embed player is HLS/Video.js. A running OpenPods
// standalone session is a WebRTC stream, not a file — the host publishes a
// single client-composited "program" feed to a LiveKit room. This module is
// a self-contained viewer for that feed: it mints an anonymous guest token
// from the hangouts API (open CORS, no auth needed for standalone rooms),
// connects to LiveKit, and attaches the host's track to the existing
// `#snapie-player` <video> element.
//
// Nothing here touches the HLS path — it's only imported when `?live=` is set.

import { Room, RoomEvent, Track } from 'livekit-client';

// Preview defaults — match what preview.3speak.tv's OpenPods uses. An embedder
// can override per-URL with `?api=` and `?lk=`.
const DEFAULT_API = 'https://hangouts.okinoko.io';
const DEFAULT_LK = 'wss://livekit.okinoko.io';

function el(tag, className, styles) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (styles) Object.assign(node.style, styles);
  return node;
}

export async function initLiveSession({ roomName, apiBase, lkUrl, host = null, muted = false } = {}) {
  if (!roomName) throw new Error('No live session specified (missing ?live=<room>)');

  const api = (apiBase || DEFAULT_API).replace(/\/$/, '');
  const lk = lkUrl || DEFAULT_LK;

  const wrapper = document.querySelector('.player-wrapper');
  const video = document.getElementById('snapie-player');
  if (!wrapper || !video) throw new Error('Player container missing');

  // Establish a reliable 16:9 frame ourselves. The composited OpenPods program
  // is 16:9, and we never init Video.js on this path — so we override whatever
  // sizing the embed mode uses (iframe mode has min-height:0; layout modes use
  // padding-bottom aimed at Video.js's absolutely-positioned tech) and give the
  // wrapper a real box the video + overlays can fill.
  Object.assign(wrapper.style, {
    position: 'relative',
    width: '100%',
    height: 'auto',
    aspectRatio: '16 / 9',
    paddingBottom: '0',
    minHeight: '0',
    maxHeight: '100vh',
    background: '#000',
  });

  // Repurpose the Video.js <video> as a plain autoplay surface that fills the
  // frame. Stripping the skin classes leaves a clean native element.
  video.classList.remove('video-js', 'vjs-default-skin');
  video.removeAttribute('controls');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.autoplay = true;
  video.muted = true; // video element stays muted; audio plays via <audio> below
  Object.assign(video.style, {
    position: 'absolute', top: '0', left: '0',
    width: '100%', height: '100%', objectFit: 'contain', background: '#000',
  });

  // A dedicated audio sink — attaching audio to the muted <video> would be
  // silent, so the host's audio track gets its own element.
  const audioSink = el('audio');
  audioSink.autoplay = true;
  wrapper.appendChild(audioSink);

  // --- overlay chrome (LIVE badge, viewer count, states) -----------------

  const badge = el('div', 'live-badge', {
    // Offset right so it clears the 3Speak logo kept at top-left (25px @ 10px).
    position: 'absolute', top: '12px', left: '46px', zIndex: 5,
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '4px 10px', borderRadius: '6px', fontFamily: 'system-ui, sans-serif',
    fontSize: '12px', fontWeight: '700', color: '#fff',
    background: 'rgba(0,0,0,0.55)', letterSpacing: '0.02em',
  });
  const dot = el('span', null, {
    width: '8px', height: '8px', borderRadius: '50%', background: '#888', display: 'inline-block',
  });
  const badgeText = el('span');
  badgeText.textContent = 'CONNECTING';
  badge.appendChild(dot); badge.appendChild(badgeText);

  const viewers = el('div', 'live-viewers', {
    position: 'absolute', top: '12px', right: '12px', zIndex: 5,
    padding: '4px 10px', borderRadius: '6px', fontFamily: 'system-ui, sans-serif',
    fontSize: '12px', fontWeight: '600', color: '#fff', background: 'rgba(0,0,0,0.55)',
  });
  viewers.textContent = '👁 0';

  const placeholder = el('div', 'live-placeholder', {
    position: 'absolute', inset: '0', zIndex: 4,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#ccc',
    background: '#000', textAlign: 'center', padding: '0 24px',
  });
  placeholder.textContent = 'Connecting to the live session…';

  const unmute = el('button', 'live-unmute', {
    position: 'absolute', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
    zIndex: 6, display: 'none', cursor: 'pointer', border: 'none',
    padding: '10px 18px', borderRadius: '999px', fontFamily: 'system-ui, sans-serif',
    fontSize: '14px', fontWeight: '700', color: '#fff', background: '#e31337',
    boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
  });
  unmute.textContent = '🔊 Tap to enable audio';

  wrapper.appendChild(badge);
  wrapper.appendChild(viewers);
  wrapper.appendChild(placeholder);
  wrapper.appendChild(unmute);

  let live = false;
  const setLive = (on) => {
    live = on;
    dot.style.background = on ? '#e31337' : '#888';
    badgeText.textContent = on ? 'LIVE' : 'OFFLINE';
    placeholder.style.display = on ? 'none' : 'flex';
    if (!on) placeholder.textContent = 'The streamer is offline';
  };

  // --- resolve host identity (so we only render the streamer, not guests) --
  // Prefer the host handed in by the backend resolver; only hit the API when
  // we weren't given one (e.g. the direct `?live=<room>` override path).
  let hostIdentity = host || null;
  if (!hostIdentity) {
    try {
      const metaRes = await fetch(`${api}/rooms/${encodeURIComponent(roomName)}`);
      if (metaRes.ok) {
        const meta = await metaRes.json();
        hostIdentity = meta?.host || null;
      }
    } catch { /* non-fatal — fall back to first non-guest track */ }
  }

  const isViewerIdentity = (id) => id && (id.startsWith('guest-') || id.startsWith('obs-'));
  const isHost = (id) => (hostIdentity ? id === hostIdentity : !isViewerIdentity(id));

  const updateViewers = (room) => {
    let count = 1; // count ourselves as a viewer
    room.remoteParticipants.forEach((p) => {
      if (p.identity !== hostIdentity && !p.identity.startsWith('obs-')) count += 1;
    });
    viewers.textContent = `👁 ${count}`;
  };

  // --- mint a guest token --------------------------------------------------
  const tokRes = await fetch(`${api}/rooms/${encodeURIComponent(roomName)}/listen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!tokRes.ok) {
    if (tokRes.status === 404) throw new Error('This stream has already ended');
    throw new Error('Could not join the live session');
  }
  const { token } = await tokRes.json();
  if (!token) throw new Error('The live session did not return a viewer token');

  // --- connect -------------------------------------------------------------
  const room = new Room({ adaptiveStream: true, dynacast: true });

  const attach = (track, participant) => {
    if (!isHost(participant.identity)) return;
    if (track.kind === Track.Kind.Video) {
      track.attach(video);
      setLive(true);
    } else if (track.kind === Track.Kind.Audio) {
      track.attach(audioSink);
    }
  };

  room
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => attach(track, participant))
    .on(RoomEvent.TrackUnsubscribed, (track) => track.detach())
    .on(RoomEvent.ParticipantConnected, () => updateViewers(room))
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      if (p.identity === hostIdentity) setLive(false);
      updateViewers(room);
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      // Browser blocked autoplaying audio → surface a tap-to-enable button.
      unmute.style.display = room.canPlaybackAudio ? 'none' : 'block';
    })
    .on(RoomEvent.Disconnected, () => setLive(false));

  unmute.addEventListener('click', async () => {
    try { await room.startAudio(); } catch { /* ignore */ }
    unmute.style.display = room.canPlaybackAudio ? 'none' : 'block';
  });

  await room.connect(lk, token);
  updateViewers(room);

  // Attach anything already published before our TrackSubscribed handler was
  // wired (autoSubscribe re-fires, but this covers the race deterministically).
  room.remoteParticipants.forEach((participant) => {
    participant.trackPublications.forEach((pub) => {
      if (pub.isSubscribed && pub.track) attach(pub.track, participant);
    });
  });

  // If the host is present but no video landed yet, say "starting…" rather
  // than "offline".
  const hostPresent = hostIdentity
    ? [...room.remoteParticipants.values()].some((p) => p.identity === hostIdentity)
    : room.remoteParticipants.size > 0;
  if (!live) {
    placeholder.textContent = hostPresent ? 'Stream is starting…' : 'The streamer is offline';
    setLive(false);
  }

  // Respect an explicit `?mute=1` by leaving audio muted until a tap.
  if (muted) unmute.style.display = 'block';

  return room;
}
