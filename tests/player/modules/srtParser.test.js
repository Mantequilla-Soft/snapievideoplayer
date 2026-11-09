import { describe, it, expect } from 'vitest';
import { parseSrt } from '../../../src/srtParser.js';

describe('parseSrt', () => {
  it('returns no cues for empty input', () => {
    expect(parseSrt('')).toEqual([]);
    expect(parseSrt('   \n\n  ')).toEqual([]);
  });

  it('parses numbered blocks into start, end and text', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,250 --> 00:00:04,000\nWorld\n';
    expect(parseSrt(srt)).toEqual([
      { start: 1, end: 2.5, text: 'Hello' },
      { start: 3.25, end: 4, text: 'World' },
    ]);
  });

  it('reads hours and minutes', () => {
    expect(parseSrt('1\n01:02:03,004 --> 01:02:05,000\nLate')).toEqual([
      { start: 3723.004, end: 3725, text: 'Late' },
    ]);
  });

  it('accepts a dot before the milliseconds, as WebVTT writes them', () => {
    expect(parseSrt('00:00:01.500 --> 00:00:02.000\nDot')).toEqual([{ start: 1.5, end: 2, text: 'Dot' }]);
  });

  it('normalises Windows line endings and keeps multi-line text', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nLine one\r\nLine two\r\n\r\n';
    expect(parseSrt(srt)).toEqual([{ start: 1, end: 2, text: 'Line one\nLine two' }]);
  });

  it('works without the cue number line', () => {
    expect(parseSrt('00:00:05,000 --> 00:00:06,000\nNo index')).toEqual([{ start: 5, end: 6, text: 'No index' }]);
  });

  it('treats several blank lines as one separator', () => {
    const srt = '00:00:01,000 --> 00:00:02,000\nA\n\n\n\n00:00:03,000 --> 00:00:04,000\nB';
    expect(parseSrt(srt).map((c) => c.text)).toEqual(['A', 'B']);
  });

  it('skips blocks with no timestamp, a bad timestamp, or no text', () => {
    const srt = [
      'just a note',
      '1\nnot a timestamp\nText',
      '2\n00:00:01 --> 00:00:02\nNo millis',
      '3\n00:00:03,000 --> 00:00:04,000\n   ',
      '4\n00:00:05,000 --> 00:00:06,000\nKept',
    ].join('\n\n');
    expect(parseSrt(srt)).toEqual([{ start: 5, end: 6, text: 'Kept' }]);
  });
});
