import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTimelineUI } from '../../../src/timelineUI.js';
import { createFakePlayer, setRect } from './_helpers/fakePlayer.js';

let player;
let hooks;
let ui;

const VIDEO = { at: 10, dur: 8, kind: 'video', author: 'badadib', permlink: 'badadib-next', title: 'Next part' };
const PROFILE = { at: 12, dur: 8, kind: 'profile', account: 'badadib' };
const URL_LINK = { at: 14, dur: 8, kind: 'url', url: 'https://example.com/page', site: 'example.com', title: 'Docs' };
const CHAPTERS = [{ start: 0, title: 'Intro' }, { start: 25, title: 'Setup' }, { start: 75, title: 'Wrap' }];

const stack = () => player.el().querySelector('.vjs-link-toasts');
const cards = () => Array.from(player.el().querySelectorAll('.vjs-link-toast'));
const titles = () => cards().map((c) => c.querySelector('.vjs-link-toast-title').textContent);
const kickers = () => cards().map((c) => c.querySelector('.vjs-link-toast-kicker').textContent);
const seekBar = () => player.controlBar.progressControl.seekBar.el();
const gaps = () => Array.from(seekBar().querySelectorAll('.vjs-chapter-gap')).map((g) => g.style.left);

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1; });
  player = createFakePlayer({ currentTime: 0, paused: false });
  setRect(player.el(), { left: 0, top: 0, width: 800, height: 450 });
  hooks = { contentTime: vi.fn((t) => t), contentDuration: vi.fn(() => 100), adHold: vi.fn(() => false) };
  ui = createTimelineUI(player, hooks);
});

describe('link toasters', () => {
  beforeEach(() => { ui.setTimeline({ chapters: [], links: [VIDEO] }); });

  it('shows a card only while its link is due', () => {
    ui.update(9.9);
    expect(cards()).toHaveLength(0);
    ui.update(10);
    expect(cards()).toHaveLength(1);
    ui.update(17.9);
    expect(cards()).toHaveLength(1);
    ui.update(18);
    expect(cards()).toHaveLength(0);
  });

  it('builds a video card that opens the video in a new tab', () => {
    ui.update(11);
    const [card] = cards();
    expect(card.className).toContain('vjs-link-toast-video');
    expect(card.getAttribute('role')).toBe('note');
    expect(card.classList.contains('is-in')).toBe(true);
    const a = card.querySelector('a.vjs-link-toast-main');
    expect(a.href).toBe('https://3speak.tv/watch?v=badadib/badadib-next');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer nofollow ugc');
    expect(a.getAttribute('aria-label')).toBe('Next part (opens in a new tab)');
    expect(kickers()).toEqual(['Video · @badadib']);
    expect(titles()).toEqual(['Next part']);
    expect(card.querySelector('img').src).toBe('https://images.hive.blog/u/badadib/avatar/small');
  });

  it('measures in content time, through the hook', () => {
    hooks.contentTime.mockImplementation((t) => t - 30);
    ui.update(20);
    expect(cards()).toHaveLength(0);
    ui.update(41);
    expect(cards()).toHaveLength(1);
    expect(hooks.contentTime).toHaveBeenCalledWith(41);
  });

  it('clicking the link pauses a playing video', () => {
    ui.update(11);
    cards()[0].querySelector('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(player.pause).toHaveBeenCalled();
  });

  it('clicking the link of a paused video does not pause again, and a throwing player is ignored', () => {
    ui.update(11);
    const a = cards()[0].querySelector('a');
    const click = () => a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    player.state.paused = true;
    click();
    expect(player.pause).not.toHaveBeenCalled();
    player.paused.mockImplementation(() => { throw new Error('disposed'); });
    expect(click).not.toThrow();
  });

  it('never lets a click through to the player', () => {
    ui.update(11);
    const onPlayer = vi.fn();
    player.el().addEventListener('click', onPlayer);
    stack().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPlayer).not.toHaveBeenCalled();
  });

  it('a dismissed card stays away until a new timeline is set', () => {
    ui.update(11);
    cards()[0].querySelector('.vjs-link-toast-close').click();
    expect(cards()).toHaveLength(0);
    ui.update(12);
    expect(cards()).toHaveLength(0);
    ui.setTimeline({ chapters: [], links: [VIDEO] });
    ui.update(12);
    expect(cards()).toHaveLength(1);
  });

  it('a broken avatar is hidden rather than shown as a broken image', () => {
    ui.update(11);
    const img = cards()[0].querySelector('img');
    img.dispatchEvent(new Event('error'));
    expect(img.style.visibility).toBe('hidden');
  });

  it.each([
    ['not started', () => { player.state.hasStarted = false; }],
    ['ended', () => { player.state.ended = true; }],
    ['an ad is due', () => { hooks.adHold.mockReturnValue(true); }],
  ])('clears the cards when the video has %s', (_name, arrange) => {
    ui.update(11);
    expect(cards()).toHaveLength(1);
    arrange();
    ui.update(11);
    expect(cards()).toHaveLength(0);
  });

  it('rebuilds the stack if something removed it', () => {
    ui.update(11);
    stack().remove();
    ui.update(12);
    expect(stack()).not.toBeNull();
  });
});

