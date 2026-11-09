import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountLiveChat } from '../../../src/liveChat.js';

let wrapper;
let room;
let shellWidth;

function fakeRoom() {
  const handlers = {};
  return {
    on: vi.fn((ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }),
    emit(ev, ...args) { (handlers[ev] || []).forEach((fn) => fn(...args)); },
  };
}

/** Deliver a LiveKit data packet the way the room does. */
function send(msg, topic = 'chat') {
  const payload = new TextEncoder().encode(typeof msg === 'string' ? msg : JSON.stringify(msg));
  room.emit('dataReceived', payload, null, 0, topic);
}
const chat = (over = {}) => ({ type: 'chat', identity: 'badadib', name: 'badadib', text: 'hello', timestamp: 1, ...over });

const shell = () => document.querySelector('.live-shell');
const panel = () => document.querySelector('.live-chat');
const toggle = () => wrapper.querySelector('.live-chat-toggle');
const rows = () => Array.from(panel().querySelectorAll('.live-chat-row'));
const rowText = () => rows().map((r) => r.textContent);
const head = () => panel().firstElementChild;
const list = () => panel().children[1];

function mount({ width = 1000, fullscreenButton = false } = {}) {
  shellWidth = width;
  if (fullscreenButton) {
    const fs = document.createElement('button');
    fs.className = 'live-fullscreen';
    wrapper.appendChild(fs);
  }
  mountLiveChat({ wrapper, room });
}

function resizeTo(width) {
  shellWidth = width;
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  document.body.innerHTML = '<main><div class="player-wrapper"></div></main>';
  wrapper = document.querySelector('.player-wrapper');
  room = fakeRoom();
  shellWidth = 1000;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const width = this.classList.contains('live-shell') ? shellWidth : 0;
    return { left: 0, top: 0, width, height: width * 9 / 16, right: width, bottom: 0 };
  });
});

describe('mountLiveChat', () => {
  it('does nothing without a wrapper in the page or a room', () => {
    mountLiveChat({ wrapper: null, room });
    mountLiveChat({ wrapper, room: null });
    mountLiveChat({ wrapper: document.createElement('div'), room });
    expect(shell()).toBeNull();
    expect(room.on).not.toHaveBeenCalled();
  });

  it('wraps the player in a 16:9 shell shared with a chat column', () => {
    mount();
    expect(shell().parentNode.tagName).toBe('MAIN');
    expect(shell().firstElementChild).toBe(wrapper);
    expect(shell().lastElementChild).toBe(panel());
    expect(panel().getAttribute('aria-label')).toBe('Stream chat');
    expect(head().textContent).toContain('STREAM CHAT');
    expect(list().textContent).toBe('Welcome to the chat! New messages show up here.');
  });

  it('puts the chat toggle left of the fullscreen button, or in the corner without one', () => {
    mount({ fullscreenButton: true });
    expect(toggle().style.right).toBe('56px');
    document.body.innerHTML = '<main><div class="player-wrapper"></div></main>';
    wrapper = document.querySelector('.player-wrapper');
    mount();
    expect(toggle().style.right).toBe('12px');
  });

  it('listens for data on the room', () => {
    mount();
    expect(room.on).toHaveBeenCalledWith('dataReceived', expect.any(Function));
  });
});

describe('layout', () => {
  it('is a 300px side column on a wide embed', () => {
    mount({ width: 1000 });
    expect(panel().style.position).toBe('static');
    expect(panel().style.width).toBe('300px');
    expect(head().style.display).toBe('flex');
  });

  it('floats over the lower left of the picture on a narrow embed', () => {
    mount({ width: 500 });
    expect(panel().style.position).toBe('absolute');
    expect(panel().style.width).toBe('65%');
    expect(panel().style.pointerEvents).toBe('none');
    expect(head().style.display).toBe('none');
  });

  it('follows resizes and restyles the rows already shown', () => {
    mount({ width: 500 });
    send(chat());
    expect(rows()[0].style.background).toBe('rgba(0, 0, 0, 0.55)');
    resizeTo(900);
    expect(panel().style.position).toBe('static');
    expect(rows()[0].style.background).toBe('');
    resizeTo(400);
    expect(rows()[0].style.background).toBe('rgba(0, 0, 0, 0.55)');
  });
});

