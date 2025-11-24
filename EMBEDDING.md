# Embedding Guide for 3speak Video Player

This guide shows how to embed videos from play.3speak.tv into your website or application.

## Quick Start

### Standard Embed (Recommended)

For embedding in blog posts, articles, or any webpage:

```html
<iframe 
  src="https://play.3speak.tv/watch?v=meno/1czchhmr&mode=iframe" 
  width="854" 
  height="480"
  frameborder="0"
  allowfullscreen
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
  title="3speak Video Player">
</iframe>
```

### Responsive Embed

For responsive designs that adapt to screen size:

```html
<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden;">
  <iframe 
    src="https://play.3speak.tv/watch?v=meno/1czchhmr&mode=iframe" 
    style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"
    frameborder="0"
    allowfullscreen
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    title="3speak Video Player">
  </iframe>
</div>
```

## URL Formats

### Legacy Videos (from videos collection)
```
https://play.3speak.tv/watch?v=owner/permlink&mode=iframe
```

### Direct Upload Videos (from embed-video collection)
```
https://play.3speak.tv/embed?v=owner/permlink&mode=iframe
```

### Full Player Page (without iframe mode)
```
https://play.3speak.tv/watch?v=owner/permlink
https://play.3speak.tv/embed?v=owner/permlink
```

## Parameters

- `v` - **Required**: Video identifier in format `owner/permlink`
- `mode=iframe` - **Optional**: Enables minimal UI for embedding (hides header and info panel)
- `layout` - **Optional**: Force specific container layout (see below)
- `noscroll=1` - **Optional**: Disables all scrollbars inside the iframe (perfect for fixed-size containers)

### Layout Parameter (for Mobile Apps)

**Problem:** Mobile apps (iOS, Android, React Native, Flutter) often can't dynamically adjust iframe sizes based on video orientation. This causes scrollbars or awkward layouts.

**Solution:** Use the `layout` parameter to create universal containers that work perfectly for ALL video orientations without requiring dynamic resizing!

#### Available Layout Modes

1. **`layout=mobile`** - Tall 3:4 container (RECOMMENDED FOR MOBILE APPS)
   ```
   https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=mobile
   ```
   - Creates a 3:4 aspect ratio container (taller than wide)
   - Perfect for mobile phone screens
   - Works beautifully for vertical videos (fills container)
   - Works perfectly for horizontal videos (letterboxed, no scrollbars)
   - Use this if your app can't dynamically adjust iframe sizes

2. **`layout=square`** - Square 1:1 container (MAXIMUM COMPATIBILITY)
   ```
   https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=square
   ```
   - Creates a square container
   - Works for any video orientation
   - Ideal for social media grids, thumbnails, ultra-simple layouts
   - Always letterboxes content to fit

3. **`layout=desktop`** - Flexible responsive (DEFAULT BEHAVIOR)
   ```
   https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=desktop
   ```
   - Uses fluid responsive container
   - Adapts to video aspect ratio automatically
   - Best for web apps that can listen to PostMessage API
   - Same as not specifying layout parameter

#### When to Use Layout Modes

| Use Case | Recommended Layout | Why? |
|----------|-------------------|------|
| **iOS/Android Native Apps** | `layout=mobile` | Can't resize iframes dynamically |
| **React Native/Flutter** | `layout=mobile` | Simplest universal container |
| **Social Media Grids** | `layout=square` | Consistent size for all videos |
| **Web Apps with PostMessage** | `layout=desktop` or no parameter | Can adapt dynamically |
| **Simple Embeds (Unknown Orientation)** | `layout=mobile` | Works for everything |

#### Mobile App Integration Examples

**iOS Swift:**
```swift
import UIKit
import WebKit

class VideoPlayerViewController: UIViewController {
    var webView: WKWebView!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        webView = WKWebView(frame: self.view.bounds)
        webView.scrollView.isScrollEnabled = false
        view.addSubview(webView)
        
        // 🎯 Use layout=mobile for universal compatibility!
        let videoURL = "https://play.3speak.tv/embed?v=vempromundo/hkh2vzzf&mode=iframe&layout=mobile"
        webView.load(URLRequest(url: URL(string: videoURL)!))
    }
}
```

**Android Kotlin:**
```kotlin
import android.webkit.WebView

class VideoPlayerActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        val webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        setContentView(webView)
        
        // 🎯 Use layout=mobile - works for all orientations!
        val videoUrl = "https://play.3speak.tv/embed?v=vempromundo/hkh2vzzf&mode=iframe&layout=mobile"
        webView.loadUrl(videoUrl)
    }
}
```

**React Native:**
```javascript
import React from 'react';
import { WebView } from 'react-native-webview';

const ThreeSpeakPlayer = ({ author, permlink }) => {
  const videoUrl = `https://play.3speak.tv/embed?v=${author}/${permlink}&mode=iframe&layout=mobile`;
  
  return (
    <WebView
      source={{ uri: videoUrl }}
      style={{ aspectRatio: 3/4 }}
      allowsFullscreenVideo={true}
      scrollEnabled={false}
    />
  );
};
```

**Flutter:**
```dart
import 'package:webview_flutter/webview_flutter.dart';

