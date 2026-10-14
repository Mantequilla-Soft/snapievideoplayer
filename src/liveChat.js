// Live chat beside (or over) a live OpenPods stream in the embed, Twitch-style.
//
// OpenPods chat is LiveKit data on the topic `chat`:
//   { type: 'chat', identity, name, text, timestamp }
// (the SDK's useChat). There is no server-side history, so the embed shows the
// messages sent while it is connected. READ-ONLY by design: no input and no
// "chat on 3Speak" prompt, the embed only shows the conversation.
//
// Layout follows the space the embed has:
//   - wide (≥ SIDE_MIN_WIDTH): a dark chat column on the right, the video
//     letterboxed in what is left, the embed keeping its 16:9 footprint;
//   - narrow: messages float over the lower left of the picture, see-through.
// A chat button next to fullscreen hides / shows it (the column also has a
// collapse arrow in its header). Fullscreen shows the video alone.

const SIDE_MIN_WIDTH = 640;
const SIDE_WIDTH = 300;
const MAX_MESSAGES = 200;

const CHAT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function el(tag, styles, text) {
  const node = document.createElement(tag);
  if (styles) Object.assign(node.style, styles);
  if (text != null) node.textContent = text;
  return node;
}

// A stable, readable colour per name, the way Twitch tints usernames.
function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 75%, 68%)`;
}

/**
 * Mount the chat for `room` (a livekit-client Room, before it connects) around
 * the player `wrapper`. Returns nothing; everything hangs off the DOM.
 */
export function mountLiveChat({ wrapper, room }) {
  if (!wrapper || !room || !wrapper.parentNode) return;

  // --- shell: the 16:9 footprint the player had, now shared with the chat ----
  const shell = el('div', {
    position: 'relative', display: 'flex', width: '100%', aspectRatio: '16 / 9',
    maxHeight: '100vh', background: '#000', overflow: 'hidden',
  });
  shell.className = 'live-shell';
  wrapper.parentNode.insertBefore(shell, wrapper);
  shell.appendChild(wrapper);
  Object.assign(wrapper.style, { flex: '1 1 auto', minWidth: '0', height: '100%', aspectRatio: 'auto' });

  // --- the chat panel ---------------------------------------------------------
  const panel = el('aside', { display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', minHeight: '0' });
  panel.className = 'live-chat';
  panel.setAttribute('aria-label', 'Stream chat');
  const head = el('div', {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
    padding: '10px 12px', borderBottom: '1px solid #2f2f35', flexShrink: '0',
    fontSize: '12px', fontWeight: '700', letterSpacing: '0.06em', color: '#efeff1',
  });
  const collapse = el('button', {
    border: 'none', background: 'none', color: '#adadb8', cursor: 'pointer',
    fontSize: '16px', lineHeight: '1', padding: '2px 4px',
  }, '⇥');
  collapse.type = 'button';
  collapse.title = 'Hide chat';
  collapse.setAttribute('aria-label', 'Hide chat');
  head.appendChild(el('span', null, 'STREAM CHAT'));
  head.appendChild(collapse);

  const list = el('div', {
    flex: '1 1 auto', minHeight: '0', overflowY: 'auto', padding: '8px 12px',
    display: 'flex', flexDirection: 'column', gap: '6px',
    fontSize: '13px', lineHeight: '1.4', color: '#efeff1', overflowWrap: 'anywhere',
  });
  const empty = el('div', { color: '#adadb8', fontSize: '12px', margin: 'auto 0 0' }, 'Welcome to the chat! New messages show up here.');
  list.appendChild(empty);

  panel.appendChild(head);
  panel.appendChild(list);
  shell.appendChild(panel);

  // --- the toggle on the video, left of the fullscreen button -----------------
  const toggle = el('button', {
    position: 'absolute', right: '56px', bottom: '12px', zIndex: 6,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '36px', height: '36px', padding: '0', cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.25)', borderRadius: '8px',
    background: 'rgba(0,0,0,0.55)', color: '#fff',
  });
  toggle.type = 'button';
  toggle.className = 'live-chat-toggle';
  toggle.innerHTML = CHAT_ICON;
  if (!wrapper.querySelector('.live-fullscreen')) toggle.style.right = '12px';
  wrapper.appendChild(toggle);

  // --- layout -----------------------------------------------------------------
  let open = true;
  let side = false;
  let unread = 0;
  // Over the picture a message needs its own dark backing; in the column not.
  const styleRow = (row) => Object.assign(row.style, side
    ? { alignSelf: '', maxWidth: '', padding: '', borderRadius: '', background: '', textShadow: '' }
    : {
      alignSelf: 'flex-start', maxWidth: '100%', padding: '3px 8px', borderRadius: '8px',
      background: 'rgba(0,0,0,0.55)', textShadow: '0 1px 2px rgba(0,0,0,0.6)',
    });
  const layout = () => {
    const wasSide = side;
    side = shell.getBoundingClientRect().width >= SIDE_MIN_WIDTH;
    if (side !== wasSide) list.querySelectorAll('.live-chat-row').forEach(styleRow);
    if (side) {
      Object.assign(panel.style, {
        position: 'static', width: `${SIDE_WIDTH}px`, flex: `0 0 ${SIDE_WIDTH}px`, height: '100%',
        background: '#18181b', borderLeft: '1px solid #2f2f35', pointerEvents: 'auto',
        left: '', bottom: '', maxHeight: '', zIndex: '',
      });
      head.style.display = 'flex';
      Object.assign(list.style, { maskImage: '', WebkitMaskImage: '', padding: '8px 12px' });
    } else {
      // Over the picture: lower left, clear of the buttons, fading out at the top.
      Object.assign(panel.style, {
        position: 'absolute', left: '0', bottom: '56px', width: '65%', height: '45%',
        flex: '', background: 'transparent', borderLeft: 'none', zIndex: '5', pointerEvents: 'none',
      });
      head.style.display = 'none';
      const fade = 'linear-gradient(to bottom, transparent 0, #000 30%)';
      Object.assign(list.style, { maskImage: fade, WebkitMaskImage: fade, padding: '8px 12px', pointerEvents: 'auto' });
    }
    panel.style.display = open ? 'flex' : 'none';
    const label = open ? 'Hide chat' : (unread ? `Show chat (${unread} new)` : 'Show chat');
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    toggle.style.background = open ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.75)';
    toggle.style.borderColor = !open && unread ? '#e31337' : 'rgba(255,255,255,0.25)';
  };
  const setOpen = (on) => {
    open = on;
    if (open) unread = 0;
    layout();
    if (open) list.scrollTop = list.scrollHeight;
  };
  toggle.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); });
  collapse.addEventListener('click', (e) => { e.preventDefault(); setOpen(false); });
  layout();
  window.addEventListener('resize', layout);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(layout).observe(shell);

  // --- messages -----------------------------------------------------------------
  const seen = new Set();
  const add = (msg) => {
    const id = `${msg.identity}-${msg.timestamp}`;
    if (seen.has(id)) return;
    seen.add(id);
    if (empty.parentNode) empty.remove();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const row = el('div');
    row.className = 'live-chat-row';
    styleRow(row);
    const who = el('span', { color: nameColor(msg.name), fontWeight: '700' }, msg.name);
    row.appendChild(who);
    row.appendChild(document.createTextNode(`: ${msg.text}`));
    list.appendChild(row);
    while (list.childNodes.length > MAX_MESSAGES) list.removeChild(list.firstChild);
    if (atBottom) list.scrollTop = list.scrollHeight;
    if (!open) { unread += 1; layout(); }
  };

  room.on('dataReceived', (payload, _participant, _kind, topic) => {
    if (topic && topic !== 'chat') return;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(payload));
      if (!parsed || parsed.type !== 'chat' || typeof parsed.text !== 'string') return;
      add({
        identity: String(parsed.identity || ''),
        name: String(parsed.name || parsed.identity || 'guest').slice(0, 40),
        text: parsed.text.slice(0, 500),
        timestamp: Number(parsed.timestamp) || Date.now(),
      });
    } catch { /* not a chat message */ }
  });
}
