/**
 * Video status vocabulary — SHARED so the "can the player actually serve this?"
 * question has exactly one answer in this codebase.
 *
 * It lives in its own module because the answer is needed in two places that must
 * never disagree: server.js (which decides whether to serve the video or a
 * placeholder notice clip) and watchTracking.js (which decides whether the
 * resulting playback is worth measuring). Duplicating the list is how the
 * retention pipeline silently broke once already.
 */

const VIDEO_STATUS = {
  // Deleted statuses
  DELETE: 'delete',
  DELETED: 'deleted',
  SELF_DELETED: 'self_deleted',

  // Processing statuses
  ENCODING_IPFS: 'encoding_ipfs',
  IPFS_PINNING: 'ipfs_pinning',
  UPLOADED: 'uploaded',

  // Failed statuses
  ENCODING_FAILED: 'encoding_failed',

  // Ready statuses
  PUBLISH_LATER: 'publish_later',
  PUBLISH_MANUAL: 'publish_manual',
  PUBLISHED: 'published',
  SCHEDULED: 'scheduled',
};

/**
 * Statuses where getVideoSource() serves a PLACEHOLDER notice clip instead of the
 * requested video. 'failed' is included alongside ENCODING_FAILED because the
 * failed branch in server.js accepts both spellings.
 */
const PLACEHOLDER_STATUSES = new Set([
  VIDEO_STATUS.DELETE, VIDEO_STATUS.DELETED, VIDEO_STATUS.SELF_DELETED,
  VIDEO_STATUS.ENCODING_IPFS, VIDEO_STATUS.IPFS_PINNING, VIDEO_STATUS.UPLOADED,
  VIDEO_STATUS.ENCODING_FAILED, 'failed',
]);

function isPlaceholderStatus(status) {
  return PLACEHOLDER_STATUSES.has(String(status || '').toLowerCase());
}

module.exports = { VIDEO_STATUS, PLACEHOLDER_STATUSES, isPlaceholderStatus };
