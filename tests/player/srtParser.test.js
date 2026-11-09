import { describe, it, expect } from 'vitest';
import { parseSrt } from '../../src/srtParser.js';

describe('parseSrt', () => {
  it('runs in jsdom', () => {
    expect(typeof document).toBe('object');
    expect(Array.isArray(parseSrt(''))).toBe(true);
  });
});