describe('card text for each kind of link', () => {
  const show = (link) => {
    ui.setTimeline({ chapters: [], links: [{ ...link, at: 0, dur: 8 }] });
    ui.update(1);
    return { kicker: kickers()[0], title: titles()[0], card: cards()[0] };
  };

  it('a video without a title', () => {
    expect(show({ kind: 'video', author: 'badadib', permlink: 'x' }).title).toBe('Watch on 3Speak');
  });

  it('a profile with and without a title', () => {
    const named = show({ kind: 'profile', account: 'badadib', title: 'My channel' });
    expect([named.kicker, named.title]).toEqual(['Channel · @badadib', 'My channel']);
    expect(named.card.querySelector('a').href).toBe('https://3speak.tv/p/badadib');
    const bare = show({ kind: 'profile', account: 'badadib' });
    expect([bare.kicker, bare.title]).toEqual(['Channel', '@badadib']);
  });

  it('a web link with and without a title, with a link glyph', () => {
    const named = show(URL_LINK);
    expect([named.kicker, named.title]).toEqual(['example.com', 'Docs']);
    expect(named.card.querySelector('svg')).not.toBeNull();
    const bare = show({ kind: 'url', url: 'https://example.com/x', site: 'example.com' });
    expect([bare.kicker, bare.title]).toEqual(['Link', 'example.com']);
    const noSite = show({ kind: 'url', url: 'https://example.com/y' });
    expect([noSite.kicker, noSite.title]).toEqual(['Link', 'https://example.com/y']);
    const titledNoSite = show({ kind: 'url', url: 'https://example.com/z', title: 'Z' });
    expect(titledNoSite.kicker).toBe('Link');
  });

  it('drops a link that has nowhere safe to go', () => {
    ui.setTimeline({ chapters: [], links: [{ at: 0, dur: 8, kind: 'url', url: 'javascript:alert(1)' }] });
    ui.update(1);
    ui.update(2);
    expect(cards()).toHaveLength(0);
  });

  it('writes user text as text, never as markup', () => {
    const { title, card } = show({ kind: 'profile', account: 'badadib', title: '<img src=x onerror=alert(1)>' });
    expect(title).toBe('<img src=x onerror=alert(1)>');
    expect(card.querySelectorAll('img')).toHaveLength(1);
  });
});

describe('stacking several cards', () => {
  beforeEach(() => { ui.setTimeline({ chapters: [], links: [VIDEO, PROFILE, URL_LINK] }); });

  it('keeps the two newest, newest on top, on a full-size player', () => {
    ui.update(15);
    expect(titles()).toEqual(['Docs', '@badadib']);
    expect(stack().classList.contains('is-compact')).toBe(false);
  });

  it('keeps one card on a compact player', () => {
    setRect(player.el(), { width: 400, height: 225 });
    ui.update(15);
    expect(titles()).toEqual(['Docs']);
    expect(stack().classList.contains('is-compact')).toBe(true);
    expect(stack().classList.contains('is-tiny')).toBe(false);
  });

  it('flags a tiny player', () => {
    setRect(player.el(), { width: 280, height: 160 });
    ui.update(15);
    expect(stack().classList.contains('is-tiny')).toBe(true);
  });

  it('drops cards that fall out of the window and keeps the order right', () => {
    ui.update(13);
    expect(titles()).toEqual(['@badadib', 'Next part']);
    ui.update(19);
    expect(titles()).toEqual(['Docs', '@badadib']);
    ui.update(21);
    expect(titles()).toEqual(['Docs']);
  });
});

describe('placing the stack', () => {
  beforeEach(() => { ui.setTimeline({ chapters: [], links: [VIDEO] }); });

  function obstacle(className, rect, display) {
    const el = document.createElement('div');
    el.className = className;
    if (display) el.style.display = display;
    setRect(el, rect);
    player.el().appendChild(el);
    return el;
  }

  it('sits 10px from the top when the corner is free', () => {
    ui.update(11);
    expect(stack().style.top).toBe('10px');
  });

  it('sits below the ticker band', () => {
    obstacle('vjs-ticker', { left: 0, top: 0, width: 800, height: 40 });
    ui.update(11);
    expect(stack().style.top).toBe('48px');
  });

  it('sits below the visible muted-autoplay button in the right half', () => {
    obstacle('vjs-muted-autoplay-info visible', { left: 600, top: 10, width: 150, height: 50 });
    ui.update(11);
    expect(stack().style.top).toBe('68px');
  });

  it('ignores obstacles that are hidden, empty or in the left half', () => {
    obstacle('vjs-ticker', { left: 0, top: 0, width: 800, height: 40 }, 'none');
    obstacle('vjs-muted-autoplay-info visible', { left: 0, top: 0, width: 300, height: 90 });
    ui.update(11);
    expect(stack().style.top).toBe('10px');
    document.querySelector('.vjs-ticker').remove();
    obstacle('vjs-ticker', { left: 0, top: 0, width: 0, height: 0 });
    ui.update(12);
    expect(stack().style.top).toBe('10px');
  });
});

