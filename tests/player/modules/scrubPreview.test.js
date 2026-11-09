import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakePlayer, setRect } from './_helpers/fakePlayer.js';

vi.mock('hls.js', async () => ({ default: (await import('./_helpers/fakeHls.js')).FakeHls }));
const { FakeHls } = await import('./_helpers/fakeHls.js');
const { createScrubPreview } = await import('../../../src/scrubPreview.js');

let player;
let progress;
let preview;
let seeks;
let seeking;

const wrap = () => player.el().querySelector('.scrub-preview');
const vid = () => wrap().querySelector('video');
const timeText = () => wrap().querySelector('.scrub-preview-time').textContent;
const chapter = () => wrap().querySelector('.scrub-preview-chapter');
const visible = () => wrap().classList.contains('visible');

function pointer(target, type, { clientX = 0, pointerType = 'mouse' } = {}) {
  const ev = new MouseEvent(type, { clientX, bubbles: true });
  Object.defineProperty(ev, 'pointerType', { value: pointerType });
  target.dispatchEvent(ev);
}

/** Record seeks on the preview <video> instead of jsdom's no-op media clock. */
function watchSeeks(video) {
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => seeks[seeks.length - 1] || 0,
    set: (v) => { seeks.push(v); },
  });
  Object.defineProperty(video, 'seeking', { configurable: true, get: () => seeking });
}

beforeEach(() => {
  document.body.innerHTML = '';
  FakeHls.reset();
  seeks = [];
  seeking = false;
  // A 600px player with a 400px seek bar starting 100px in; 200s of video.
  player = createFakePlayer({ duration: 200 });
  progress = player.controlBar.progressControl.el();
  setRect(player.el(), { left: 0, width: 600, height: 340 });
  setRect(player.controlBar.progressControl.seekBar.el(), { left: 100, width: 400, height: 10 });
  preview = createScrubPreview(player);
  watchSeeks(vid());
});

describe('the preview element', () => {
  it('is a muted, inline video with a chapter line and a time label', () => {
    const v = vid();
    expect(v.muted).toBe(true);
    expect(v.hasAttribute('muted')).toBe(true);
    expect(v.hasAttribute('playsinline')).toBe(true);
    expect(v.preload).toBe('auto');
    expect(wrap().querySelector('.scrub-preview-chapter')).not.toBeNull();
    expect(visible()).toBe(false);
  });
});

describe('setSource', () => {
  it('loads the manifest through hls.js on the lowest rendition', () => {
    preview.setSource('https://cdn.example/badadib/manifest.m3u8');
    expect(FakeHls.instances).toHaveLength(1);
    const hls = FakeHls.instances[0];
    expect(hls.config).toMatchObject({ startLevel: 0, capLevelToPlayerSize: false, maxBufferLength: 6 });
    expect(hls.loadSource).toHaveBeenCalledWith('https://cdn.example/badadib/manifest.m3u8');
    expect(hls.attachMedia).toHaveBeenCalledWith(vid());
    hls.emit(FakeHls.Events.MANIFEST_PARSED);
    expect([hls.currentLevel, hls.nextLevel, hls.loadLevel]).toEqual([0, 0, 0]);
  });

  it('ignores an empty or unchanged source', () => {
    preview.setSource('');
    preview.setSource('https://cdn.example/a.m3u8');
    preview.setSource('https://cdn.example/a.m3u8');
    expect(FakeHls.instances).toHaveLength(1);
  });

  it('tears the old hls.js down when the source changes', () => {
    preview.setSource('https://cdn.example/a.m3u8');
    preview.setSource('https://cdn.example/b.m3u8');
    expect(FakeHls.instances[0].destroy).toHaveBeenCalled();
    expect(FakeHls.instances).toHaveLength(2);
  });

  it('survives an hls.js that throws on destroy', () => {
    preview.setSource('https://cdn.example/a.m3u8');
    FakeHls.instances[0].destroy.mockImplementation(() => { throw new Error('gone'); });
    expect(() => preview.setSource('https://cdn.example/b.m3u8')).not.toThrow();
  });

  it('uses native HLS where hls.js is not supported', () => {
    FakeHls.supported = false;
    preview.setSource('https://cdn.example/a.m3u8');
    expect(FakeHls.instances).toHaveLength(0);
    expect(vid().getAttribute('src')).toBe('https://cdn.example/a.m3u8');
  });
});

