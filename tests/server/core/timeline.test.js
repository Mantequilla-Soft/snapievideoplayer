import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../../../timeline.js');
const { sanitizeTimeline, linkHref, activeLinks, chapterAt, safeUrl, isAccount, isPermlink } = T;

const chapters = (list) => sanitizeTimeline({ chapters: list })?.chapters;
const links = (list) => sanitizeTimeline({ links: list })?.links;

describe('limits', () => {
  it('exports the documented bounds', () => {
    expect([T.MAX_CHAPTERS, T.MAX_LINKS, T.TITLE_MAX, T.URL_MAX]).toEqual([50, 20, 100, 500]);
    expect([T.DUR_MIN, T.DUR_MAX, T.DUR_DEFAULT]).toEqual([3, 60, 8]);
  });
});

describe('isAccount / isPermlink', () => {
  it('accepts Hive-shaped account names only', () => {
    expect(isAccount('badadib')).toBe(true);
    expect(isAccount('a.b-c1')).toBe(true);
    expect(isAccount('ab')).toBe(false); // too short
    expect(isAccount('1abc')).toBe(false); // must start with a letter
    expect(isAccount('Badadib')).toBe(false);
    expect(isAccount('a'.repeat(17))).toBe(false);
    expect(isAccount(42)).toBe(false);
  });

  it('accepts lowercase permlinks up to 255 characters', () => {
    expect(isPermlink('my-post-1')).toBe(true);
    expect(isPermlink('a'.repeat(255))).toBe(true);
    expect(isPermlink('a'.repeat(256))).toBe(false);
    expect(isPermlink('has_underscore')).toBe(false);
    expect(isPermlink('')).toBe(false);
    expect(isPermlink(null)).toBe(false);
  });
});

describe('safeUrl', () => {
  it('normalises an http(s) URL', () => {
    expect(safeUrl('  https://Example.com  ')).toBe('https://example.com/');
    expect(safeUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
  });

  it('rejects anything that is not a plain http(s) link', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('ftp://example.com/')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl('')).toBeNull();
    expect(safeUrl('   ')).toBeNull();
    expect(safeUrl(123)).toBeNull();
  });

  it('rejects credentials that disguise the real host', () => {
    expect(safeUrl('https://3speak.tv@evil.example/')).toBeNull();
    expect(safeUrl('https://user:pass@example.com/')).toBeNull();
  });

  it('rejects a URL over URL_MAX, before or after normalising', () => {
    expect(safeUrl('https://example.com/' + 'a'.repeat(500))).toBeNull();
    // 300 characters in, but each space becomes %20 so the href passes 500.
    const spaced = 'https://example.com/' + ' x'.repeat(140);
    expect(spaced.length).toBeLessThanOrEqual(500);
    expect(safeUrl(spaced)).toBeNull();
  });
});

describe('sanitizeTimeline', () => {
  it('returns null for anything that is not a plain object', () => {
    expect(sanitizeTimeline(null)).toBeNull();
    expect(sanitizeTimeline(undefined)).toBeNull();
    expect(sanitizeTimeline('timeline')).toBeNull();
    expect(sanitizeTimeline([{ start: 0, title: 'x' }])).toBeNull();
  });

  it('returns null when nothing survives', () => {
    expect(sanitizeTimeline({})).toBeNull();
    expect(sanitizeTimeline({ chapters: 'nope', links: { at: 1 } })).toBeNull();
    expect(sanitizeTimeline({ chapters: [{ start: -1, title: 'x' }], links: [{ at: 1, kind: 'bogus' }] })).toBeNull();
  });

  it('keeps an empty list next to a populated one', () => {
    expect(sanitizeTimeline({ chapters: [{ start: 0, title: 'Intro' }] })).toEqual({
      chapters: [{ start: 0, title: 'Intro' }],
      links: [],
    });
  });

  it('accepts its own output again unchanged', () => {
    const once = sanitizeTimeline({
      chapters: [{ start: 5, title: 'B' }, { start: 0, title: 'A' }],
      links: [{ at: 1, kind: 'profile', account: 'badadib' }],
    });
    expect(sanitizeTimeline(once)).toEqual(once);
  });
});

