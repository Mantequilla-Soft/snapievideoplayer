# 3speak Video Embed Integration Guide

**Audience:** AI agents and automated systems integrating 3speak video playback into web or mobile applications.  
**Purpose:** Teach an AI to detect 3speak URLs, convert them to embeddable form, configure the player, and handle layout correctly on desktop and mobile.

---

## 1. URL Detection

### Patterns to recognize as 3speak video URLs

Detect any URL matching these patterns. All are valid entry points that must be normalized before embedding.

| Pattern | Example |
|---|---|
| Watch page | `https://3speak.tv/watch?v=owner/permlink` |
| Embed page | `https://3speak.tv/embed?v=owner/permlink` |
| Malformed watch (missing `v=`) | `https://3speak.tv/watch?=owner/permlink` |
| Play subdomain (already normalized) | `https://play.3speak.tv/watch?v=owner/permlink` |
| Play subdomain embed | `https://play.3speak.tv/embed?v=owner/permlink` |

### Regex for detection

```js
const THREESPEAK_URL_REGEX = /https?:\/\/(www\.)?(?:play\.)?3speak\.tv\/(watch|embed)[/?]/i;
```

### Extracting `owner` and `permlink`

The `v` query parameter always takes the form `owner/permlink`.

```js
function parseThreeSpeakUrl(url) {
  const parsed = new URL(url);

  // Handle malformed ?= (missing key name — treat as v)
  let v = parsed.searchParams.get('v');
  if (!v) {
    // Fallback: raw search string like ?=owner/permlink or ?v=owner/permlink
    const raw = parsed.search.replace(/^\?=?/, '');
    if (raw.includes('/')) v = raw;
  }

  if (!v || !v.includes('/')) return null;

  const [owner, permlink] = v.split('/');
  return { owner: owner.trim(), permlink: permlink.trim() };
}
```

---

## 2. URL Conversion

### Rule

Always convert `3speak.tv` URLs to `play.3speak.tv` before embedding. The play subdomain is the canonical player endpoint.

| Input | Output |
|---|---|
| `https://3speak.tv/watch?v=alice/my-video` | `https://play.3speak.tv/watch?v=alice/my-video` |
| `https://3speak.tv/embed?v=alice/my-video` | `https://play.3speak.tv/embed?v=alice/my-video` |
| `https://3speak.tv/watch?=alice/my-video` | `https://play.3speak.tv/embed?v=alice/my-video` |

### Which endpoint to use for embedding

- Use `/embed` when placing the player in an `<iframe>`. It is identical to `/watch` functionally but signals embed intent.
- Use `/watch` for standalone or direct navigation contexts.

### Conversion function

```js
function toThreeSpeakEmbedUrl(rawUrl, params = {}) {
  const parsed = parseThreeSpeakUrl(rawUrl);
  if (!parsed) throw new Error('Not a valid 3speak URL');

  const { owner, permlink } = parsed;

  const embedUrl = new URL(`https://play.3speak.tv/embed`);
  embedUrl.searchParams.set('v', `${owner}/${permlink}`);

  // Append any extra player parameters
  for (const [key, value] of Object.entries(params)) {
    embedUrl.searchParams.set(key, value);
  }

  return embedUrl.toString();
}

