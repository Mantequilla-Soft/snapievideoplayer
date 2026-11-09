import './_helpers/mocks.js';
import { describe, it, expect, afterEach } from 'vitest';
import { boot, cleanup, flush, calls, videoFixture, hub } from './_helpers/boot.js';

afterEach(() => cleanup());

const TIMELINE = { chapters: [{ start: 0, title: 'Intro' }, { start: 60, title: 'Main' }] };

describe('creator timeline', () => {
  it('hands the sanitised timeline from the API to the timeline UI', async () => {
    const { fetch } = await boot({ video: videoFixture({ timeline: { ...TIMELINE, junk: 1, links: [{ at: 'x' }] } }) });
    expect(hub.timeline.setTimeline).toHaveBeenCalledWith({
      chapters: [{ start: 0, title: 'Intro' }, { start: 60, title: 'Main' }], links: [],
    });
    expect(calls(fetch, '/api/timeline')).toHaveLength(0);
  });

  it('a video without a timeline clears it', async () => {
    await boot();
    expect(hub.timeline.setTimeline).toHaveBeenCalledWith(null);
  });

  it('collects a pending timeline in the background', async () => {
    const { fetch } = await boot({
      video: videoFixture({ timelinePending: true, timelinePost: 'badadib/xyz' }),
      routes: { '/api/timeline': { body: { timeline: TIMELINE } } },
    });
    expect(calls(fetch, '/api/timeline')[0][0]).toBe('/api/timeline?post=badadib%2Fxyz');
    expect(hub.timeline.setTimeline).toHaveBeenLastCalledWith(expect.objectContaining({ chapters: TIMELINE.chapters }));
  });

  it('does not ask for an invalid post reference', async () => {
    const { fetch } = await boot({ video: videoFixture({ timelinePending: true, timelinePost: '../etc/passwd' }) });
    expect(calls(fetch, '/api/timeline')).toHaveLength(0);
  });

  it('a late answer for an older video is dropped', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { mod } = await boot({
      video: videoFixture({ timelinePending: true, timelinePost: 'badadib/xyz' }),
      routes: { '/api/timeline': async () => { await gate; return { body: { timeline: TIMELINE } }; } },
    });
    await mod.loadVideoFromData(videoFixture({ permlink: 'second' }));
    hub.timeline.setTimeline.mockClear();
    release();
    await flush();
    expect(hub.timeline.setTimeline).not.toHaveBeenCalled();
  });

  it('an empty, failed or refused answer changes nothing', async () => {
    for (const spec of [{ body: { timeline: null } }, new Error('offline'), { status: 500, body: {} }]) {
      await boot({
        video: videoFixture({ timelinePending: true, timelinePost: 'badadib/xyz' }),
        routes: { '/api/timeline': spec },
      });
      expect(hub.timeline.setTimeline).toHaveBeenCalledTimes(1);
    }
  });

  it('timeupdate drives the timeline with the player time', async () => {
    const { player } = await boot();
    player.tick(12);
    expect(hub.timeline.update).toHaveBeenCalledWith(12);
  });

  it('without a timeline UI nothing breaks', async () => {
    const { player } = await boot({ setup: (h) => { h.timelineThrows = true; } });
    expect(() => player.tick(3)).not.toThrow();
  });
});

describe('timeline hooks', () => {
  it('contentTime and contentDuration go through the ad mapping', async () => {
    const { player, ab } = await boot();
    const hooks = hub.timelineHooks;
    ab.contentTime.mockImplementation((t) => t - 15);
    expect(hooks.contentTime(40)).toBe(25);
    player.s.duration = NaN;
    expect(hooks.contentDuration()).toBeNull();
    player.s.duration = 0;
    expect(hooks.contentDuration()).toBeNull();
    player.s.duration = 135;
    expect(hooks.contentDuration()).toBe(135);
    ab.resolved = true;
    ab.contentDuration.mockImplementation((d) => d - 15);
    expect(hooks.contentDuration()).toBe(120);
  });

  it('adHold is on while a spot is unresolved, playing or counting down', async () => {
    const { ab } = await boot();
    const { adHold } = hub.timelineHooks;
    expect(adHold(5)).toBe(false);
    ab.active = true;
    expect(adHold(5)).toBe(true);
    ab.resolved = true;
    expect(adHold(5)).toBe(false);
    ab.isInside.mockReturnValueOnce(true);
    expect(adHold(5)).toBe(true);
    ab.countdownAt.mockReturnValueOnce(2);
    expect(adHold(5)).toBe(true);
  });
});