class ThreeSpeakPlayer extends StatelessWidget {
  final String author;
  final String permlink;
  
  @override
  Widget build(BuildContext context) {
    final videoUrl = 'https://play.3speak.tv/embed?v=$author/$permlink&mode=iframe&layout=mobile';
    
    return AspectRatio(
      aspectRatio: 3 / 4,
      child: WebViewWidget(
        controller: WebViewController()
          ..loadRequest(Uri.parse(videoUrl)),
      ),
    );
  }
}
```

#### Benefits of Layout Parameter

✅ **One Container for All Videos** - No orientation detection needed  
✅ **No Scrollbars Ever** - Perfect letterboxing for all orientations  
✅ **Copy-Paste Integration** - Same code for every video  
✅ **Works Immediately** - No database changes or API calls  
✅ **Mobile-Optimized** - 3:4 ratio ideal for phone screens  
✅ **Production-Ready** - Battle-tested and reliable  

Just add `&layout=mobile` to your iframe URL and you're done! 🎉

## For Frontend Developers (PeakD, Ecency, etc.)

### 🎯 Auto-Detecting Video Orientation (PostMessage API)

**NEW: The player automatically tells you if a video is vertical or horizontal!**

No database queries needed. The player reads dimensions from the HLS manifest and sends you a message.

#### Step 1: Add ONE TIME Message Listener

```javascript
// Add this once when your app initializes
window.addEventListener('message', (event) => {
    // Only process messages from play.3speak.tv
    if (!event.origin.includes('3speak.tv')) return;
    
    if (event.data.type === '3speak-player-ready') {
        const { isVertical, width, height, aspectRatio, orientation } = event.data;
        
        // Find the iframe that sent this message
        const iframe = Array.from(document.querySelectorAll('iframe'))
            .find(frame => frame.contentWindow === event.source);
        
        if (iframe) {
            // Adjust iframe size based on orientation
            iframe.style.height = isVertical ? '800px' : '450px';
            iframe.parentElement.style.maxWidth = isVertical ? '450px' : '800px';
            
            console.log(`Video is ${orientation}: ${width}x${height}`);
        }
    }
});
```

#### Step 2: Embed Videos Normally

```javascript
// Just embed the iframe - player handles the rest!
function embedVideo(author, permlink) {
    return `
        <div style="margin: 0 auto;">
            <iframe 
                src="https://play.3speak.tv/embed?v=${author}/${permlink}&mode=iframe"
                width="100%"
                height="450px"
                frameborder="0"
                allowfullscreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture">
            </iframe>
        </div>
    `;
}
```

#### React/Next.js Component Example

```javascript
import { useEffect, useRef, useState } from 'react';

