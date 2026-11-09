import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakePlayer } from './_helpers/fakePlayer.js';

let ui;
let mgr;
let player;

const q = (sel) => player.el().querySelector(sel);
const menuItems = () => Array.from(player.el().querySelectorAll('.vjs-caption-lang-item'));

beforeEach(async () => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.resetModules();
  mgr = (await import('../../../src/subtitleManager.js')).default;
  ui = await import('../../../src/captionUI.js');
  // No network: picking a language just records it.
  vi.spyOn(mgr, 'selectLanguage').mockImplementation(async function (lang) { this.selectedLang = lang; });
  mgr.availableLanguages = null;
  mgr.selectedLang = null;
  mgr.cues = [];
});

describe('before initCaptionUI', () => {
  it('the state hooks are harmless no-ops', () => {
    expect(() => ui.setCCButtonVisible(true)).not.toThrow();
    expect(() => ui.onSubtitleUpdate()).not.toThrow();
  });
});

describe('initCaptionUI', () => {
  it('adds a hidden overlay and a hidden menu to the player', () => {
    player = createFakePlayer();
    ui.initCaptionUI(player);
    expect(q('.subtitle-overlay').style.display).toBe('none');
    expect(q('.subtitle-overlay .subtitle-overlay-text')).not.toBeNull();
    expect(q('.vjs-caption-menu').style.display).toBe('none');
  });

  it('puts the CC button just before the fullscreen button', () => {
    player = createFakePlayer({ withFullscreenButton: true });
    ui.initCaptionUI(player);
    const btn = q('.vjs-cc-button');
    expect(btn.nextElementSibling).toBe(player.fsButton);
    expect(btn.getAttribute('aria-label')).toBe('Captions');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.textContent).toBe('CC');
  });

  it('appends the CC button when there is no fullscreen button', () => {
    player = createFakePlayer();
    ui.initCaptionUI(player);
    expect(player.controlBar.el().lastElementChild.classList.contains('vjs-cc-button')).toBe(true);
  });

  it('marks the CC button active when a language is already selected', () => {
    mgr.selectedLang = 'en';
    player = createFakePlayer();
    ui.initCaptionUI(player);
    expect(q('.vjs-cc-button').classList.contains('active')).toBe(true);
  });
});

describe('the caption menu', () => {
  beforeEach(() => {
    player = createFakePlayer();
    mgr.availableLanguages = [{ lang: 'en', cid: 'a' }, { lang: 'de', cid: 'b' }, { lang: 'xx', cid: 'c' }];
    ui.initCaptionUI(player);
  });

  it('opens on the CC button with Off and each language by name', () => {
    q('.vjs-cc-button').click();
    expect(q('.vjs-caption-menu').style.display).toBe('');
    expect(q('.vjs-caption-section-title').textContent).toBe('Captions');
    expect(menuItems().map((b) => b.textContent)).toEqual(['Off', 'English', 'German', 'xx']);
    expect(menuItems()[0].classList.contains('active')).toBe(true);
  });

  it('closes on a second press of the CC button', () => {
    q('.vjs-cc-button').click();
    q('.vjs-cc-button').click();
    expect(q('.vjs-caption-menu').style.display).toBe('none');
  });

  it('picking a language selects it, lights the button and marks the item', () => {
    q('.vjs-cc-button').click();
    menuItems()[2].click();
    expect(mgr.selectLanguage).toHaveBeenCalledWith('de');
    expect(q('.vjs-cc-button').classList.contains('active')).toBe(true);
    const active = menuItems().filter((b) => b.classList.contains('active')).map((b) => b.textContent);
    expect(active).toEqual(['German']);
  });

  it('Off turns captions off again', () => {
    q('.vjs-cc-button').click();
    menuItems()[1].click();
    menuItems()[0].click();
    expect(mgr.selectLanguage).toHaveBeenLastCalledWith(null);
    expect(q('.vjs-cc-button').classList.contains('active')).toBe(false);
  });

  it('clicks inside the menu never reach the player (which would toggle playback)', () => {
    const onPlayerClick = vi.fn();
    player.el().addEventListener('click', onPlayerClick);
    q('.vjs-cc-button').click();
    q('.vjs-caption-menu').click();
    menuItems()[1].click();
    expect(onPlayerClick).not.toHaveBeenCalled();
  });

  it('closes on a click anywhere else on the page', () => {
    q('.vjs-cc-button').click();
    document.body.click();
    expect(q('.vjs-caption-menu').style.display).toBe('none');
  });

  it('shows only Off when no languages are known', () => {
    mgr.availableLanguages = null;
    q('.vjs-cc-button').click();
    expect(menuItems().map((b) => b.textContent)).toEqual(['Off']);
  });
});

describe('onSubtitleUpdate', () => {
  beforeEach(() => {
    player = createFakePlayer();
    ui.initCaptionUI(player);
  });

  it('syncs the button with the selected language', () => {
    mgr.selectedLang = 'en';
    ui.onSubtitleUpdate();
    expect(q('.vjs-cc-button').classList.contains('active')).toBe(true);
    mgr.selectedLang = null;
    ui.onSubtitleUpdate();
    expect(q('.vjs-cc-button').classList.contains('active')).toBe(false);
  });

  it('rebuilds an open menu when the languages arrive', () => {
    q('.vjs-cc-button').click();
    expect(menuItems()).toHaveLength(1);
    mgr.availableLanguages = [{ lang: 'fr', cid: 'x' }];
    ui.onSubtitleUpdate();
    expect(menuItems().map((b) => b.textContent)).toEqual(['Off', 'French']);
  });

  it('leaves a closed menu alone', () => {
    mgr.availableLanguages = [{ lang: 'fr', cid: 'x' }];
    ui.onSubtitleUpdate();
    expect(menuItems()).toHaveLength(1);
  });
});

describe('updateOverlay', () => {
  beforeEach(() => {
    player = createFakePlayer();
    ui.initCaptionUI(player);
    mgr.cues = [{ start: 1, end: 2, text: 'Hello' }, { start: 3, end: 4, text: 'World' }];
  });

  it('shows the active cue and hides between cues', () => {
    ui.updateOverlay(1.5);
    expect(q('.subtitle-overlay').style.display).toBe('');
    expect(q('.subtitle-overlay-text').textContent).toBe('Hello');
    ui.updateOverlay(2.5);
    expect(q('.subtitle-overlay').style.display).toBe('none');
    ui.updateOverlay(3.1);
    expect(q('.subtitle-overlay-text').textContent).toBe('World');
  });

  it('only touches the DOM when the cue changes', () => {
    ui.updateOverlay(1.2);
    q('.subtitle-overlay-text').textContent = 'edited';
    ui.updateOverlay(1.8);
    expect(q('.subtitle-overlay-text').textContent).toBe('edited');
  });
});

describe('setCCButtonVisible', () => {
  it('hides and shows the CC button', () => {
    player = createFakePlayer();
    ui.initCaptionUI(player);
    ui.setCCButtonVisible(false);
    expect(q('.vjs-cc-button').style.display).toBe('none');
    ui.setCCButtonVisible(true);
    expect(q('.vjs-cc-button').style.display).toBe('');
  });
});
