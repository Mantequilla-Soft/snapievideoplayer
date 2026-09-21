# 3speak Video Player

A full-stack HTML5 video player built with Video.js for the 3speak platform. Supports both legacy videos and the new embed system with MongoDB backend integration.

## Features

- **JW Player-inspired architecture** - Elegant, simple approach to video playback (see [JW Player Reference](docs/JW_PLAYER_REFERENCE.md))
- **Automatic aspect ratio detection** - Reads video dimensions from HLS metadata and adapts perfectly
- **Perfect vertical video support** - No cropping, no scrollbars, no complex hacks (just like JW Player!)
- **Full-stack architecture** - Node.js/Express backend + Video.js frontend
- **MongoDB integration** - Connects to 3speak MongoDB for video metadata
- **Dual video systems** - Supports legacy `videos` collection and new `embed-video` collection
- **HLS streaming** - Loads videos from IPFS gateway as HLS streams
- **Scrub preview** - YouTube-style low-res thumbnail above the seek bar on hover (desktop) / drag (mobile). A detached hls.js `<video>` pinned to the lowest rendition renders the frame, so it never disturbs playback. On by default; disable with `preview=0`
- **"Most replayed" heatmap** - Aggregate watch/rewatch graph above the seek bar (from `/api/heatmap`), YouTube-style. Shows once a video has enough independent viewers. On by default; disable with `heatmap=0`
- **Status-based placeholders** - Shows different videos based on encoding status (processing, finalizing, failed, deleted)
- **View tracking** - Automatically increments view count when video plays (and a non-polluting watch-duration heartbeat that also records the view `source`)
- **Responsive design** - Modern UI with custom 3speak styling
- **Comprehensive documentation** - [Live embedding demo](https://play.3speak.tv/embed-demo.html) with code examples

## Architecture

### Backend (Node.js/Express)
- `server.js` - Express server with API endpoints
- `db.js` - MongoDB connection and query functions
- `.env` - Configuration (MongoDB URI, IPFS gateway, placeholders)

### Frontend (Video.js)
- `src/index.html` - Video player page
- `src/main.js` - Player logic and API integration
- `src/styles.css` - Custom 3speak styling
- `dist/` - Webpack build output (served by Express)

## Project Structure

```
SnapieVideoPlayer/
├── server.js            # Express server
├── db.js                # MongoDB connection module
├── .env                 # Environment configuration
├── src/
│   ├── index.html       # Main HTML file
│   ├── main.js          # Player initialization and logic
│   └── styles.css       # Custom styles
├── scripts/              # Migration scripts + test-*.mjs test suites
├── dist/                 # Build output (served by Express, gitignored)
├── .github/workflows/    # ci.yml (lint/test/build on PRs), deploy.yml (on merge to master)
├── webpack.config.js     # Webpack configuration
├── eslint.config.js      # ESLint flat config
└── package.json          # Project dependencies
```

## Setup

### Prerequisites

- Node.js (v20 or higher)
- Access to 3speak MongoDB
- IPFS gateway access

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd SnapieVideoPlayer
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your actual MongoDB credentials and configuration
```

**IMPORTANT:** Never commit the `.env` file to git. It contains sensitive credentials.

4. Build the frontend:
```bash
npm run build
```

5. Start the server:
```bash
npm start
```

Server runs on http://localhost:3005 (configurable via PORT in .env)

### Checks before opening a PR

```bash
npm run lint   # ESLint
npm test       # runs scripts/test-*.mjs
npm run build  # production webpack build
```

These same three steps run in CI (`.github/workflows/ci.yml`) on every pull request into `master`, which is required to pass before merging.

## Usage

### Legacy Videos (videos collection)

Access via: `http://localhost:3005/watch?v=owner/permlink`

Example: `http://localhost:3005/watch?v=meno/p723so6v`

### Embed Videos (embed-video collection)

Access via: `http://localhost:3005/embed?v=owner/permlink`

Example: `http://localhost:3005/embed?v=testuser123/ma4k9uzo`

### URL Parameters

- `v` - **Required**: Video identifier (`owner/permlink`)
- `mode=iframe` - **Optional**: Enable minimal embed mode (hides header/info)
- `layout` - **Optional**: Force specific container layout:
  - `layout=mobile` - Tall 3:4 container (recommended for mobile apps)
  - `layout=square` - Square 1:1 container (maximum compatibility)
  - `layout=desktop` - Flexible responsive (default behavior)
- `autoplay=1` - **Optional**: Autoplay the video (muted fallback if browser blocks sound)
- `controls=0` - **Optional**: Hide player controls
- `mute=1` - **Optional**: Start player muted (parent can unmute via postMessage `unmute` command)
- `loop=1` - **Optional**: Loop video playback (seamless restart on ended, no ended event fired)
- `tvmode=1` - **Optional**: TV mode (Enter key toggles fullscreen, disables Video.js hotkeys)
- `captions=0` - **Optional**: Disable captions (shown by default when available)
- `preview=0` - **Optional**: Disable the YouTube-style scrub preview (a low-res thumbnail shown above the seek bar on hover/drag). **On by default.**
- `heatmap=0` - **Optional**: Disable the "most replayed" heatmap shown above the seek bar. **On by default** (only renders once a video has enough viewers).
- `debug=1` - **Optional**: Enable debug logging to console
- `noscroll=1` - **Optional**: Disable scrollbars

**Mobile App Example:**
```
http://localhost:3005/embed?v=vempromundo/hkh2vzzf&mode=iframe&layout=mobile
```

### Embed Video Status Handling

The embed system shows different videos based on status:
- **uploading/encoding** → Processing placeholder video
- **finalizing** → Finalizing placeholder video
- **published** → Actual video from MongoDB
- **failed** → Failed placeholder video
- **deleted** → Deleted placeholder video

## API Endpoints

### GET /api/watch?v=owner/permlink
Returns legacy video metadata and IPFS URL

### GET /api/embed?v=owner/permlink
Returns embed video metadata with status-based URL selection

### POST /api/view
Increments view count
```json
{
  "owner": "meno",
  "permlink": "p723so6v",
  "type": "legacy" // or "embed"
}
```

## Deployment

Deployment is automated via GitHub Actions, not a manual VPS walkthrough:
`master` is protected (PR + approval required), and merging to it triggers
`.github/workflows/deploy.yml`, which builds and restarts the `snapie-player`
systemd service on the VPS. Every PR is also gated by
`.github/workflows/ci.yml` (lint, test, build).

See [DEPLOYMENT.md](DEPLOYMENT.md) for the one-time VPS/Nginx setup,
production `.env` reference, verification steps, and rollback instructions.

## Security Checklist

Before pushing to git:

- ✅ `.env` file is in `.gitignore` and will NOT be committed
- ✅ `.env.example` provides template without sensitive data
- ✅ All credentials use environment variables (no hardcoded secrets)
- ✅ MongoDB credentials stored only in `.env`
- ✅ `dist/` and `node_modules/` excluded from git

Run `./safety-check.sh` locally to verify the above (checks `.env` is
gitignored and that no MongoDB credentials are hardcoded in tracked files).

**Files that contain sensitive info (already in .gitignore):**
- `.env` - MongoDB credentials, API keys
- `node_modules/` - Dependencies
- `dist/` - Build output

## Configuration

All configuration is in `.env`:

- `MONGODB_URI` - MongoDB connection string
- `MONGODB_DATABASE` - Database name (threespeak)
- `MONGODB_COLLECTION_LEGACY` - Legacy videos collection (videos)
- `MONGODB_COLLECTION_NEW` - Embed videos collection (embed-video)
- `IPFS_GATEWAY` - IPFS gateway URL
- `PLACEHOLDER_*_CID` - Status placeholder video CIDs
- `PORT` - Server port (default: 3005)
- `NODE_ENV` - Environment (development/production)

## Vertical Video Handling

This player uses **JW Player's proven approach** for handling all video orientations:

- **Automatic detection** - Player reads video dimensions from HLS manifest
- **Proper aspect ratios** - Dynamically sets aspect ratio using Video.js API
- **Simple CSS** - No complex positioning hacks, just pure Video.js
- **Perfect display** - Works equally well for horizontal (16:9), vertical (9:16), and square (1:1)

### For Web Developers (PostMessage API)

Web apps can detect video orientation dynamically using the PostMessage API - no database queries needed!

```javascript
// Add this listener ONE TIME to your app (works for ALL videos)
window.addEventListener('message', (event) => {
    if (event.data.type === '3speak-player-ready') {
        const { isVertical, width, height, aspectRatio } = event.data;
        const iframe = event.source.frameElement;
        
        // Adjust iframe size based on video orientation
        if (isVertical) {
            iframe.style.height = '800px';
            iframe.style.maxWidth = '450px';
        } else {
            iframe.style.height = '450px';
            iframe.style.maxWidth = '800px';
        }
    }
});

// Then embed videos normally - player auto-detects everything!
function embed(author, permlink) {
    const iframe = document.createElement('iframe');
    iframe.src = `https://play.3speak.tv/embed?v=${author}/${permlink}&mode=iframe`;
    iframe.width = '100%';
    iframe.height = '600'; // Default, will auto-adjust
    document.body.appendChild(iframe);
}
```

### PostMessage Commands (Parent → Player)

The parent window can control the player via `postMessage`:

| Command | Description |
|---------|-------------|
| `play` | Play the video |
| `pause` | Pause the video |
| `toggle-play` | Toggle play/pause |
| `mute` | Mute the player |
| `unmute` | Unmute the player |
| `toggleMute` | Toggle mute state |
| `seek` | Seek to time (send `{ type: 'seek', time: 30 }`) |
| `seekForward` | Seek forward (default 10s, or `{ seconds: N }`) |
| `seekBackward` | Seek backward (default 10s, or `{ seconds: N }`) |
| `toggle-fullscreen` | Toggle fullscreen |
| `enter-fullscreen` | Enter fullscreen |
| `exit-fullscreen` | Exit fullscreen |
| `lock-orientation` | Lock screen orientation based on video dimensions (portrait for vertical, landscape for horizontal) |
| `unlock-orientation` | Unlock screen orientation |

```javascript
// Example: lock orientation when entering fullscreen on mobile
const iframe = document.querySelector('iframe');
iframe.contentWindow.postMessage({ type: 'lock-orientation' }, '*');
// Later, unlock:
iframe.contentWindow.postMessage({ type: 'unlock-orientation' }, '*');
```

### Technical Details

- **No forced aspect ratios** - The player lets Video.js calculate naturally
- **No transform hacks** - Simple absolute positioning with translate-based centering
- **HLS metadata reading** - Extracts video dimensions from manifest
- **Performance** - Optimized like JW Player with aggressive buffering and quality upgrade strategies
- **See** [docs/JW_PLAYER_REFERENCE.md](docs/JW_PLAYER_REFERENCE.md) for full implementation analysis

## Layout Modes

The player supports three layout modes to handle different embedding scenarios:

| Mode | Aspect Ratio | Best For | Key Feature |
|------|--------------|----------|-------------|
| `layout=desktop` | 16:9 | Web embeds, blog posts | **YouTube-style** - strict 16:9 with letterboxing (default) |
| `layout=mobile` | 3:4 | Mobile apps, social feeds | **Tall container** - works for all video orientations, no scrollbars |
| `layout=square` | 1:1 | Grid layouts, thumbnails | **Universal** - maximum compatibility, perfect square |

**Default (No Parameter):** Uses `layout=desktop` - YouTube-style 16:9 letterboxing with automatic video centering.

### Desktop Layout (YouTube-Style, Default)

```
https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=desktop
```

All videos maintain a strict **16:9 aspect ratio**:
- Horizontal videos fill the container naturally
- Vertical videos get black bars on the sides (letterboxed)
- Square videos get black bars above and below
- Perfect for web embeds and blog posts

### Mobile Layout (Recommended for Apps)

```
https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=mobile
```

Creates a **tall 3:4 container** that works perfectly for any video orientation:
- **No scrollbars** - ever
- **No orientation detection** needed - works for vertical AND horizontal
- **Recommended for iOS, Android, React Native, Flutter**
- See complete examples below

### Square Layout (Maximum Compatibility)

```
https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=square
```

Universal 1:1 square container for grid layouts, thumbnails, and ultra-simple embeds.

## Mobile App Integration

### Using the `layout=mobile` Parameter

The `layout=mobile` parameter provides a **universal container** that works for ALL video orientations without requiring orientation detection or database queries:

```bash
# Same URL works for vertical AND horizontal videos - no scrollbars!
https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=mobile
```

**iOS Swift:**
```swift
let videoUrl = "https://play.3speak.tv/embed?v=\(author)/\(permlink)&mode=iframe&layout=mobile"
webView.load(URLRequest(url: URL(string: videoUrl)!))
webView.scrollView.isScrollEnabled = false  // Disable scrollbars
```

**Android Kotlin:**
```kotlin
val videoUrl = "https://play.3speak.tv/embed?v=$author/$permlink&mode=iframe&layout=mobile"
webView.loadUrl(videoUrl)
// WebView with match_parent dimensions in layout XML
```

**React Native:**
```javascript
const videoUrl = `https://play.3speak.tv/embed?v=${author}/${permlink}&mode=iframe&layout=mobile`;
<WebView 
  source={{ uri: videoUrl }} 
  style={{ aspectRatio: 3/4 }}  // 3:4 ratio matches mobile layout
  scrollEnabled={false}
/>
```

**Flutter:**
```dart
final videoUrl = 'https://play.3speak.tv/embed?v=$author/$permlink&mode=iframe&layout=mobile';
AspectRatio(
  aspectRatio: 3/4,
  child: WebViewWidget(controller: controller),
)
```

**Benefits:**
- ✅ One container for all videos - no orientation detection needed
- ✅ No scrollbars ever - automatic letterboxing
- ✅ Works immediately - no database changes required
- ✅ Mobile-optimized - 3:4 ideal for phone screens

**For more detailed integration examples, see [EMBEDDING.md](EMBEDDING.md).**

## Development Notes

- HLS streams loaded from IPFS gateway
- View counter increments on first play
- Player events logged to console for debugging
- Supports all Video.js features and plugins
- Refactored to match JW Player's elegant implementation (Nov 2024)

## License

MIT