describe('chapters', () => {
  it('sorts by start and drops duplicates (first one wins)', () => {
    expect(chapters([
      { start: 95, title: 'Setup' },
      { start: 0, title: 'Intro' },
      { start: 95, title: 'Duplicate' },
    ])).toEqual([{ start: 0, title: 'Intro' }, { start: 95, title: 'Setup' }]);
  });

  it('drops items without a numeric in-range start or a title', () => {
    expect(chapters([
      null,
      'Intro',
      { start: '5', title: 'string start' },
      { start: -1, title: 'negative' },
      { start: NaN, title: 'nan' },
      { start: Infinity, title: 'inf' },
      { start: 48 * 3600 + 1, title: 'past two days' },
      { start: 10, title: '   ' },
      { start: 11 },
      { start: 48 * 3600, title: 'last valid second' },
    ])).toEqual([{ start: 172800, title: 'last valid second' }]);
  });

  it('rounds starts to the millisecond', () => {
    expect(chapters([{ start: 1.23456, title: 'x' }])).toEqual([{ start: 1.235, title: 'x' }]);
  });

  it('caps the list at MAX_CHAPTERS', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ start: i, title: `c${i}` }));
    const out = chapters(many);
    expect(out).toHaveLength(50);
    expect(out.at(-1)).toEqual({ start: 49, title: 'c49' });
  });

  it('only looks at the first 200 raw items', () => {
    const raw = Array.from({ length: 200 }, () => ({ bad: true }));
    raw.push({ start: 1, title: 'too late' });
    expect(sanitizeTimeline({ chapters: raw })).toBeNull();
  });
});

describe('titles', () => {
  it('replaces control and bidi characters and collapses whitespace', () => {
    const title = 'a\u0000b\tc\n‮d⁦e\u0085f   g';
    expect(chapters([{ start: 0, title }])[0].title).toBe('a b c d e f g');
  });

  it('cuts at TITLE_MAX code points without splitting an emoji', () => {
    const title = 'x'.repeat(99) + '\u{1F600}\u{1F600}';
    const out = chapters([{ start: 0, title }])[0].title;
    expect(Array.from(out)).toHaveLength(100);
    expect(out.endsWith('\u{1F600}')).toBe(true);
  });

  it('trims a cut that ends on a space', () => {
    const title = 'x'.repeat(99) + ' tail';
    expect(chapters([{ start: 0, title }])[0].title).toBe('x'.repeat(99));
  });

  it('drops a title made only of unsafe characters', () => {
    expect(sanitizeTimeline({ chapters: [{ start: 0, title: '‮\u0001' }] })).toBeNull();
  });
});

describe('links', () => {
  it('keeps a video link, lowercasing author and permlink', () => {
    expect(links([{ at: 42, dur: 8, kind: 'video', author: ' BadAdib ', permlink: 'My-Post', title: 'Watch' }]))
      .toEqual([{ at: 42, dur: 8, kind: 'video', author: 'badadib', permlink: 'my-post', title: 'Watch' }]);
  });

  it('drops a video link with a bad author or permlink', () => {
    expect(sanitizeTimeline({ links: [
      { at: 1, kind: 'video', author: 'ab', permlink: 'ok' },
      { at: 1, kind: 'video', author: 'badadib', permlink: 'bad_permlink' },
      { at: 1, kind: 'video', author: 7, permlink: 'ok' },
    ] })).toBeNull();
  });

  it('keeps a profile link, title optional', () => {
    expect(links([{ at: 120, kind: 'profile', account: 'Viewer1' }]))
      .toEqual([{ at: 120, dur: 8, kind: 'profile', account: 'viewer1' }]);
    expect(links([{ at: 120, kind: 'profile', account: 'viewer1', title: 'Follow' }])[0].title).toBe('Follow');
    expect(sanitizeTimeline({ links: [{ at: 1, kind: 'profile', account: '1x' }] })).toBeNull();
  });

  it('keeps a url link and shows the site it really goes to', () => {
    expect(links([{ at: 300, kind: 'url', url: 'https://www.Example.com/page', site: '3speak.tv', title: 'Docs' }]))
      .toEqual([{ at: 300, dur: 8, kind: 'url', url: 'https://www.example.com/page', site: 'example.com', title: 'Docs' }]);
    expect(links([{ at: 3, kind: 'url', url: 'http://example.org' }])[0]).not.toHaveProperty('title');
  });

  it('drops a url link with an unsafe url', () => {
    expect(sanitizeTimeline({ links: [{ at: 1, kind: 'url', url: 'javascript:alert(1)' }] })).toBeNull();
  });

  it('drops links of unknown kind or without a valid position', () => {
    expect(sanitizeTimeline({ links: [
      { at: 1, kind: 'image', url: 'https://x.test/' },
      { kind: 'profile', account: 'badadib' },
      { at: -3, kind: 'profile', account: 'badadib' },
      null,
      42,
    ] })).toBeNull();
  });

  it('defaults a missing or unreadable dur and clamps a readable one', () => {
    const base = { at: 0, kind: 'profile', account: 'badadib' };
    const durs = links([
      { ...base, at: 1 },
      { ...base, at: 2, dur: '20' },
      { ...base, at: 3, dur: NaN },
      { ...base, at: 4, dur: 1 },
      { ...base, at: 5, dur: 600 },
      { ...base, at: 6, dur: 4.56789 },
    ]).map((l) => l.dur);
    expect(durs).toEqual([8, 8, 8, 3, 60, 4.568]);
  });

  it('sorts by time, keeping the author order for equal times', () => {
    const out = links([
      { at: 10, kind: 'profile', account: 'second' },
      { at: 5, kind: 'profile', account: 'first' },
      { at: 10, kind: 'profile', account: 'third' },
    ]);
    expect(out.map((l) => l.account)).toEqual(['first', 'second', 'third']);
  });

  it('caps the list at MAX_LINKS', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ at: i, kind: 'profile', account: 'badadib' }));
    expect(links(many)).toHaveLength(20);
  });
});

