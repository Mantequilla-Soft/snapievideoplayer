# Mobile API Info Endpoint Specification

## Overview
The Snapie player now exposes a lightweight info endpoint that returns video metadata optimized for the native mobile player implementation. This endpoint eliminates the need for the mobile app to perform gateway conversion logic—all URLs are returned fully resolved and ready to use.

## Endpoints

### Legacy Videos (Web Recorder)
```
GET /api/watch?v=owner/permlink&info=true
```

### Embed Videos (Snapie Mobile)
```
GET /api/embed?v=owner/permlink&info=true
```

## Response Format

### Legacy Video Response
```json
{
  "cid": "https://play.3speak.tv/hls/manifest.m3u8?u=https%3A%2F%2Fhotipfs-3speak-1.b-cdn.net%2Fipfs%2FQmXxxx%2Fmanifest.m3u8",
  "thumbnail": "https://hotipfs-3speak-1.b-cdn.net/ipfs/QmYyyy",
  "views": 42
}
```

### Embed Video Response
```json
{
  "cid": "https://play.3speak.tv/hls/manifest.m3u8?u=https%3A%2F%2Fbuttercloud.b-cdn.net%2F<bucket>%2FQmXxxx%2Fmanifest.m3u8&s3=1",
  "thumbnail": "https://hotipfs-3speak-1.b-cdn.net/ipfs/QmYyyy",
  "short": true,
  "views": 3
}
```

## Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `cid` | string (HTTPS URL) | The player's `/hls/manifest.m3u8` route for the video's HLS manifest. Despite the name it is a URL, not a CID: pass it to the native player exactly as given, query string included. Don't parse a CID out of it. |
| `thumbnail` | string (HTTPS URL) | Full CDN URL for thumbnail image. Pass directly to image component. |
| `short` | boolean | Embed videos only. Indicates short-form video format. |
| `views` | number | Current view count. |

## Data Trust & Validation

**All URLs are production-ready:**
- `cid` goes through the player's `/hls` route, which picks the source and fails over (see Source Chain below)
- Manifest always includes `/manifest.m3u8` suffix for HLS compliance
- Thumbnail URLs are pre-validated (never null; falls back to default if missing)

**No client-side conversion needed:**
- Server handles all IPFS-to-CDN conversion
- Server handles all `ipfs://` CID references
- Server handles HTTPS image URLs (from `images.hive.blog`) pass-through
- Deleted/processing/failed videos automatically return appropriate placeholder CIDs

## Status Handling

Server automatically handles video state:
- **Published** → Returns actual video CID
- **Processing/Uploading** → Returns processing placeholder CID
- **Deleted/Failed** → Returns appropriate placeholder CID
- **Not Found** → Returns HTTP 404

**No client logic needed.** Trust the CID returned and play it.

## Implementation Steps

1. Call endpoint: `GET /api/embed?v=username/videoid&info=true`
2. Parse JSON response
3. Pass `cid` directly to native video player (HLS source)
4. Pass `thumbnail` directly to image component
5. Display `views` count (optional)
6. For embed videos, use `short` flag for layout (optional)

**Error handling:** If request fails (network timeout, 404, 5xx), fall back to app's default video CID.

## Source Chain (Server-Side Only)

The server picks the source per video from the Mongo `storage_state` the hotnode archiver writes, and `/hls` (manifests) and `/seg` (each segment) fail over in this order:

| `storage_state` | Order |
|---|---|
| missing | hotnode zone → other IPFS gateways (as before) |
| `hot` | hotnode zone → S3 zone → `s3.3speak.tv` → other IPFS gateways |
| `archived`, `promoting` | S3 zone (`buttercloud.b-cdn.net`) → `s3.3speak.tv` → IPFS gateways |

IPFS gateways: `hotipfs-3speak-1.b-cdn.net` (hotnode), `ipfs-3speak.b-cdn.net`, `ipfs-audio.3speak.tv`, and `ipfs.3speak.tv` (supernode, last resort). S3 is used only when the server has `S3_BUCKET` set.

**Mobile app receives one URL.** No fallback URLs needed on client. Server handles availability.

## Testing

```bash
# Legacy video
curl -s "http://localhost:3005/api/watch?v=oluthomas/a6359d23&info=true" | jq

# Embed video
curl -s "http://localhost:3005/api/embed?v=elsalvadorian/rkhob0ys&info=true" | jq
```

Both should return full HTTPS URLs ready for immediate playback.
