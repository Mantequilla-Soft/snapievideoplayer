/**
 * 🔒 The countdown locks the timeline.
 *
 * "Ad in 3" used to be a warning with no teeth: it named the exact second to drag the
 * handle past, and the scrubber was still live to do it with, so the hint meant to
 * make a break bearable was the thing that taught viewers to skip it. From the moment
 * the hint appears until the spot has been sat through, the playhead refuses to move
 * forward past the cut — by bar, by key, or by anything else that ends up setting
 * currentTime.
 *
 * 🚨 STUBBED fetch, unlike test-spot-seek.mjs which drives the real checker. This one
 * asks only about arithmetic over a known window, and a real session would book a real
 * impression against a real campaign to learn nothing extra. Nothing here touches the
 * money path, so nothing here needs parking.
 *
 * Usage: node scripts/test-ad-seek-lock.mjs   (no checker needed)
 */
const SID = 'a'.repeat(32);

/** A spot of `duration` seconds beginning at player-time `start`. */
function stubServer(start, duration) {
  global.fetch = async (url) => {
    if (String(url).endsWith('/m/session')) {
      return { ok: true, json: async () => ({
        ad: { manifestUrl: `/m/${SID}.m3u8`, position: start, durationSeconds: duration },
      }) };
    }
    return { ok: true, json: async () => ({ adStartAt: start, adDurationSeconds: duration }) };
  };
}

global.window = { __AD_BASE__: 'http://127.0.0.1:3131', location: { href: 'http://x/' } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { createAdBreak, AD_COUNTDOWN_FROM } = await import('../src/adBreak.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log((good ? '    ok   ' : '    FAIL ') + name + (good ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  good ? pass++ : fail++;
};

async function spotAt(start, duration) {
  stubServer(start, duration);
  const ab = createAdBreak();
  await ab.request({ owner: 'badadib', permlink: 'p', manifestUrl: 'http://m/x.m3u8' });
  await ab.resolve();
  return ab;
}

console.log(`\n  countdown window: ${AD_COUNTDOWN_FROM}s\n`);

// ── a mid-roll at 60..70 ────────────────────────────────────────────────────────
const ab = await spotAt(60, 10);
console.log('  a mid-roll at 60..70');
ok('far from the cut: no hint', ab.countdownAt(20), null);
ok('far from the cut: no lock', ab.seekLocked(20), false);
/* 🚨 The hole this does NOT close. A viewer who drags from 20s to 90s never sees the
 * countdown, so nothing is armed and the ad is skipped. Locking that too would mean
 * yanking anyone who scrubs a long way into an ad they were never warned about, which
 * is a product decision rather than a bug fix. Asserted so the day it changes, this
 * line is what says the change was deliberate. */
ok('a long drag past an unwarned break is still allowed', ab.lockedSeekTarget(90, 20), null);

ok('the hint appears at 57.2s', ab.countdownAt(57.2), 3);
ok('and the lock is on with it', ab.seekLocked(57.2), true);
ok('dragging past the ad: refused, playhead stays', ab.lockedSeekTarget(95, 57.2), 57.2);
ok('dragging to the far edge of it: refused too', ab.lockedSeekTarget(70.4, 58), 58);
ok('rewinding out of the countdown: allowed', ab.lockedSeekTarget(10, 58), null);

ab.noteTime(62);
ok('inside the spot: still locked', ab.seekLocked(62), true);
ok('no fast-forward within the ad', ab.lockedSeekTarget(68, 62), 62);
ok('no jumping out of the ad', ab.lockedSeekTarget(120, 62), 62);

ab.noteTime(70.5);
ok('watched through: spot is spent', ab.spotConsumed, true);
ok('spent: lock off', ab.seekLocked(71), false);
ok('spent: seeking free again', ab.lockedSeekTarget(200, 71), null);
ok('spent: no hint counts down to it', ab.countdownAt(57.2), null);

// ── a pre-roll, which never shows a hint ────────────────────────────────────────
console.log('\n  a pre-roll at 0..8');
const pre = await spotAt(0, 8);
ok('no hint at t=0', pre.countdownAt(0), null);
/* The latch earning its keep: locking on position alone would be true at t=0 here and
 * would refuse the ?t= deep-link seek that fires 200ms after ready, so a link into the
 * middle of a video silently landed at the start of it. A pre-roll is already covered
 * by the control bar going down for the length of the roll. */
ok('lock stays off, so a ?t= deep link still works', pre.seekLocked(0), false);
ok('the deep-link seek is let through', pre.lockedSeekTarget(120, 0), null);

// ── the caller's half of the contract ───────────────────────────────────────────
console.log('\n  what this module CANNOT tell you');
const near = await spotAt(60, 10);
near.countdownAt(57.5);                      // arm the lock
/* 🚨 A frame of ordinary playback and a one-frame seek are the same two numbers, so
 * lockedSeekTarget answers "refused" to both. It has to: it cannot see the difference.
 * That makes it the CALLER's job to ask only about seeks — and the first cut of this
 * fix did not, because the preview-3speak guard and the player's tick handler both run
 * on timeupdate. The playhead was pinned a frame short of the cut and the spot could
 * never start: an ad that is impossible to skip AND impossible to play.
 *
 * Both callers now pass a flag saying whether the playhead was moved or simply
 * arrived. This asserts the sharp edge that makes the flag necessary. */
ok('a frame of playback is indistinguishable from a seek here', near.lockedSeekTarget(60.02, 59.98), 59.98);

// ── no spot at all ──────────────────────────────────────────────────────────────
console.log('\n  a playback with no spot');
const none = createAdBreak();
ok('nothing locks', none.seekLocked(10), false);
ok('nothing is refused', none.lockedSeekTarget(200, 10), null);
ok('no hint', none.countdownAt(10), null);

console.log('\n  %d passed, %d failed\n', pass, fail);
process.exit(fail ? 1 : 0);