describe('chapter marks on the seek bar', () => {
  it('draws a gap at each chapter start after the first, in content time', () => {
    ui.setTimeline({ chapters: CHAPTERS, links: [] });
    expect(gaps()).toEqual(['25%', '75%']);
    expect(seekBar().querySelector('.vjs-chapter-marks').getAttribute('aria-hidden')).toBe('true');
  });

  it('skips chapters at or past the end', () => {
    ui.setTimeline({ chapters: [...CHAPTERS, { start: 100, title: 'Late' }], links: [] });
    expect(gaps()).toEqual(['25%', '75%']);
  });

  it('makes a static seek bar a positioning context', () => {
    seekBar().style.position = 'static';
    ui.setTimeline({ chapters: CHAPTERS, links: [] });
    expect(seekBar().style.position).toBe('relative');
  });

  it('draws nothing for a single chapter or an unknown duration', () => {
    ui.setTimeline({ chapters: [CHAPTERS[0]], links: [VIDEO] });
    expect(gaps()).toEqual([]);
    hooks.contentDuration.mockReturnValue(null);
    ui.setTimeline({ chapters: CHAPTERS, links: [] });
    expect(gaps()).toEqual([]);
  });

  it('redraws when the content length changes, and only then', () => {
    ui.setTimeline({ chapters: CHAPTERS, links: [] });
    const marks = seekBar().querySelector('.vjs-chapter-marks');
    ui.update(1);
    expect(seekBar().querySelector('.vjs-chapter-marks')).toBe(marks);
    hooks.contentDuration.mockReturnValue(50);
    ui.update(1);
    expect(gaps()).toEqual(['50%']);
  });

  it('puts the marks back if something removed them', () => {
    ui.setTimeline({ chapters: CHAPTERS, links: [] });
    seekBar().querySelector('.vjs-chapter-marks').remove();
    ui.update(1);
    expect(gaps()).toEqual(['25%', '75%']);
  });

  it('removes the marks when the timeline goes away', () => {
    ui.setTimeline({ chapters: CHAPTERS, links: [] });
    ui.setTimeline(null);
    expect(seekBar().querySelector('.vjs-chapter-marks')).toBeNull();
    ui.setTimeline({ chapters: [], links: [] });
    expect(seekBar().querySelector('.vjs-chapter-marks')).toBeNull();
  });

  it('draws nothing on a player with no seek bar', () => {
    const bare = createFakePlayer({ withSeekBar: false });
    const u = createTimelineUI(bare, hooks);
    expect(() => u.setTimeline({ chapters: CHAPTERS, links: [] })).not.toThrow();
  });
});

describe('chapterLabel', () => {
  it('names the chapter at a fraction of the bar', () => {
    ui.setTimeline({ chapters: CHAPTERS, links: [] });
    expect(ui.chapterLabel(0)).toBe('Intro');
    expect(ui.chapterLabel(0.3)).toBe('Setup');
    expect(ui.chapterLabel(2)).toBe('Wrap');
    expect(ui.chapterLabel(-1)).toBe('Intro');
  });

  it('is empty without chapters, a duration or a usable fraction', () => {
    expect(ui.chapterLabel(0.5)).toBe('');
    ui.setTimeline({ chapters: [{ start: 10, title: 'Only' }], links: [VIDEO] });
    expect(ui.chapterLabel(0.5)).toBe('');
    ui.setTimeline({ chapters: [{ start: 10, title: 'A' }, { start: 20, title: 'B' }], links: [] });
    expect(ui.chapterLabel(0.05)).toBe('');
    expect(ui.chapterLabel(NaN)).toBe('');
    hooks.contentDuration.mockReturnValue(0);
    expect(ui.chapterLabel(0.5)).toBe('');
  });
});

describe('player events', () => {
  it('refreshes on seeks, play, resizes and metadata', () => {
    for (const ev of ['seeked', 'ended', 'play', 'playerresize', 'fullscreenchange', 'durationchange', 'loadedmetadata']) {
      expect(player.listenerCount(ev)).toBe(1);
    }
    ui.setTimeline({ chapters: [], links: [VIDEO] });
    player.state.currentTime = 11;
    player.trigger('seeked');
    expect(cards()).toHaveLength(1);
  });

  it('update() without a time reads the player clock', () => {
    ui.setTimeline({ chapters: [], links: [VIDEO] });
    player.state.currentTime = 11;
    ui.update(undefined);
    expect(cards()).toHaveLength(1);
  });

  it('a refresh on a broken player is swallowed', () => {
    player.currentTime.mockImplementation(() => { throw new Error('disposed'); });
    expect(() => player.trigger('play')).not.toThrow();
  });

  it('does nothing on a player without an element', () => {
    player.el = () => null;
    ui.setTimeline({ chapters: [], links: [VIDEO] });
    expect(() => ui.update(11)).not.toThrow();
  });
});
