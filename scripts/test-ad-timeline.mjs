/**
 * ⏱  The mapping that keeps ad seconds out of `view-durations`.
 *
 * With a spot stitched in, the player's currentTime runs ahead of the video by the
 * ad's length. Report that as watch position and every ad second is credited as
 * watch time on the creator's video — which would poison the retention data the ad
 * forecast is itself built from. This is that arithmetic, with no browser involved.
 *
 * Usage: node scripts/test-ad-timeline.mjs
 */
import { createAdBreak } from '../src/adBreak.js';

let fails = 0;
const near = (l, g, w) => { const ok = Math.abs(g - w) < 0.001; if (!ok) fails++; console.log(`${ok?' ok ':'FAIL'}  ${l.padEnd(50)} ${g}${ok?'':`  want ${w}`}`); };
const is = (l, g, w) => { const ok = g === w; if (!ok) fails++; console.log(`${ok?' ok ':'FAIL'}  ${l.padEnd(50)} ${g}${ok?'':`  want ${w}`}`); };

const ad = createAdBreak();
// Stand in for the network: one session, then the resolved break window.
globalThis.fetch = async (url) => {
  if (String(url).includes('/m/session')) {
    return { ok: true, json: async () => ({ ad: { manifestUrl: 'https://checker.3speak.tv/m/'+'a'.repeat(32)+'.m3u8', position: 30, durationSeconds: 15, label: 'Sponsored', advertiser: 'Test Co' } }) };
  }
  return { ok: true, json: async () => ({ adStartAt: 33.166666, adDurationSeconds: 14.7 }) };
};

console.log('── before the break window is known ──');
await ad.request({ owner: 'x', permlink: 'y', manifestUrl: 'https://cdn/x.m3u8' });
is('a spot was offered', ad.active, true);
near('mapping is the identity until resolved', ad.contentTime(50), 50);
is('  and the label stays hidden', ad.isInside(50), false);

console.log('\n── once the real cut point is known (33.17s + 14.7s) ──');
await ad.resolve();
is('resolved', ad.resolved, true);
near('before the break, content time is player time', ad.contentTime(10), 10);
near('at the cut', ad.contentTime(33.166666), 33.166666);
near('INSIDE the break, content does not advance', ad.contentTime(40), 33.166666);
near('still pinned at the far edge', ad.contentTime(47.8), 33.166666);
near('after the break, the ad is subtracted', ad.contentTime(50), 35.3);
near('much later', ad.contentTime(100), 85.3);

console.log('\n── the label ──');
is('hidden before', ad.isInside(20), false);
is('shown inside', ad.isInside(40), true);
is('hidden after', ad.isInside(48.1), false);

console.log('\n── what this protects ──');
// A viewer who watches the whole 110s video sees 124.7s of player timeline.
const playerEnd = 110 + 14.7;
near('a full watch reports 110s, not 124.7s', ad.contentTime(playerEnd), 110);
console.log('      without the mapping the creator would be credited '
  + (playerEnd - ad.contentTime(playerEnd)).toFixed(1) + 's of watch time that was ad');

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