const ThreeSpeakPlayer = ({ author, permlink }) => {
    const iframeRef = useRef(null);
    const [isVertical, setIsVertical] = useState(false);
    
    useEffect(() => {
        const handleMessage = (event) => {
            if (event.data.type === '3speak-player-ready' && 
                event.source === iframeRef.current?.contentWindow) {
                setIsVertical(event.data.isVertical);
            }
        };
        
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);
    
    return (
        <div style={{ maxWidth: isVertical ? '450px' : '800px', margin: '0 auto' }}>
            <iframe
                ref={iframeRef}
                src={`https://play.3speak.tv/embed?v=${author}/${permlink}&mode=iframe`}
                width="100%"
                height={isVertical ? '800px' : '450px'}
                frameBorder="0"
                allowFullScreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            />
        </div>
    );
};
```

#### Message Format

The player sends this message when video metadata loads:

```javascript
{
    type: '3speak-player-ready',
    isVertical: boolean,        // true if height > width
    width: number,              // e.g., 1080
    height: number,             // e.g., 1920
    aspectRatio: number,        // e.g., 0.5625 (9:16)
    orientation: string         // 'vertical' or 'horizontal'
}
```

### Auto-Embed Detection (Legacy Method)

To automatically convert 3speak URLs into embedded players:

1. **Detect URLs** matching patterns:
   - `https://play.3speak.tv/watch?v=*`
   - `https://play.3speak.tv/embed?v=*`
   - `https://3speak.tv/watch?v=*` (legacy)

2. **Transform to iframe**:
   ```javascript
   function embedVideo(url) {
     const embedUrl = url.includes('?') 
       ? `${url}&mode=iframe` 
       : `${url}?mode=iframe`;
     
     return `<iframe src="${embedUrl}" width="100%" height="450px" frameborder="0" allowfullscreen></iframe>`;
   }
   ```

3. **With PostMessage Support**:
   ```javascript
   // Detect 3speak URLs in markdown or content
   const videoRegex = /https:\/\/(play\.)?3speak\.tv\/(watch|embed)\?v=([^&\s]+)/g;
   
   const content = "Check out this video: https://play.3speak.tv/watch?v=meno/1czchhmr";
   
   const embeddedContent = content.replace(videoRegex, (match, subdomain, route, videoId) => {
     return `
       <div class="threespeak-video-container">
         <iframe 
           src="https://play.3speak.tv/${route}?v=${videoId}&mode=iframe" 
           width="100%" 
           height="450px" 
           frameborder="0" 
           allowfullscreen>
         </iframe>
       </div>
     `;
   });
   ```

### API Access (Alternative Method)

If you prefer to use your own video player, you can fetch video data via API:

```javascript
// For legacy videos
const response = await fetch('https://play.3speak.tv/api/watch?v=meno/1czchhmr');
const videoData = await response.json();
// Returns: { videoUrl, thumbnail, title, owner, permlink, etc. }

// For direct upload videos
const response = await fetch('https://play.3speak.tv/api/embed?v=meno/1czchhmr');
const videoData = await response.json();
```

Then use the `videoUrl` (HLS manifest) in your own Video.js or other HLS-compatible player.

## Why PostMessage API?

Using the PostMessage API for video dimensions provides major benefits:

✅ **Zero Database Changes** - Works with existing schema, no migrations needed  
✅ **Source of Truth** - Reads dimensions directly from HLS manifest (actual video file)  
✅ **Future-Proof** - Works even if transcoding changes video dimensions  
✅ **Works for ALL Videos** - Legacy videos, new uploads, everything  
✅ **No Extra API Calls** - Frontend doesn't need to query video metadata  
✅ **Accurate** - Always matches actual playback dimensions  
✅ **Simple Integration** - One message listener handles all videos  
✅ **Fast Setup** - Frontend devs can integrate in under 10 minutes  

## Features

- ✅ HLS streaming with adaptive quality
- ✅ Manual quality selector
- ✅ Automatic IPFS gateway fallback
- ✅ Thumbnail/poster support
- ✅ View counter integration
- ✅ Mobile responsive
- ✅ Fullscreen support
- ✅ Keyboard shortcuts
- ✅ Playback speed control
- ✅ **NEW: PostMessage API for auto-detection of video orientation**

## Browser Compatibility

Works in all modern browsers:
- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Examples

### Full-width Embed
```html
<iframe 
  src="https://play.3speak.tv/watch?v=meno/1czchhmr&mode=iframe" 
  style="width: 100%; height: 500px;"
  frameborder="0"
  allowfullscreen>
</iframe>
```

### Fixed Size Embed
```html
<iframe 
  src="https://play.3speak.tv/watch?v=meno/1czchhmr&mode=iframe" 
  width="640" 
  height="360"
  frameborder="0"
  allowfullscreen>
</iframe>
```

### In a Blog Post (with caption)
```html
<figure>
  <iframe 
    src="https://play.3speak.tv/watch?v=meno/1czchhmr&mode=iframe" 
    width="854" 
    height="480"
    frameborder="0"
    allowfullscreen>
  </iframe>
  <figcaption>My awesome video on 3speak</figcaption>
</figure>
```

## Disabling Scrollbars

### The Problem

When embedding videos in constrained layouts (mobile apps, fixed-size containers, sidebars), you may see unwanted scrollbars inside the iframe. This happens because:

1. The iframe's internal document has its own scroll behavior
2. Cross-origin iframes can't be styled from the parent page
3. Layout mismatches between container and video can create overflow

### The Solution: `noscroll` Parameter

Add `&noscroll=1` to your embed URL to completely disable scrollbars:

```html
<!-- Without noscroll - may show scrollbars in constrained layouts -->
<iframe 
  src="https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=mobile"
  width="100%" 
  height="600"
  frameborder="0"
  allowfullscreen>
</iframe>

<!-- With noscroll - guaranteed zero scrollbars -->
<iframe 
  src="https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=mobile&noscroll=1"
  width="100%" 
  height="600"
  frameborder="0"
  allowfullscreen>
</iframe>
```

### When to Use `noscroll`

✅ **Mobile Apps** - WebView containers with fixed dimensions  
✅ **Fixed Layouts** - When your iframe has explicit width/height  
✅ **Embedded Widgets** - Sidebars, cards, or dashboard panels  
✅ **Design Systems** - Maintaining strict visual consistency  

### Best Practice for Mobile Apps

For mobile apps, combine `layout=mobile` with `noscroll=1`:

```
https://play.3speak.tv/embed?v=author/permlink&mode=iframe&layout=mobile&noscroll=1
```

This gives you:
- ✅ Perfect 3:4 container for all video orientations
- ✅ Automatic video centering
- ✅ Zero scrollbars
- ✅ Clean, professional appearance

### TypeScript/React Example

```typescript
function fix3SpeakUrl(url: string): string {
  if (!url.includes('play.3speak.tv/embed')) return url;

  try {
    const urlObj = new URL(url);
    urlObj.searchParams.set('noscroll', '1');
    return urlObj.toString();
  } catch {
    // fallback if URL is malformed
    return url + (url.includes('?') ? '&' : '?') + 'noscroll=1';
  }
}

// Use it:
<iframe src={fix3SpeakUrl(originalUrl)} {...otherProps} />
```

## Need Help?

- API Documentation: `https://play.3speak.tv/api`
- Issues: Open an issue on GitHub
- Contact: @meno on Hive

## License

This player is open source and free to use for embedding 3speak videos.