describe('messages', () => {
  beforeEach(() => mount());

  it('shows a chat message as a coloured name and its text', () => {
    send(chat({ name: 'badadib', text: 'gm' }));
    expect(rowText()).toEqual(['badadib: gm']);
    const who = rows()[0].firstElementChild;
    expect(who.textContent).toBe('badadib');
    expect(who.style.color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(list().textContent).not.toContain('Welcome to the chat');
  });

  it('gives a name the same colour every time, and different names different colours', () => {
    send(chat({ identity: 'a', name: 'badadib', timestamp: 1 }));
    send(chat({ identity: 'b', name: 'badadib', timestamp: 2 }));
    send(chat({ identity: 'c', name: 'someone', timestamp: 3 }));
    const colours = rows().map((r) => r.firstElementChild.style.color);
    expect(colours[0]).toBe(colours[1]);
    expect(colours[2]).not.toBe(colours[0]);
  });

  it('falls back to the identity, then to guest, for the name', () => {
    send(chat({ name: '', identity: 'guest-42', timestamp: 1 }));
    send(chat({ name: undefined, identity: undefined, timestamp: 2 }));
    expect(rowText()).toEqual(['guest-42: hello', 'guest: hello']);
  });

  it('caps names at 40 and text at 500 characters', () => {
    send(chat({ name: 'n'.repeat(60), text: 't'.repeat(600) }));
    const [row] = rows();
    expect(row.firstElementChild.textContent).toHaveLength(40);
    expect(row.textContent).toHaveLength(40 + 2 + 500);
  });

  it('renders text as text, never as markup', () => {
    send(chat({ text: '<img src=x onerror=alert(1)>' }));
    expect(rows()[0].querySelector('img')).toBeNull();
    expect(rowText()[0]).toBe('badadib: <img src=x onerror=alert(1)>');
  });

  it('shows a message only once', () => {
    send(chat());
    send(chat());
    expect(rows()).toHaveLength(1);
  });

  it('dates a message with no timestamp itself', () => {
    send(chat({ timestamp: undefined }));
    expect(rows()).toHaveLength(1);
  });

  it('ignores other topics, other message types and junk', () => {
    send(chat(), 'reactions');
    send({ type: 'reaction', text: 'x' });
    send({ type: 'chat', text: 42 });
    send('not json');
    send('null');
    expect(rows()).toHaveLength(0);
  });

  it('accepts a packet with no topic', () => {
    send(chat(), undefined);
    expect(rows()).toHaveLength(1);
  });

  it('keeps at most 200 messages', () => {
    for (let i = 0; i < 205; i += 1) send(chat({ timestamp: i, text: `m${i}` }));
    expect(rows()).toHaveLength(200);
    expect(rowText()[0]).toBe('badadib: m5');
  });
});

describe('hiding and showing the chat', () => {
  beforeEach(() => mount());

  it('the toggle hides the chat and shows it again', () => {
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().title).toBe('Hide chat');
    toggle().click();
    expect(panel().style.display).toBe('none');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().title).toBe('Show chat');
    toggle().click();
    expect(panel().style.display).toBe('flex');
  });

  it('the collapse arrow in the header hides it', () => {
    head().querySelector('button').click();
    expect(panel().style.display).toBe('none');
  });

  it('counts messages that arrive while hidden, and clears the count on open', () => {
    toggle().click();
    send(chat({ timestamp: 1 }));
    send(chat({ timestamp: 2 }));
    expect(toggle().title).toBe('Show chat (2 new)');
    expect(toggle().getAttribute('aria-label')).toBe('Show chat (2 new)');
    expect(toggle().style.borderColor).toBe('rgb(227, 19, 55)');
    toggle().click();
    toggle().click();
    expect(toggle().title).toBe('Show chat');
  });

  it('the toggle click never reaches the player', () => {
    const onWrapper = vi.fn();
    wrapper.addEventListener('click', onWrapper);
    toggle().click();
    expect(onWrapper).not.toHaveBeenCalled();
  });
});