describe('seek bar and clocks in content time', () => {
  const make = (name, player) => new hub.components[name](player);

  it('SeekBar.getCurrentTime_ maps the file clock only once resolved', async () => {
    const { player, ab } = await boot();
    const sb = make('SeekBar', player);
    player.s.currentTime = 50;
    expect(sb.getCurrentTime_()).toBe(50);
    ab.resolved = true;
    ab.contentTime.mockImplementation((t) => t - 15);
    expect(sb.getCurrentTime_()).toBe(35);
  });

  it('SeekBar.getPercent is drawn against the content length', async () => {
    const { player, ab } = await boot();
    const sb = make('SeekBar', player);
    player.s.duration = 115;
    player.s.currentTime = 65;
    expect(sb.getPercent()).toBe('orig-percent');
    ab.resolved = true;
    ab.contentTime.mockImplementation((t) => t - 15);
    ab.contentDuration.mockImplementation((d) => d - 15);
    expect(sb.getPercent()).toBe(0.5);
    player.s.currentTime = 500;
    expect(sb.getPercent()).toBe(1);
    player.s.currentTime = NaN;
    expect(sb.getPercent()).toBe(0);
    // A live stream and a scrub in progress keep the original maths.
    player.liveTracker = { isLive: () => true };
    expect(sb.getPercent()).toBe('orig-percent');
    player.liveTracker = null;
    sb.pending = 0.3;
    expect(sb.getPercent()).toBe('orig-percent');
    sb.pending = null;
    // No usable content length.
    ab.contentDuration.mockImplementation(() => 0);
    expect(sb.getPercent()).toBe('orig-percent');
  });

  it('SeekBar.userSeek_ turns a drag along the video into a file position', async () => {
    const { player, ab } = await boot();
    const sb = make('SeekBar', player);
    player.s.duration = 130;
    sb.userSeek_(65);
    expect(sb.seekedTo).toBe(65);
    ab.resolved = true;
    ab.contentDuration.mockImplementation(() => 100);
    ab.playerTimeFor.mockImplementation((c) => c + 30);
    sb.userSeek_(65); // half way along
    expect(ab.playerTimeFor).toHaveBeenCalledWith(50);
    expect(sb.seekedTo).toBe(80);
    player.s.duration = NaN;
    sb.userSeek_(10);
    expect(sb.seekedTo).toBe(10);
  });

  it('the current-time clock shows content time, the end, or the scrub position', async () => {
    const { player, ab } = await boot();
    const d = make('CurrentTimeDisplay', player);
    expect(d.updateContent()).toBe('orig');
    ab.resolved = true;
    ab.contentTime.mockImplementation((t) => t - 15);
    player.s.currentTime = 40;
    expect(d.updateContent()).toBe(25);
    player.s.scrubbing = true;
    player.s.cacheTime = 20;
    expect(d.updateContent()).toBe(5);
    player.s.ended = true;
    player.s.duration = 115;
    expect(d.updateContent()).toBe(100);
  });

  it('the duration clock shows the content length', async () => {
    const { player, ab } = await boot();
    const d = make('DurationDisplay', player);
    expect(d.updateContent()).toBe('orig');
    ab.resolved = true;
    ab.contentDuration.mockImplementation((x) => x - 15);
    player.s.duration = 115;
    expect(d.updateContent()).toBe(100);
  });

  it('the remaining clock is the content length minus the content position', async () => {
    const { player, ab } = await boot();
    const d = make('RemainingTimeDisplay', player);
    expect(d.updateContent()).toBe('orig');
    ab.resolved = true;
    ab.contentDuration.mockImplementation(() => 100);
    player.s.currentTime = 40;
    expect(d.updateContent()).toBe(60);
    player.s.currentTime = 400;
    expect(d.updateContent()).toBe(0);
    player.s.ended = true;
    player.s.currentTime = 10;
    expect(d.updateContent()).toBe(0);
    ab.contentDuration.mockImplementation(() => 0);
    expect(d.updateContent()).toBe('orig');
  });
});

describe('captions follow content time', () => {
  it('cues are timed against the creator video and hidden over a spot', async () => {
    const { player, ab } = await boot();
    hub.subtitle.cues = [{ start: 0, end: 5, text: 'hi' }];
    player.tick(20);
    expect(hub.caption.update).toHaveBeenLastCalledWith(20);
    ab.active = true;
    ab.contentTime.mockImplementation((t) => t - 15);
    player.tick(30);
    expect(hub.caption.update).toHaveBeenLastCalledWith(15);
    ab.isInside.mockReturnValue(true);
    player.tick(31);
    expect(hub.caption.update).toHaveBeenLastCalledWith(-1);
  });

  it('no cues, no overlay updates', async () => {
    const { player } = await boot();
    player.tick(3);
    expect(hub.caption.update).not.toHaveBeenCalled();
  });
});
