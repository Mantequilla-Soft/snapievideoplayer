import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHeatmap } from '../../../src/heatmapBar.js';
import { createFakePlayer } from './_helpers/fakePlayer.js';
import { stubFetch, jsonResponse } from './_helpers/fetchStub.js';

let player;
let seekBar;
const wrap = () => seekBar.querySelector('.vjs-replay-heatmap');
const path = () => wrap().querySelector('path.hm-fill');
const visible = () => wrap().classList.contains('visible');
const GOOD = { tracked: true, sessions: 5, normalized: [0, 1, 0] };

beforeEach(() => {
  document.body.innerHTML = '';
  player = createFakePlayer();
  seekBar = player.controlBar.progressControl.seekBar.el();
});

describe('createHeatmap', () => {
  it('is a no-op without a seek bar', async () => {
    const net = stubFetch();
    const hm = createHeatmap(createFakePlayer({ withSeekBar: false }));
    await hm.setVideo('badadib', 'p');
    hm.destroy();
    expect(net.calls).toHaveLength(0);
  });

  it('adds a hidden SVG layer inside the seek bar', () => {
    createHeatmap(player);
    expect(wrap()).not.toBeNull();
    expect(visible()).toBe(false);
    const svg = wrap().querySelector('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
  });

  it('makes a static seek bar a positioning context, and leaves others alone', () => {
    seekBar.style.position = 'static';
    createHeatmap(player);
    expect(seekBar.style.position).toBe('relative');
    const other = createFakePlayer();
    const bar = other.controlBar.progressControl.seekBar.el();
    bar.style.position = 'absolute';
    createHeatmap(other);
    expect(bar.style.position).toBe('absolute');
  });

  it('destroy() removes the layer', () => {
    const hm = createHeatmap(player);
    hm.destroy();
    expect(wrap()).toBeNull();
  });
});

describe('setVideo', () => {
  it('does not ask without an owner and permlink', async () => {
    const net = stubFetch();
    const hm = createHeatmap(player);
    await hm.setVideo('badadib', '');
    await hm.setVideo('', 'p');
    expect(net.calls).toHaveLength(0);
  });

  it('asks /api/heatmap for the video, embed type by default', async () => {
    const net = stubFetch(() => GOOD);
    const hm = createHeatmap(player);
    await hm.setVideo('badadib', 'a/b c', 'whatever');
    await hm.setVideo('badadib', 'old-one', 'legacy');
    expect(net.calls.map((c) => c.url)).toEqual([
      '/api/heatmap?v=badadib/a%2Fb%20c&type=embed',
      '/api/heatmap?v=badadib/old-one&type=legacy',
    ]);
  });

  it('draws a smoothed area under the curve and shows it', async () => {
    stubFetch(() => GOOD);
    const hm = createHeatmap(player);
    await hm.setVideo('badadib', 'p');
    expect(visible()).toBe(true);
    // [0,1,0] smooths to [0.25,0.5,0.25].
    expect(path().getAttribute('d'))
      .toBe('M0,100 L0.00,75.00 0.00,75.00 L50.00,50.00 L100.00,75.00 L100,100 Z');
  });

  it('clamps values outside 0..1 and does not smooth two points', async () => {
    stubFetch(() => ({ tracked: true, sessions: 2, normalized: [2, -1] }));
    const hm = createHeatmap(player);
    await hm.setVideo('badadib', 'p');
    expect(path().getAttribute('d')).toBe('M0,100 L0.00,0.00 0.00,0.00 L100.00,100.00 L100,100 Z');
  });

  it.each([
    ['untracked', { tracked: false, sessions: 9, normalized: [0, 1] }],
    ['one viewer', { tracked: true, sessions: 1, normalized: [0, 1] }],
    ['no session count', { tracked: true, normalized: [0, 1] }],
    ['no buckets', { tracked: true, sessions: 3 }],
    ['all zero', { tracked: true, sessions: 3, normalized: [0, 0, 0] }],
    ['a single bucket', { tracked: true, sessions: 3, normalized: [1] }],
  ])('stays hidden for %s', async (_name, data) => {
    stubFetch(() => data);
    const hm = createHeatmap(player);
    await hm.setVideo('badadib', 'p');
    expect(visible()).toBe(false);
  });

  it('stays hidden when the answer is not JSON or the request fails', async () => {
    const hm = createHeatmap(player);
    stubFetch(() => new Response('<html>'));
    await hm.setVideo('badadib', 'p');
    expect(visible()).toBe(false);
    stubFetch(() => new Error('offline'));
    await hm.setVideo('badadib', 'p');
    expect(visible()).toBe(false);
  });

  it('hides the previous curve as soon as the video changes', async () => {
    stubFetch(() => GOOD);
    const hm = createHeatmap(player);
    await hm.setVideo('badadib', 'p');
    stubFetch(() => new Promise(() => {}));
    hm.setVideo('badadib', 'next');
    expect(visible()).toBe(false);
  });

  it('ignores a slow answer for a video that is no longer loaded', async () => {
    const releases = [];
    stubFetch((url) => new Promise((r) => releases.push(() => r(jsonResponse(
      url.includes('first') ? GOOD : { tracked: true, sessions: 5, normalized: [1, 1, 1] },
    )))));
    const hm = createHeatmap(player);
    const first = hm.setVideo('badadib', 'first');
    const second = hm.setVideo('badadib', 'second');
    releases[1]();
    await second;
    const drawn = path().getAttribute('d');
    releases[0]();
    await first;
    expect(path().getAttribute('d')).toBe(drawn);
    expect(drawn).toContain('L50.00,0.00');
  });

  it('ignores a stale answer whose body arrives after the next video started', async () => {
    let releaseBody;
    const body = new Promise((r) => { releaseBody = r; });
    // The first answer's headers arrive at once, its body is held open.
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: () => body })
      .mockReturnValue(new Promise(() => {})));
    const hm = createHeatmap(player);
    const first = hm.setVideo('badadib', 'first');
    await Promise.resolve();
    hm.setVideo('badadib', 'second');
    releaseBody(GOOD);
    await first;
    expect(visible()).toBe(false);
  });
});
