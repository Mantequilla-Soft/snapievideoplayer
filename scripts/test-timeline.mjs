/**
 * 🧭 The creator timeline sanitiser (../timeline.js): chapters + link toasters.
 *
 * The data is user-written JSON from the chain, so the test is mostly about what it
 * REFUSES: anything invalid is dropped, never repaired into something else, and no
 * href it hands the player can be anything but http(s).
 *
 * Usage: node scripts/test-timeline.mjs
 */
import tl from '../timeline.js';

const { sanitizeTimeline, linkHref, activeLinks, chapterAt } = tl;

let fails = 0;
const is = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) fails++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${l.padEnd(56)} ${JSON.stringify(g)}${ok ? '' : `  want ${JSON.stringify(w)}`}`);
};

console.log('── the documented example passes through ──');
const good = sanitizeTimeline({
  timeline_v: 1,
  chapters: [{ start: 0, title: 'Intro' }, { start: 95, title: 'Setup' }],
  links: [
    { at: 42, dur: 8, kind: 'video', author: 'alice', permlink: 'my-vid', title: 'My vid' },
    { at: 120, dur: 8, kind: 'profile', account: 'bob' },
    { at: 300, dur: 8, kind: 'url', url: 'https://example.com/x', title: 'Example', site: 'example.com' },
  ],
});
is('chapters', good.chapters, [{ start: 0, title: 'Intro' }, { start: 95, title: 'Setup' }]);
is('video link', good.links[0], { at: 42, dur: 8, kind: 'video', author: 'alice', permlink: 'my-vid', title: 'My vid' });
is('profile link', good.links[1], { at: 120, dur: 8, kind: 'profile', account: 'bob' });
is('url link', good.links[2], { at: 300, dur: 8, kind: 'url', url: 'https://example.com/x', site: 'example.com', title: 'Example' });
is('href: video', linkHref(good.links[0]), 'https://3speak.tv/watch?v=alice/my-vid');
is('href: profile', linkHref(good.links[1]), 'https://3speak.tv/p/bob');
is('href: url', linkHref(good.links[2]), 'https://example.com/x');

console.log('── nothing there ──');
is('undefined', sanitizeTimeline(undefined), null);
is('a string', sanitizeTimeline('{"links":[]}'), null);
is('an array', sanitizeTimeline([]), null);
is('empty lists', sanitizeTimeline({ chapters: [], links: [] }), null);
is('only junk', sanitizeTimeline({ chapters: [{ start: 'x' }], links: [{ kind: 'nope' }] }), null);

console.log('── links: refused ──');
const L = (l) => (sanitizeTimeline({ links: [l] }) || { links: [] }).links;
is('javascript: url', L({ at: 1, kind: 'url', url: 'javascript:alert(1)' }), []);
is('data: url', L({ at: 1, kind: 'url', url: 'data:text/html,<b>x</b>' }), []);
is('protocol-relative url', L({ at: 1, kind: 'url', url: '//evil.example/x' }), []);
is('url with credentials', L({ at: 1, kind: 'url', url: 'https://3speak.tv@evil.example/' }), []);
is('url over 500 chars', L({ at: 1, kind: 'url', url: 'https://example.com/' + 'a'.repeat(490) }), []);
is('url not a string', L({ at: 1, kind: 'url', url: { href: 'https://x.com' } }), []);
is('account too short', L({ at: 1, kind: 'profile', account: 'ab' }), []);
is('account with a slash', L({ at: 1, kind: 'profile', account: 'bob/../x' }), []);
is('account starting with a digit', L({ at: 1, kind: 'profile', account: '1bob' }), []);
is('permlink with a query', L({ at: 1, kind: 'video', author: 'alice', permlink: 'x?y=1' }), []);
is('permlink with html', L({ at: 1, kind: 'video', author: 'alice', permlink: '<img>' }), []);
is('missing permlink', L({ at: 1, kind: 'video', author: 'alice' }), []);
is('at as a string', L({ at: '42', kind: 'profile', account: 'bob' }), []);
is('negative at', L({ at: -1, kind: 'profile', account: 'bob' }), []);
is('NaN at', L({ at: NaN, kind: 'profile', account: 'bob' }), []);
is('unknown kind', L({ at: 1, kind: 'script', url: 'https://x.com' }), []);
is('null item', L(null), []);

console.log('── links: normalised ──');
is('dur clamped up to 3', L({ at: 1, dur: 0.5, kind: 'profile', account: 'bob' })[0].dur, 3);
is('dur clamped down to 60', L({ at: 1, dur: 9999, kind: 'profile', account: 'bob' })[0].dur, 60);
is('dur missing → 8', L({ at: 1, kind: 'profile', account: 'bob' })[0].dur, 8);
is('dur unreadable → 8', L({ at: 1, dur: 'long', kind: 'profile', account: 'bob' })[0].dur, 8);
is('account case/space folded', L({ at: 1, kind: 'profile', account: ' Bob ' })[0].account, 'bob');
is('site is the real host, not the claim',
  L({ at: 1, kind: 'url', url: 'https://www.evil.example/p', site: '3speak.tv' })[0].site, 'evil.example');
is('http allowed', L({ at: 1, kind: 'url', url: 'http://example.com' })[0].url, 'http://example.com/');
const long = L({ at: 1, kind: 'profile', account: 'bob', title: 'x'.repeat(250) })[0].title;
is('title cut to 100', long.length, 100);
is('control + bidi chars stripped',
  L({ at: 1, kind: 'profile', account: 'bob', title: 'a\u0000b‮c\n\td' })[0].title, 'a b c d');
is('html stays text (escaped by textContent later)',
  L({ at: 1, kind: 'profile', account: 'bob', title: '<b>hi</b>' })[0].title, '<b>hi</b>');
is('blank title dropped', 'title' in L({ at: 1, kind: 'profile', account: 'bob', title: '   ' })[0], false);
const many = sanitizeTimeline({ links: Array.from({ length: 40 }, (_, i) => ({ at: 40 - i, kind: 'profile', account: 'bob' })) });
is('at most 20 links', many.links.length, 20);
is('  sorted by at', many.links.map((l) => l.at).slice(0, 3), [1, 2, 3]);
is('one bad link does not sink the rest',
  sanitizeTimeline({ links: [{ at: 1, kind: 'url', url: 'javascript:x' }, { at: 2, kind: 'profile', account: 'bob' }] }).links.length, 1);

console.log('── chapters ──');
const C = (c) => (sanitizeTimeline({ chapters: c }) || { chapters: [] }).chapters;
is('sorted ascending', C([{ start: 95, title: 'B' }, { start: 0, title: 'A' }]).map((c) => c.title), ['A', 'B']);
is('duplicate start dropped', C([{ start: 0, title: 'A' }, { start: 0, title: 'A2' }]).length, 1);
is('untitled dropped', C([{ start: 0, title: '' }, { start: 5 }]).length, 0);
is('string start dropped', C([{ start: '5', title: 'x' }]).length, 0);
is('at most 50', C(Array.from({ length: 80 }, (_, i) => ({ start: i * 10, title: 'c' + i }))).length, 50);

console.log('── timing helpers ──');
is('active at 42', activeLinks(good.links, 42).length, 1);
is('active at 49.9', activeLinks(good.links, 49.9).length, 1);
is('gone at 50', activeLinks(good.links, 50).length, 0);
is('chapter at 10', chapterAt(good.chapters, 10).title, 'Intro');
is('chapter at 95', chapterAt(good.chapters, 95).title, 'Setup');
is('chapter before the first', chapterAt([{ start: 5, title: 'x' }], 1), null);
is('href of a tampered url link', linkHref({ kind: 'url', url: 'javascript:alert(1)' }), null);
is('href of a tampered profile', linkHref({ kind: 'profile', account: 'x/../../evil' }), null);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