describe('hovering the progress bar', () => {
  it('seeks the preview to the time under the cursor and labels it', () => {
    pointer(progress, 'pointermove', { clientX: 300 });
    expect(seeks).toEqual([100]);
    expect(timeText()).toBe('1:40');
    expect(visible()).toBe(true);
    expect(wrap().style.left).toBe('300px');
  });

  it('clamps to the ends of the bar and keeps the thumbnail inside the player', () => {
    pointer(progress, 'pointermove', { clientX: 20 });
    expect(seeks).toEqual([0]);
    expect(timeText()).toBe('0:00');
    expect(wrap().style.left).toBe('84px');
    pointer(progress, 'pointermove', { clientX: 590 });
    expect(seeks).toEqual([0, 200]);
    expect(wrap().style.left).toBe('516px');
  });

  it('shows hours for long videos', () => {
    player.state.duration = 7450;
    pointer(progress, 'pointermove', { clientX: 300 });
    expect(timeText()).toBe('1:02:05');
  });

  it('skips moves of less than 0.2s', () => {
    pointer(progress, 'pointermove', { clientX: 300 });
    pointer(progress, 'pointermove', { clientX: 300.3 });
    expect(seeks).toEqual([100]);
  });

  it('coalesces moves made while the preview is still seeking', () => {
    pointer(progress, 'pointermove', { clientX: 200 });
    seeking = true;
    pointer(progress, 'pointermove', { clientX: 300 });
    pointer(progress, 'pointermove', { clientX: 400 });
    expect(seeks).toEqual([50]);
    seeking = false;
    vid().dispatchEvent(new Event('seeked'));
    expect(seeks).toEqual([50, 150]);
    vid().dispatchEvent(new Event('seeked'));
    expect(seeks).toEqual([50, 150]);
  });

  it('does nothing before the duration is known', () => {
    player.state.duration = NaN;
    pointer(progress, 'pointermove', { clientX: 300 });
    player.state.duration = 0;
    pointer(progress, 'pointermove', { clientX: 300 });
    expect(seeks).toEqual([]);
    expect(visible()).toBe(false);
  });

  it('survives a preview whose metadata is not ready', () => {
    Object.defineProperty(vid(), 'currentTime', { configurable: true, set() { throw new Error('not ready'); } });
    expect(() => pointer(progress, 'pointermove', { clientX: 300 })).not.toThrow();
    expect(visible()).toBe(true);
  });

  it('hides when a mouse leaves the bar', () => {
    pointer(progress, 'pointermove', { clientX: 300 });
    pointer(progress, 'pointerleave');
    expect(visible()).toBe(false);
  });
});

describe('the chapter label', () => {
  it('shows the label for the fraction under the cursor', () => {
    const label = vi.fn((frac) => (frac >= 0.5 ? 'Setup' : 'Intro'));
    preview.setLabel(label);
    pointer(progress, 'pointermove', { clientX: 300 });
    expect(label).toHaveBeenCalledWith(0.5);
    expect(chapter().textContent).toBe('Setup');
    expect(chapter().style.display).toBe('');
  });

  it('hides the line when there is no label', () => {
    preview.setLabel(() => '');
    pointer(progress, 'pointermove', { clientX: 300 });
    expect(chapter().style.display).toBe('none');
    preview.setLabel('not a function');
    pointer(progress, 'pointermove', { clientX: 400 });
    expect(chapter().textContent).toBe('');
  });
});

describe('touch dragging', () => {
  it('ignores a touch move that is not a drag', () => {
    pointer(progress, 'pointermove', { clientX: 300, pointerType: 'touch' });
    expect(visible()).toBe(false);
  });

  it('follows the finger from touch-down, even off the bar, until it lifts', () => {
    pointer(progress, 'pointerdown', { clientX: 200, pointerType: 'touch' });
    expect(seeks).toEqual([50]);
    pointer(progress, 'pointermove', { clientX: 300, pointerType: 'touch' });
    pointer(progress, 'pointerleave', { pointerType: 'touch' });
    expect(visible()).toBe(true);
    pointer(window, 'pointermove', { clientX: 400, pointerType: 'touch' });
    expect(seeks).toEqual([50, 100, 150]);
    pointer(window, 'pointerup', { pointerType: 'touch' });
    expect(visible()).toBe(false);
    pointer(window, 'pointermove', { clientX: 500, pointerType: 'touch' });
    expect(seeks).toEqual([50, 100, 150]);
  });

  it('a cancelled touch ends the drag too', () => {
    pointer(progress, 'pointerdown', { clientX: 200, pointerType: 'touch' });
    pointer(window, 'pointercancel', { pointerType: 'touch' });
    expect(visible()).toBe(false);
  });

  it('a mouse press does not start a drag', () => {
    pointer(progress, 'pointerdown', { clientX: 200 });
    pointer(window, 'pointermove', { clientX: 300 });
    expect(seeks).toEqual([]);
    pointer(window, 'pointerup');
    expect(visible()).toBe(false);
  });
});

describe('a player without a progress control', () => {
  it('still builds, but wires nothing', () => {
    const bare = createFakePlayer({ withSeekBar: false });
    const p = createScrubPreview(bare);
    expect(bare.el().querySelector('.scrub-preview')).not.toBeNull();
    expect(() => p.destroy()).not.toThrow();
    expect(bare.el().querySelector('.scrub-preview')).toBeNull();
  });
});

describe('destroy', () => {
  it('removes the preview, its hls.js and its listeners', () => {
    preview.setSource('https://cdn.example/a.m3u8');
    preview.destroy();
    expect(FakeHls.instances[0].destroy).toHaveBeenCalled();
    expect(player.el().querySelector('.scrub-preview')).toBeNull();
    pointer(progress, 'pointermove', { clientX: 300 });
    expect(seeks).toEqual([]);
  });

  it('a touch drag in progress stops driving the preview at destroy()', () => {
    const removed = wrap();
    pointer(progress, 'pointerdown', { clientX: 200, pointerType: 'touch' });
    preview.destroy();
    pointer(window, 'pointermove', { clientX: 400, pointerType: 'touch' });
    expect(seeks).toEqual([50]);
    expect(removed.querySelector('.scrub-preview-time').textContent).toBe('0:50');
  });
});