// Example
toThreeSpeakEmbedUrl('https://3speak.tv/watch?v=alice/intro', { autoplay: '1', mute: '1' });
// → https://play.3speak.tv/embed?v=alice%2Fintro&autoplay=1&mute=1
```

---

## 3. Player URL Parameters

Append these as query parameters to the embed URL to control player behavior.

| Parameter | Values | Default | Effect |
|---|---|---|---|
| `v` | `owner/permlink` | required | Identifies the video |
| `mode` | `iframe` | none | Minimal UI — hides non-essential chrome. Always set this when embedding in an iframe |
| `layout` | `desktop`, `mobile`, `square` | `desktop` | Hints player layout. Set `mobile` for narrow containers |
| `noscroll` | `1` or `true` | off | Hides iframe scrollbars. Always set when embedding |
| `autoplay` | `1` or `true` | off | Autoplays the video. Browser will mute it automatically |
| `mute` | `1` or `true` | off | Starts player muted. Required for reliable autoplay |
| `controls` | `0` or `false` | on | Hides playback controls entirely |
| `loop` | `1` or `true` | off | Loops playback |
| `captions` | `0` or `false` | on | Disables closed captions |
| `tvmode` | `1` or `true` | off | Enter key toggles fullscreen — use for TV/living-room apps |

### Recommended parameter sets

**Standard embed (desktop):**
```
?v=owner/permlink&mode=iframe&noscroll=1
```

**Autoplay in feed (desktop or mobile):**
```
?v=owner/permlink&mode=iframe&noscroll=1&autoplay=1&mute=1
```

**Mobile embed:**
```
?v=owner/permlink&mode=iframe&noscroll=1&layout=mobile
```

**No controls (background/ambient):**
```
?v=owner/permlink&mode=iframe&noscroll=1&autoplay=1&mute=1&controls=0&loop=1
```

---

## 4. iframe Integration

### Minimal correct iframe

```html
<iframe
  src="https://play.3speak.tv/embed?v=alice/my-video&mode=iframe&noscroll=1"
  width="100%"
  height="100%"
  frameborder="0"
  scrolling="no"
  allowfullscreen
  allow="autoplay; fullscreen; picture-in-picture"
></iframe>
```

### Required attributes

| Attribute | Value | Why |
|---|---|---|
| `frameborder` | `0` | Removes default border |
| `scrolling` | `no` | Prevents double scrollbars (also set `noscroll=1` in URL) |
| `allowfullscreen` | present | Enables fullscreen button |
| `allow` | `autoplay; fullscreen; picture-in-picture` | Grants permissions for autoplay and fullscreen |

### Security: `sandbox` attribute

Do **not** apply a restrictive `sandbox` attribute to this iframe. The player requires:
- Script execution
- Same-origin storage (for subtitle language preferences)
- Fullscreen access

If you must sandbox, use at minimum:
```
sandbox="allow-scripts allow-same-origin allow-fullscreen"
```

---

## 5. Layout — Desktop

### Standard 16:9 container

```html
<style>
.video-wrapper {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 16:9 */
  background: #000;
}
.video-wrapper iframe {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: 0;
}
</style>

<div class="video-wrapper">
  <iframe
    src="https://play.3speak.tv/embed?v=alice/my-video&mode=iframe&noscroll=1"
    scrolling="no"
    allowfullscreen
    allow="autoplay; fullscreen; picture-in-picture"
  ></iframe>
</div>
```

### Fixed max-width

For article or blog contexts, cap width and center:

```css
.video-wrapper {
  max-width: 960px;
  margin: 0 auto;
}
```

---

## 6. Layout — Mobile

### Rules for mobile

- Set `layout=mobile` in the embed URL.
- Use `width: 100%` — never a fixed pixel width on mobile.
- Use the same 16:9 padding-top trick; it scales naturally.
- Avoid setting a fixed `height` on the iframe — let the aspect ratio drive it.
- On very small screens (< 360px wide), the player will still render but controls may be compact — this is expected.

### Responsive embed (works on both desktop and mobile)

```html
<style>
.threespeak-embed {
  position: relative;
  width: 100%;
  padding-top: 56.25%;
  background: #000;
  border-radius: 4px;
  overflow: hidden;
}
.threespeak-embed iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}
</style>

<div class="threespeak-embed">
  <iframe
    src="https://play.3speak.tv/embed?v=alice/my-video&mode=iframe&noscroll=1&layout=mobile"
    scrolling="no"
    allowfullscreen
    allow="autoplay; fullscreen; picture-in-picture"
  ></iframe>
</div>
```

### React Native / WebView

When embedding inside a React Native `WebView`, use `injectedJavaScript` to disable touch event conflicts, and set `allowsInlineMediaPlayback={true}` to prevent full-screen hijacking on iOS:

```jsx
<WebView
  source={{ uri: 'https://play.3speak.tv/embed?v=alice/my-video&mode=iframe&noscroll=1&layout=mobile' }}
  allowsInlineMediaPlayback={true}
  mediaPlaybackRequiresUserAction={false}
  style={{ width: '100%', aspectRatio: 16 / 9 }}
