import './_helpers/mocks.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, cleanup, posted } from './_helpers/boot.js';

afterEach(() => cleanup());

const shape = (player, w, h) => { player.s.videoWidth = w; player.s.videoHeight = h; };

describe('aspect ratio and picture shape', () => {
  it('a fluid page follows the picture and the parent is told its shape', async () => {
    const { player, parent } = await boot({ url: '/watch?v=badadib/xyz' });
    shape(player, 1920, 1080);
    player.trigger('loadedmetadata');
    expect(player.aspectRatio).toHaveBeenCalledWith('1920:1080');
    expect(player.removeClass).toHaveBeenCalledWith('vertical-video');
    expect(posted(parent, '3speak-player-ready')).toEqual([{
      type: '3speak-player-ready', isVertical: false, width: 1920, height: 1080,
      aspectRatio: 1920 / 1080, orientation: 'horizontal', ad: false,
    }]);
  });

  it('a vertical video gets the class and a vertical message', async () => {
    const { player, parent } = await boot({ url: '/watch?v=badadib/xyz' });
    shape(player, 720, 1280);
    player.trigger('loadedmetadata');
    expect(player.el().classList.contains('vertical-video')).toBe(true);
    expect(posted(parent, '3speak-player-ready')[0]).toMatchObject({ isVertical: true, orientation: 'vertical' });
  });

  it('a square video is square', async () => {
    const { player, parent } = await boot();
    shape(player, 800, 800);
    player.trigger('loadedmetadata');
    expect(posted(parent, '3speak-player-ready')[0]).toMatchObject({ isVertical: false, orientation: 'square', aspectRatio: 1 });
  });

  it('a fixed layout leaves the aspect ratio to CSS', async () => {
    const { player, parent } = await boot({ url: '/embed?v=badadib/xyz&mode=iframe' });
    shape(player, 1280, 720);
    player.trigger('loadedmetadata');
    expect(player.aspectRatio).not.toHaveBeenCalled();
    expect(posted(parent, '3speak-player-ready')).toHaveLength(1);
  });

  it('zero dimensions wait for loadeddata and try again', async () => {
    const { player, parent } = await boot();
    player.trigger('loadedmetadata');
    expect(posted(parent, '3speak-player-ready')).toHaveLength(0);
    shape(player, 1280, 720);
    player.trigger('loadeddata');
    expect(posted(parent, '3speak-player-ready')).toHaveLength(1);
    // One-shot.
    player.trigger('loadeddata');
    expect(posted(parent, '3speak-player-ready')).toHaveLength(1);
  });

  it('missing dimensions are ignored', async () => {
    const { player, parent } = await boot();
    shape(player, undefined, undefined);
    player.trigger('loadedmetadata');
    expect(posted(parent, '3speak-player-ready')).toHaveLength(0);
  });

  it('a resize posts only when the shape changes', async () => {
    const { player, parent } = await boot();
    shape(player, 1280, 720);
    player.trigger('loadedmetadata');
    shape(player, 1920, 1080);
    player.trigger('resize');
    expect(posted(parent, '3speak-player-ready')).toHaveLength(1);
    shape(player, 1080, 1920);
    player.trigger('resize');
    expect(posted(parent, '3speak-player-ready')).toHaveLength(2);
    expect(posted(parent, '3speak-player-ready')[1].orientation).toBe('vertical');
  });

  it('a landscape spot inside a portrait video keeps the video orientation but reports ad: true', async () => {
    const { player, parent, ab } = await boot({ url: '/watch?v=badadib/xyz' });
    shape(player, 720, 1280);
    player.trigger('loadedmetadata');
    ab.resolved = true;
    ab.isInside.mockImplementation((t) => t >= 10 && t < 25);
    player.s.currentTime = 9.7; // the cut is half a second away
    shape(player, 1920, 1080);
    player.trigger('resize');
    expect(player.el().classList.contains('vertical-video')).toBe(true);
    expect(player.aspectRatio).toHaveBeenLastCalledWith('1920:1080');
    const msgs = posted(parent, '3speak-player-ready');
    expect(msgs[1]).toMatchObject({ orientation: 'horizontal', ad: true });
    // The video comes back after the spot.
    player.s.currentTime = 30;
    shape(player, 720, 1280);
    player.trigger('resize');
    expect(posted(parent, '3speak-player-ready')[2]).toMatchObject({ orientation: 'vertical', ad: false });
  });

  it('outside an iframe nothing is posted', async () => {
    const spy = vi.spyOn(window, 'postMessage');
    const { player } = await boot({ iframe: false });
    shape(player, 1280, 720);
    player.trigger('loadedmetadata');
    expect(spy).not.toHaveBeenCalled();
    expect(player.removeClass).toHaveBeenCalledWith('vertical-video');
  });
});
