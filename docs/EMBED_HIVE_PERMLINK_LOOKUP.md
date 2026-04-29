# Embed Collection: Hive Permlink Lookup Fallback

**Date:** 2026-03-27
**Reported from:** 3speak-tv frontend
**Affects:** `/api/embed` endpoint

---

## Problem

Videos in the embed collection are not reachable from the 3speak.tv watch page when the URL uses the Hive permlink.

The watch page URL format is:

```
https://3speak.tv/watch?v={author}/{hive_permlink}
```

For example:

```
https://3speak.tv/watch?v=the-lead/eng-esp-hive-music-festival
```

The frontend SDK (`@mantequilla-soft/3speak-player`) extracts `the-lead/eng-esp-hive-music-festival` and calls:

```
GET /api/embed?v=the-lead/eng-esp-hive-music-festival
```

This returns **no result** because `/api/embed` only looks up by the `permlink` field (e.g., `plqklro2`), not by `hive_permlink` (e.g., `eng-esp-hive-music-festival`).

The video **does** exist in the embed collection. Using the 3speak permlink works fine:

```
GET /api/embed?v=the-lead/plqklro2  -->  200 OK, video found
```

## Root Cause

The embed collection documents have two distinct identifiers:

| Field            | Example                          | Description                        |
|------------------|----------------------------------|------------------------------------|
| `permlink`       | `plqklro2`                       | 3Speak internal identifier         |
| `hive_permlink`  | `eng-esp-hive-music-festival`    | Hive blockchain permlink           |

The `/api/embed` endpoint only queries by `permlink`. However, the 3speak.tv frontend (and Hive in general) references videos by `hive_permlink`, since that is what appears in Hive posts and the watch page URL.

## SDK Fallback Context

The frontend SDK already has a two-step fallback:

1. Try `/api/embed?v=author/permlink`
2. If not found, try `/api/watch?v=author/permlink`

This works for legacy videos (in the watch collection) and for embed videos when the 3speak permlink is used. It **fails** for embed videos when the hive permlink is used, because neither endpoint resolves it.

## Solution

In the `/api/embed` endpoint, add a fallback query by `hive_permlink` when the primary `permlink` lookup returns no result.

### Pseudocode

```js
async function handleEmbedRequest(author, permlink) {
  // Primary lookup: by 3speak permlink
  let video = await db.collection('embed').findOne({
    owner: author,
    permlink: permlink
  });

  // Fallback: by hive permlink
  if (!video) {
    video = await db.collection('embed').findOne({
      owner: author,
      hive_permlink: permlink
    });
  }

  if (!video) {
    return { error: 'Video not found' };
  }

  return video;
}
```

### Database Index

Ensure there is a compound index to keep the fallback query fast:

```js
db.collection('embed').createIndex({ owner: 1, hive_permlink: 1 })
```

There should already be one on `{ owner: 1, permlink: 1 }` for the primary lookup.

## Test Cases

After the fix, all of these should return the same video:

| Request | Expected |
|---------|----------|
| `GET /api/embed?v=the-lead/plqklro2` | 200 - found by `permlink` |
| `GET /api/embed?v=the-lead/eng-esp-hive-music-festival` | 200 - found by `hive_permlink` |
| `GET /api/watch?v=the-lead/plqklro2` | 404 - not in watch collection (expected) |

## No Frontend or SDK Changes Required

Once the `/api/embed` endpoint resolves `hive_permlink`, the existing SDK fallback chain handles everything:

1. SDK calls `/api/embed?v=the-lead/eng-esp-hive-music-festival`
2. API finds the video via `hive_permlink` fallback
3. Returns metadata with `videoUrl` etc.
4. Player loads the HLS stream

No changes needed in `@mantequilla-soft/3speak-player` or `3speak-tv`.
