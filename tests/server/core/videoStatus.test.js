import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VIDEO_STATUS, PLACEHOLDER_STATUSES, isPlaceholderStatus } = require('../../../videoStatus.js');

describe('VIDEO_STATUS', () => {
  it('names every status the server branches on', () => {
    expect(VIDEO_STATUS).toMatchObject({
      DELETED: 'deleted',
      ENCODING_IPFS: 'encoding_ipfs',
      ENCODING_FAILED: 'encoding_failed',
      PUBLISHED: 'published',
      SCHEDULED: 'scheduled',
    });
  });
});

describe('isPlaceholderStatus', () => {
  it.each([
    'delete', 'deleted', 'self_deleted', 'encoding_ipfs', 'ipfs_pinning', 'uploaded', 'encoding_failed', 'failed',
  ])('is true for %s (the player serves a notice clip)', (status) => {
    expect(isPlaceholderStatus(status)).toBe(true);
    expect(PLACEHOLDER_STATUSES.has(status)).toBe(true);
  });

  it('ignores case', () => {
    expect(isPlaceholderStatus('DELETED')).toBe(true);
    expect(isPlaceholderStatus('Encoding_Failed')).toBe(true);
  });

  it.each(['published', 'publish_later', 'publish_manual', 'scheduled', 'something-new'])(
    'is false for a playable or unknown status: %s',
    (status) => {
      expect(isPlaceholderStatus(status)).toBe(false);
    },
  );

  it('is false for a missing status', () => {
    expect(isPlaceholderStatus(undefined)).toBe(false);
    expect(isPlaceholderStatus(null)).toBe(false);
    expect(isPlaceholderStatus('')).toBe(false);
  });
});
