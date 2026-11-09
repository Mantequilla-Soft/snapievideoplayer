import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stubFetch, jsonResponse } from './_helpers/fetchStub.js';

const SRT_EN = '1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:05,000 --> 00:00:06,000\nAgain\n';
const SRT_ES = '1\n00:00:01,000 --> 00:00:03,000\nHola\n';
const LANGS = [{ lang: 'en', cid: 'QmEn' }, { lang: 'es', cid: 'QmEs' }];
const LANG_KEY = '3speak-subtitle-lang';

let mgr;
let onUpdate;

/** A translator + IPFS answering from `routes` (url fragment -> answer). Unknown URLs are a 404. */
function network(routes) {
  return stubFetch((url) => {
    for (const [frag, answer] of Object.entries(routes)) {
      if (url.includes(frag)) return typeof answer === 'function' ? answer(url) : answer;
    }
    return new Response('missing', { status: 404 });
  });
}
const text = (body, status = 200) => new Response(body, { status });

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  mgr = (await import('../../../src/subtitleManager.js')).default;
  onUpdate = vi.fn();
  mgr.init(onUpdate);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('checkAvailability', () => {
  it('clears everything and notifies when no video is given', async () => {
    const net = network({});
    mgr.availableLanguages = LANGS;
    mgr.cues = [{ start: 0, end: 1, text: 'x' }];
    await mgr.checkAvailability('badadib', '');
    expect(mgr.availableLanguages).toBeNull();
    expect(mgr.cues).toEqual([]);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(net.calls).toHaveLength(0);
  });

  it('asks the first translator for the languages of the video', async () => {
    const net = network({ 'translate.3speak.tv/subtitles/badadib/badadib-video': jsonResponse(LANGS) });
    await mgr.checkAvailability('badadib', 'badadib-video');
    expect(net.calls.map((c) => c.url)).toEqual(['https://translate.3speak.tv/subtitles/badadib/badadib-video']);
    expect(mgr.availableLanguages).toEqual(LANGS);
    expect(mgr.selectedLang).toBeNull();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('falls back to the second translator when the first errors or is down', async () => {
    let net = network({
      'translate.3speak.tv': text('', 500),
      '3speak-translator.okinoko.io/subtitles/badadib/p': jsonResponse(LANGS),
    });
    await mgr.checkAvailability('badadib', 'p');
    expect(net.calls.map((c) => c.url)).toEqual([
      'https://translate.3speak.tv/subtitles/badadib/p',
      'https://3speak-translator.okinoko.io/subtitles/badadib/p',
    ]);
    expect(mgr.availableLanguages).toEqual(LANGS);

    net = network({ 'translate.3speak.tv': new Error('offline'), 'okinoko.io': jsonResponse(LANGS) });
    await mgr.checkAvailability('badadib', 'p');
    expect(net.calls).toHaveLength(2);
    expect(mgr.availableLanguages).toEqual(LANGS);
  });

  it('reports no subtitles when both translators fail', async () => {
    network({ 'translate.3speak.tv': new Error('offline'), 'okinoko.io': text('', 502) });
    await mgr.checkAvailability('badadib', 'p');
    expect(mgr.availableLanguages).toBeNull();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('reports no subtitles for an empty or malformed list', async () => {
    network({ 'translate.3speak.tv': jsonResponse([]) });
    await mgr.checkAvailability('badadib', 'p');
    expect(mgr.availableLanguages).toBeNull();
    network({ 'translate.3speak.tv': jsonResponse({ en: 'QmEn' }) });
    await mgr.checkAvailability('badadib', 'p');
    expect(mgr.availableLanguages).toBeNull();
  });

  it('logs and reports none when the answer is not JSON', async () => {
    network({ 'translate.3speak.tv': text('<html>') });
    await mgr.checkAvailability('badadib', 'p');
    expect(mgr.availableLanguages).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it('re-selects the language the viewer chose before', async () => {
    localStorage.setItem(LANG_KEY, 'es');
    const net = network({ 'translate.3speak.tv': jsonResponse(LANGS), 'hotipfs-3speak-1.b-cdn.net/ipfs/QmEs': text(SRT_ES) });
    await mgr.checkAvailability('badadib', 'p');
    expect(mgr.selectedLang).toBe('es');
    expect(mgr.cues).toEqual([{ start: 1, end: 3, text: 'Hola' }]);
    expect(net.calls[1].url).toBe('https://hotipfs-3speak-1.b-cdn.net/ipfs/QmEs');
  });

  it('falls back to English when the remembered language is not offered', async () => {
    localStorage.setItem(LANG_KEY, 'fr');
    network({ 'translate.3speak.tv': jsonResponse(LANGS), 'QmEn': text(SRT_EN) });
    await mgr.checkAvailability('badadib', 'p');
    expect(mgr.selectedLang).toBe('en');
  });

  it('selects nothing when neither the remembered language nor English is offered', async () => {
    localStorage.setItem(LANG_KEY, 'fr');
    network({ 'translate.3speak.tv': jsonResponse([{ lang: 'de', cid: 'QmDe' }]) });
    await mgr.checkAvailability('badadib', 'p');
    expect(mgr.selectedLang).toBeNull();
    expect(mgr.cues).toEqual([]);
  });
});

describe('selectLanguage', () => {
  beforeEach(async () => {
    network({ 'translate.3speak.tv': jsonResponse(LANGS) });
    await mgr.checkAvailability('badadib', 'p');
    onUpdate.mockClear();
  });

  it('turning captions off forgets the choice and clears the cues', async () => {
    localStorage.setItem(LANG_KEY, 'en');
    mgr.cues = [{ start: 0, end: 1, text: 'x' }];
    await mgr.selectLanguage(null);
    expect(localStorage.getItem(LANG_KEY)).toBeNull();
    expect(mgr.selectedLang).toBeNull();
    expect(mgr.cues).toEqual([]);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('fetches the SRT from the CDN, parses it and remembers the choice', async () => {
    const net = network({ 'b-cdn.net/ipfs/QmEn': text(SRT_EN) });
    const pending = mgr.selectLanguage('en');
    expect(mgr.loading).toBe(true);
    await pending;
    expect(mgr.loading).toBe(false);
    expect(net.calls.map((c) => c.url)).toEqual(['https://hotipfs-3speak-1.b-cdn.net/ipfs/QmEn']);
    expect(mgr.cues).toHaveLength(2);
    expect(localStorage.getItem(LANG_KEY)).toBe('en');
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('goes through the checker proxy when the CDN fails or misses', async () => {
    let net = network({ 'b-cdn.net': text('block was not found locally', 500), 'checker.3speak.tv/subtitle-proxy/QmEn': text(SRT_EN) });
    await mgr.selectLanguage('en');
    expect(net.calls.map((c) => c.url)).toEqual([
      'https://hotipfs-3speak-1.b-cdn.net/ipfs/QmEn',
      'https://checker.3speak.tv/subtitle-proxy/QmEn',
    ]);
    expect(mgr.cues).toHaveLength(2);

    net = network({ 'b-cdn.net': new Error('offline'), 'subtitle-proxy/QmEs': text(SRT_ES) });
    await mgr.selectLanguage('es');
    expect(net.calls.map((c) => c.url)).toEqual([
      'https://hotipfs-3speak-1.b-cdn.net/ipfs/QmEs',
      'https://checker.3speak.tv/subtitle-proxy/QmEs',
    ]);
    expect(mgr.cues[0].text).toBe('Hola');
  });

  it('shows no cues when the proxy fails too', async () => {
    network({ 'b-cdn.net': text('', 500), 'subtitle-proxy': text('', 502) });
    await mgr.selectLanguage('en');
    expect(mgr.cues).toEqual([]);
    expect(mgr.loading).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it('serves a language picked again from memory', async () => {
    const net = network({ 'QmEn': text(SRT_EN), 'QmEs': text(SRT_ES) });
    await mgr.selectLanguage('en');
    await mgr.selectLanguage('es');
    await mgr.selectLanguage('en');
    expect(net.calls).toHaveLength(2);
    expect(mgr.cues[0].text).toBe('Hello');
  });

  it('a language that is not offered gives no cues and no request', async () => {
    const net = network({});
    await mgr.selectLanguage('fr');
    expect(mgr.cues).toEqual([]);
    expect(net.calls).toHaveLength(0);
    expect(localStorage.getItem(LANG_KEY)).toBe('fr');
  });

  it('before availability is known, gives no cues', async () => {
    mgr.availableLanguages = null;
    const net = network({});
    await mgr.selectLanguage('en');
    expect(mgr.cues).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  it.skip('BUG: an SRT that arrives after the video changed is not applied to the new video', async () => {
    let release;
    network({ 'QmEn': () => new Promise((r) => { release = () => r(text(SRT_EN)); }) });
    const first = mgr.selectLanguage('en');
    await new Promise((r) => setTimeout(r, 0));
    network({ 'translate.3speak.tv': jsonResponse([]) });
    await mgr.checkAvailability('badadib', 'another-video');
    release();
    await first;
    // The new video has no subtitles at all, so no cue may show on it.
    expect(mgr.cues).toEqual([]);
    expect(mgr.getActiveCue(2)).toBeNull();
  });
});

describe('getActiveCue', () => {
  it('is null with no cues', () => {
    mgr.cues = [];
    expect(mgr.getActiveCue(1)).toBeNull();
    mgr.cues = null;
    expect(mgr.getActiveCue(1)).toBeNull();
  });

  it('finds the cue on screen, start inclusive and end exclusive', () => {
    mgr.cues = [{ start: 1, end: 2, text: 'a' }, { start: 3, end: 4, text: 'b' }, { start: 5, end: 6, text: 'c' }];
    expect(mgr.getActiveCue(0.5)).toBeNull();
    expect(mgr.getActiveCue(1)).toBe('a');
    expect(mgr.getActiveCue(2)).toBeNull();
    expect(mgr.getActiveCue(3.5)).toBe('b');
    expect(mgr.getActiveCue(5.99)).toBe('c');
    expect(mgr.getActiveCue(10)).toBeNull();
  });

  it('keeps an earlier long cue showing after a shorter later one ended', () => {
    mgr.cues = [{ start: 0, end: 10, text: 'long' }, { start: 2, end: 3, text: 'short' }];
    expect(mgr.getActiveCue(2.5)).toBe('short');
    expect(mgr.getActiveCue(5)).toBe('long');
  });
});

describe('notifications', () => {
  it('work without a callback', async () => {
    mgr.init(null);
    network({});
    await expect(mgr.checkAvailability(null, null)).resolves.toBeUndefined();
  });
});