/>
```

---

## 7. Vertical Video Handling

Some 3speak videos are vertical (portrait orientation, e.g., 9:16). The player detects this and broadcasts dimensions to the parent window via `postMessage`. Use this to dynamically resize the iframe container.

### Listening for video orientation

```js
window.addEventListener('message', (event) => {
  if (event.data?.type !== '3speak-player-ready') return;

  const { isVertical, width, height, aspectRatio, orientation } = event.data;
  // orientation: 'vertical' | 'horizontal' | 'square'

  const container = document.querySelector('.threespeak-embed');
  if (container) {
    // Recalculate padding-top to match actual video aspect ratio
    container.style.paddingTop = `${(1 / aspectRatio) * 100}%`;
  }
});
```

### Orientation values

| `orientation` | `aspectRatio` | Use case |
|---|---|---|
| `horizontal` | > 1.0 (e.g., 1.78) | Standard landscape — default 16:9 layout |
| `vertical` | < 1.0 (e.g., 0.5625) | Portrait/short-form — adjust container height |
| `square` | = 1.0 | Square format |

---

## 8. postMessage API

The player communicates bidirectionally with the parent frame via `postMessage`.

### Commands — parent → player

Send these from your page to control the player:

```js
const iframe = document.querySelector('iframe');

// Play
iframe.contentWindow.postMessage({ type: 'play' }, '*');

// Pause
iframe.contentWindow.postMessage({ type: 'pause' }, '*');

// Seek to 30 seconds
iframe.contentWindow.postMessage({ type: 'seek', time: 30 }, '*');

// Set volume (0.0 – 1.0)
iframe.contentWindow.postMessage({ type: 'setVolume', volume: 0.5 }, '*');

// Get current player state
iframe.contentWindow.postMessage({ type: 'getState' }, '*');

// Get available quality levels
iframe.contentWindow.postMessage({ type: 'getQualityLevels' }, '*');

// Set quality level (index from getQualityLevels response)
iframe.contentWindow.postMessage({ type: 'setQualityLevel', level: 2 }, '*');

// Get available caption languages
iframe.contentWindow.postMessage({ type: 'getCaptionLanguages' }, '*');

// Set caption language (use language code from getCaptionLanguages response)
iframe.contentWindow.postMessage({ type: 'setCaptions', language: 'en' }, '*');
```

### Events — player → parent

Listen for these on `window`:

```js
window.addEventListener('message', (event) => {
  const { type } = event.data || {};
  switch (type) {
    case '3speak-player-ready':
      // Player loaded. Fields: isVertical, width, height, aspectRatio, orientation
      break;
    case '3speak-play':
      // Playback started
      break;
    case '3speak-pause':
      // Playback paused
      break;
    case '3speak-ended':
      // Video finished
      break;
    case '3speak-timeupdate':
      // Fields: currentTime (seconds)
      break;
    case '3speak-durationchange':
      // Fields: duration (seconds)
      break;
    case '3speak-volumechange':
      // Fields: volume (0.0–1.0), muted (bool)
      break;
    case '3speak-state':
      // Response to getState. Fields: currentTime, duration, paused, volume, muted
      break;
    case '3speak-quality-levels':
      // Response to getQualityLevels. Fields: levels (array), currentLevel (index)
      break;
    case '3speak-quality-changed':
      // Fields: level (index)
      break;
    case '3speak-caption-languages':
      // Response to getCaptionLanguages. Fields: languages (array of {code, label})
      break;
  }
});
```

---

## 9. Best Practices Summary

1. **Always normalize** `3speak.tv` URLs to `play.3speak.tv` before embedding.
2. **Always use `/embed`** endpoint for iframe contexts, not `/watch`.
3. **Always add** `mode=iframe&noscroll=1` to the embed URL to get minimal UI and no scrollbars.
4. **Never hardcode pixel heights** — use the 16:9 padding-top ratio trick and update dynamically on `3speak-player-ready`.
5. **Set `layout=mobile`** when the container is narrower than ~500px or when running inside a mobile WebView.
6. **For autoplay**, always also set `mute=1`. Browsers block unmuted autoplay universally.
7. **Listen for `3speak-player-ready`** before sending postMessage commands — the player may not be ready to receive them otherwise.
8. **Do not strip the `v` parameter** when forwarding URLs — it is mandatory. An embed URL without `v` redirects to the landing page.
9. **Validate `owner/permlink` format** before building the URL. Both parts must be non-empty strings with no slashes within them.
10. **For TV apps**, add `tvmode=1` to enable Enter-key fullscreen toggling inside the iframe.