describe('linkHref', () => {
  it('opens a video on 3speak.tv', () => {
    expect(linkHref({ kind: 'video', author: 'badadib', permlink: 'my-post' })).toBe('https://3speak.tv/watch?v=badadib/my-post');
  });

  it('opens a profile on the /p/ route', () => {
    expect(linkHref({ kind: 'profile', account: 'badadib' })).toBe('https://3speak.tv/p/badadib');
  });

  it('re-checks a url link', () => {
    expect(linkHref({ kind: 'url', url: 'https://example.com' })).toBe('https://example.com/');
    expect(linkHref({ kind: 'url', url: 'javascript:alert(1)' })).toBeNull();
  });

  it('returns null for anything else', () => {
    expect(linkHref(null)).toBeNull();
    expect(linkHref('https://example.com')).toBeNull();
    expect(linkHref({ kind: 'video', author: 'BAD', permlink: 'x' })).toBeNull();
    expect(linkHref({ kind: 'profile', account: '' })).toBeNull();
    expect(linkHref({ kind: 'other' })).toBeNull();
  });
});

describe('activeLinks', () => {
  const list = [
    { at: 10, dur: 5, kind: 'profile', account: 'aaa' },
    { at: 12, dur: 8, kind: 'profile', account: 'bbb' },
  ];

  it('returns links whose window [at, at+dur) contains t', () => {
    expect(activeLinks(list, 9.99)).toEqual([]);
    expect(activeLinks(list, 10).map((l) => l.account)).toEqual(['aaa']);
    expect(activeLinks(list, 13).map((l) => l.account)).toEqual(['aaa', 'bbb']);
    expect(activeLinks(list, 15).map((l) => l.account)).toEqual(['bbb']);
    expect(activeLinks(list, 20)).toEqual([]);
  });

  it('returns [] for bad input', () => {
    expect(activeLinks(null, 1)).toEqual([]);
    expect(activeLinks(list, NaN)).toEqual([]);
    expect(activeLinks(list, '13')).toEqual([]);
  });
});

describe('chapterAt', () => {
  const list = [{ start: 5, title: 'A' }, { start: 60, title: 'B' }];

  it('returns the last chapter that started at or before t', () => {
    expect(chapterAt(list, 0)).toBeNull();
    expect(chapterAt(list, 5)).toEqual({ start: 5, title: 'A' });
    expect(chapterAt(list, 59.9).title).toBe('A');
    expect(chapterAt(list, 60).title).toBe('B');
    expect(chapterAt(list, 9999).title).toBe('B');
  });

  it('returns null for bad input', () => {
    expect(chapterAt(undefined, 1)).toBeNull();
    expect(chapterAt(list, Infinity)).toBeNull();
  });
});
