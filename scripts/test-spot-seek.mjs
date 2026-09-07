/**
 * ⏭  A spot that has run is a hole in the timeline.
 *
 * The ad is stitched into the manifest, so its seconds are real positions somebody can
 * drag the handle onto, and scrubbing back over your own video played the ad again.
 * The playhead now refuses to rest on a spent spot and jumps to whichever side the
 * viewer was travelling towards. This checks that rule, and it checks it against REAL
 * sessions rather than a fabricated window, because the window only exists once the
 * stitcher has answered for a variant playlist.
 *
 * It keeps ONE viewer for the whole run so the frequency cap rotates the served
 * campaign, which is what gets both a pre-roll and a mid-roll in front of the rules:
 * the two branches differ, and a pre-roll has no content in front of it to land on.
 *
 * Needs the checker reachable. Usage: node scripts/test-spot-seek.mjs
 */
global.window = { __AD_BASE__: 'http://127.0.0.1:3131' };
global.localStorage = { getItem: () => null, setItem: () => {} };
const { createAdBreak } = await import('../src/adBreak.js');
// One viewer for the whole run, so the frequency cap rotates the served campaign
// and a mid-roll comes up as well as a pre-roll.
const VIEWER = 'seekfixed' + Math.floor(Math.random() * 1e9);
const MANIFEST = 'https://ipfs-3speak.b-cdn.net/ipfs/QmSyhECGPiLBSAEVuJN1KWNpeX54o1JhdFhtWwoMnfjtW6/manifest.m3u8';

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = want === null ? got === null : (typeof got === 'number' && Math.abs(got - want) < 0.5);
  console.log((good ? '    ok   ' : '    FAIL ') + name + (good ? '' : `  got ${got} want ${want}`));
  good ? pass++ : fail++;
};

async function session() {
  const ab = createAdBreak();
  const res = await ab.request({
    owner: 'badadib', permlink: 'usroso2q',
    viewer: VIEWER, manifestUrl: MANIFEST, bannerOverlay: true,
  });
  if (!res) return null;
  const master = typeof res === 'string' ? res : res.manifestUrl;
  const variant = (await (await fetch(master)).text()).split('\n').find((l) => l.startsWith('http'));
  await fetch(variant);
  for (let i = 0; i < 10; i++) { await ab.resolve(); if (ab.spansSpot(0) || ab.spansSpot(1)) break;
    let any = false; for (let t = 0; t < 900; t += 0.5) if (ab.spansSpot(t)) { any = true; break; }
    if (any) break; await new Promise((r) => setTimeout(r, 300)); }
  let start = null;
  for (let t = 0; t < 900 && start == null; t += 0.05) if (ab.spansSpot(t)) start = t;
  if (start == null) return null;
  let end = start; while (ab.spansSpot(end)) end += 0.05;
  return { ab, start, end };
}

const seen = new Set();
for (let attempt = 0; attempt < 14 && seen.size < 2; attempt++) {
  const s = await session();
  if (!s) continue;
  const { ab, start, end } = s;
  const kind = start < 0.5 ? 'pre-roll' : 'mid-roll';
  if (seen.has(kind)) continue;
  seen.add(kind);
  const mid = (start + end) / 2;
  console.log(`\n  ${kind}: ${start.toFixed(2)}s -> ${end.toFixed(2)}s`);

  ok('an unwatched spot is never skipped', ab.skipTargetFor(mid, 0), null);
  ab.noteTime(mid); ab.noteTime(end + 1);
  ok('watching it through spends it', ab.spotConsumed ? 1 : 0, 1);
  ok('scrub forward into it -> lands after', ab.skipTargetFor(mid, 0), end);
  ok('playing into it -> lands after', ab.skipTargetFor(start + 0.1, start - 0.2), end);
  ok('well past it -> untouched', ab.skipTargetFor(end + 5, 0), null);
  if (kind === 'mid-roll') {
    ok('scrub back into it -> lands before the ad', ab.skipTargetFor(mid, end + 20), start - 0.05);
    ok('content before it -> untouched', ab.skipTargetFor(start - 0.5, 0), null);
  } else {
    ok('scrub back into a pre-roll -> after it, in ONE seek', ab.skipTargetFor(mid, end + 20), end);
  }
}

const skipped = createAdBreak();
console.log('\n  a break never entered: spotConsumed =', skipped.spotConsumed, '(must be false)');
console.log('\n  covered: %s', [...seen].join(' + ') || 'nothing');
console.log('  %d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
