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

## Need Help?

- API Documentation: `https://play.3speak.tv/api`
- Issues: Open an issue on GitHub
- Contact: @meno on Hive

## License

This player is open source and free to use for embedding 3speak videos.
