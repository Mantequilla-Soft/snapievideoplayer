/**
 * ⏱  Delivery is measured in seconds WATCHED, not segments fetched.
 *
 * A player downloads ahead of what it shows: the closing segment of a five-segment 29s
 * spot is requested around eleven seconds in and not put on screen until 24.6s. Billing
 * off segment fetches therefore counted spots that were only buffered and missed spots
 * that were genuinely watched but left early — and with the old threshold of half the
 * booking it counted nothing at all, which is how a live shorts campaign sat at
 * `scheduled` with 0 delivered while it was visibly serving.
 *
 * adBreak now measures the PLAYER's own clock inside the break. Player time advances
 * only while the media plays, so a pause costs nothing to notice and a spot that was
 * never reached accumulates nothing.
 *
 * 🚨 STUBBED fetch: no checker, no real session, no impression booked against a real
 * campaign. Nothing here touches the money path.
 *
 * Usage: node scripts/test-ad-watch-beat.mjs
 */
const SID = 'b'.repeat(32);
const beats = [];

function stub(start, duration) {
  beats.length = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/m/session')) {
      return { ok: true, json: async () => ({
        ad: { manifestUrl: `/m/${SID}.m3u8`, position: start, durationSeconds: duration },
      }) };
    }
    if (u.endsWith(`/m/${SID}/w`)) {
      beats.push(JSON.parse(opts.body).seconds);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ adStartAt: start, adDurationSeconds: duration }) };
  };
}

global.window = { __AD_BASE__: 'http://127.0.0.1:3131', location: { href: 'http://x/' } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { createAdBreak, AD_BILLABLE_SECONDS } = await import('../src/adBreak.js');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log((good ? '    ok   ' : '    FAIL ') + name + (good ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  good ? pass++ : fail++;
};
const near = (name, got, want, tol = 0.06) => {
  const good = Math.abs(got - want) <= tol;
  console.log((good ? '    ok   ' : '    FAIL ') + name + (good ? '' : `  got ${got} want ~${want}`));
  good ? pass++ : fail++;
};

async function spot(start, duration) {
  stub(start, duration);
  const ab = createAdBreak();
  await ab.request({ owner: 'badadib', permlink: 'p', manifestUrl: 'http://m/x.m3u8' });
  await ab.resolve();
  return ab;
}

/** Walk the playhead like a real timeupdate would: ~4 ticks a second. */
const play = (ab, from, to, step = 0.25) => {
  for (let t = from; t <= to + 1e-9; t += step) ab.noteTime(Math.round(t * 1000) / 1000);
};

console.log(`\n  billing threshold: ${AD_BILLABLE_SECONDS}s of ad on screen\n`);

// ── a 29s spot at 60..89 ────────────────────────────────────────────────────────
console.log('  a 29s spot at 60..89');
let ab = await spot(60, 29);
play(ab, 57, 59.75);
near('content before the cut counts nothing', ab.watchedSeconds, 0);
ok('and bills nothing', beats.length, 0);

play(ab, 60, 62);
near('two seconds in: measured', ab.watchedSeconds, 2);
ok('but not yet billed', beats.length, 0);

play(ab, 62.25, 64);
near('past three seconds: measured', ab.watchedSeconds, 4);
ok('billed exactly once', beats.length, 1);
near('and the beat carried the threshold figure', beats[0], 3, 0.3);

play(ab, 64.25, 89);
near('watched to the end', ab.watchedSeconds, 29, 0.3);

play(ab, 89.25, 92);
ok('leaving the break sends the closing beat', beats.length, 2);
near('carrying the full figure, not the billing one', beats[1], 29, 0.3);

// ── left early ──────────────────────────────────────────────────────────────────
console.log('\n  a viewer who leaves after 5 seconds');
ab = await spot(60, 29);
play(ab, 60, 65);
near('five seconds measured', ab.watchedSeconds, 5);
ok('billed', beats.length, 1);
/* 🚨 The case the old rule could not express. Five seconds of a 29s spot never causes
 * the closing segment to be fetched, so under segment-fetch billing this viewer paid
 * the creator nothing at all despite genuinely watching the ad. */
ok('and it billed WITHOUT the closing segment ever being fetched', beats.length > 0, true);

// ── a pause costs nothing to notice ─────────────────────────────────────────────
console.log('\n  pausing inside the spot');
ab = await spot(60, 29);
play(ab, 60, 62);
for (let i = 0; i < 40; i++) ab.noteTime(62);      // paused: the clock does not move
near('a paused ad accrues nothing', ab.watchedSeconds, 2);
ok('and does not bill', beats.length, 0);

// ── seeks and rewinds are not watch time ────────────────────────────────────────
console.log('\n  jumps are not watch time');
ab = await spot(60, 29);
ab.noteTime(60);
ab.noteTime(88);                                    // a seek across the whole spot
near('a jump across the spot credits nothing', ab.watchedSeconds, 0);
ab.noteTime(88.25);
near('only the honest step after it', ab.watchedSeconds, 0.25);
ab.noteTime(62);                                    // a rewind
near('a rewind credits nothing', ab.watchedSeconds, 0.25);

// ── nothing booked ──────────────────────────────────────────────────────────────
console.log('\n  a playback with no spot');
const none = createAdBreak();
none.noteTime(10); none.noteTime(11);
near('measures nothing', none.watchedSeconds, 0);

console.log('\n  %d passed, %d failed\n', pass, fail);
process.exit(fail ? 1 : 0);
