import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import qualityLevels from 'videojs-contrib-quality-levels';
import qualitySelector from 'videojs-hls-quality-selector';
import './styles.css';

// Register plugins once
if (!videojs.getPlugin('qualityLevels')) {
  videojs.registerPlugin('qualityLevels', qualityLevels);
}
if (!videojs.getPlugin('hlsQualitySelector')) {
  videojs.registerPlugin('hlsQualitySelector', qualitySelector);
}

// Initialize Video.js player
let player;
let currentVideoData = null;
let isDebugMode = false;

function debugLog(...args) {
  if (isDebugMode) {
    console.log('[3Speak Debug]', ...args);
  }
}

function initializePlayer() {
  const isFixedLayout = document.body.classList.contains('layout-mobile') || 
                        document.body.classList.contains('layout-square');

  debugLog('initializePlayer()', {
    isFixedLayout,
    bodyClassList: document.body.className
  });

  player = videojs('snapie-player', {
    controls: true,
    autoplay: false,
    preload: 'auto',
    fluid: !isFixedLayout,        // DISABLE fluid in mobile/square layouts
    responsive: !isFixedLayout,   // DISABLE responsive too
    playbackRates: [0.5, 1, 1.5, 2],
    userActions: {
      hotkeys: true,
      click: true  // Enable tap/click on video to play/pause
    },
    controlBar: {
      volumePanel: {
        inline: false
      }
    },
    html5: {
      hls: {
        enableLowInitialPlaylist: true,
        smoothQualityChange: true,
        overrideNative: true
      },
      vhs: {
        enableLowInitialPlaylist: true,
        smoothQualityChange: true,
        overrideNative: true
      }
    }
  });

  debugLog('player created with options', {
    fluidOption: !isFixedLayout,
    responsiveOption: !isFixedLayout
  });

  // Initialize quality selector plugin
  player.hlsQualitySelector({
    displayCurrentQuality: true,
  });

  // Setup logo fade behavior
  const logoTopLeft = document.getElementById('logo-top-left');
  const logoBottomRight = document.getElementById('logo-bottom-right');
  
  function handleLogoVisibility() {
    const isPlaying = !player.paused();
    const isUserActive = player.userActive();
    
    // Hide logos when playing and user is inactive
    if (isPlaying && !isUserActive) {
      if (logoTopLeft) logoTopLeft.style.opacity = '0';
      if (logoBottomRight) logoBottomRight.style.opacity = '0';
    } else {
      // Show logos when paused or user is active
      if (logoTopLeft) logoTopLeft.style.opacity = '0.85';
      if (logoBottomRight) logoBottomRight.style.opacity = '0.85';
    }
  }

  // Player event listeners
  player.on('ready', function() {
    debugLog('Player ready', {
      isFixedLayout,
      actualOptions: {
        fluid: player.options_.fluid,
        responsive: player.options_.responsive
      }
    });
    
    // PERFORMANCE: IPFS-optimized VHS buffer configuration
    try {
      const tech = player.tech({ IWillNotUseThisInPlugins: true });
      if (tech && tech.vhs) {
        const vhs = tech.vhs;
        
        // Assume decent bandwidth for faster startup
        vhs.bandwidth = 2500000; // 2.5 Mbps
        
        // IPFS-optimized buffer settings
        if (vhs.options_) {
          vhs.options_ = {
            ...vhs.options_,
            // Aggressive buffering for IPFS jitter
            maxBufferLength: 30,
            maxBufferSize: 100 * 1000 * 1000, // 100MB buffer
            maxBufferHole: 1.0,  // Tolerate 1s gaps (IPFS can be slow)
            
            // Faster startup
            enableLowInitialPlaylist: true,
            smoothQualityChange: true,
            
            // IPFS resilience - more retries and longer timeout
            maxPlaylistRetries: 5,
            timeout: 15000  // 15s for slow IPFS gateways
          };
          
          debugLog('VHS buffer optimizations applied', vhs.options_);
        }
      }
    } catch (error) {
      console.warn('Could not apply VHS optimizations:', error);
    }
    
    updatePlayerState('Ready');
  });

  player.on('loadedmetadata', function() {
    // JW Player approach: Read dimensions and set aspect ratio dynamically
    handleAspectRatio();
    
    // PERFORMANCE: Start at mid-quality instead of lowest (like JW Player)
    try {
      const qualityLevels = player.qualityLevels();
      if (qualityLevels && qualityLevels.length > 2) {
        const midQuality = Math.floor(qualityLevels.length / 2);
        
        // Enable mid-quality level
        for (let i = 0; i < qualityLevels.length; i++) {
          qualityLevels[i].enabled = (i === midQuality);
        }
        
        debugLog('Starting at mid-quality level:', midQuality, 'of', qualityLevels.length);
      }
    } catch (error) {
      debugLog('Could not set mid-quality startup:', error);
    }

    if (isDebugMode) {
      const tech = player.el_.querySelector('.vjs-tech');
      const videoJsEl = player.el();
      if (tech) {
        const techRect = tech.getBoundingClientRect();
        const techStyles = window.getComputedStyle(tech);
        debugLog('vjs-tech styles after loadedmetadata', {
          rect: {
            width: techRect.width,
            height: techRect.height,
            top: techRect.top,
            left: techRect.left
          },
          styles: {
            position: techStyles.position,
            width: techStyles.width,
            height: techStyles.height,
            top: techStyles.top,
            left: techStyles.left,
            transform: techStyles.transform
          }
        });
      } else {
        debugLog('vjs-tech element not found after loadedmetadata');
      }

      if (videoJsEl) {
        const wrapperRect = videoJsEl.getBoundingClientRect();
        debugLog('.video-js wrapper rect', {
          width: wrapperRect.width,
          height: wrapperRect.height
        });
      }
    }
  });





  player.on('play', function() {
    debugLog('Video playing');
    updatePlayerState('Playing');
    
    // Hide replay button when playing
    const replayBtn = document.querySelector('.vjs-replay-button');
    if (replayBtn) {
      replayBtn.style.display = 'none';
    }
    
    // Increment view count on first play
    if (currentVideoData && !player.hasIncrementedView) {
      incrementViewCount(currentVideoData);
      player.hasIncrementedView = true;
    }
  });
  
  // PERFORMANCE: Aggressive quality upgrades on first play (JW Player style)
  player.one('firstplay', function() {
    debugLog('First play - enabling aggressive quality upgrades');
    
    try {
      const tech = player.tech({ IWillNotUseThisInPlugins: true });
      if (tech && tech.vhs && tech.vhs.selectPlaylist) {
        const originalSelectPlaylist = tech.vhs.selectPlaylist.bind(tech.vhs);
        
        // Override playlist selection for aggressive upgrades
        tech.vhs.selectPlaylist = function() {
          const playlist = originalSelectPlaylist();
          const vhs = tech.vhs;
          
          if (vhs && vhs.playlists && vhs.playlists.master) {
            const levels = vhs.playlists.master.playlists;
            const currentBandwidth = vhs.systemBandwidth || vhs.bandwidth || 2500000;
            
            // Upgrade aggressively: allow 1.5x bandwidth buffer
            const targetBandwidth = currentBandwidth * 1.5;
            const eligibleLevels = levels.filter(p => 
              p.attributes && p.attributes.BANDWIDTH <= targetBandwidth
            );
            
            if (eligibleLevels.length > 0) {
              // Pick highest quality within 1.5x bandwidth
              const upgraded = eligibleLevels[eligibleLevels.length - 1];
              debugLog('Aggressive quality upgrade:', {
                from: playlist ? playlist.attributes?.BANDWIDTH : 'unknown',
                to: upgraded.attributes.BANDWIDTH,
                currentBandwidth,
                targetBandwidth
              });
              return upgraded;
            }
          }
          
          return playlist;
        };
      }
    } catch (error) {
      debugLog('Could not enable aggressive quality upgrades:', error);
    }
  });

  player.on('pause', function() {
    debugLog('Video paused');
    updatePlayerState('Paused');
    handleLogoVisibility();
  });

  player.on('ended', function() {
    debugLog('Video ended');
    updatePlayerState('Ended');
    showReplayButton();
  });
  
  // Handle user activity changes
  player.on('useractive', function() {
    handleLogoVisibility();
  });
  
  player.on('userinactive', function() {
    handleLogoVisibility();
  });

  player.on('error', function(error) {
    console.error('Player error:', error);
    debugLog('Player error details', error);
    
    // If error is CORS/network related and we have a fallback, try it
    if (currentVideoData && currentVideoData.videoUrlFallback && !player.triedFallback) {
      console.log('Trying fallback gateway...');
      player.triedFallback = true;
      player.src({
        src: currentVideoData.videoUrlFallback,
        type: 'application/x-mpegURL'
      });
      player.load();
      updatePlayerState('Retrying with fallback gateway...');
    } else {
      updatePlayerState('Error');
    }
  });

  return player;
}

// Parse URL parameters
function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    video: params.get('v'),
    type: window.location.pathname.includes('/embed') ? 'embed' : 'legacy',
    mode: params.get('mode'), // 'iframe' for minimal embedding UI
    layout: params.get('layout'), // 'mobile', 'square', or 'desktop' (default)
    debug: params.get('debug'),
    noscroll: params.get('noscroll') // '1' or 'true' to disable scrollbars
  };
}

// Fetch video data from API
async function fetchVideoData(videoParam, type) {
  try {
    const endpoint = type === 'embed' ? '/api/embed' : '/api/watch';
    const url = `${endpoint}?v=${videoParam}`;
    
    console.log(`Fetching video data from: ${url}`);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch video');
    }
    
    const data = await response.json();
    
    // PERFORMANCE: Preload HLS manifest to warm IPFS cache (fire & forget)
    if (data.videoUrl) {
      fetch(data.videoUrl, { 
        method: 'HEAD',
        cache: 'force-cache'
      }).then(() => {
        debugLog('HLS manifest preloaded from IPFS');
      }).catch(err => {
        debugLog('Manifest preload failed (non-critical):', err.message);
      });
    }
    
    return data;
    
  } catch (error) {
    console.error('Error fetching video:', error);
    throw error;
  }
}

// Increment view count
async function incrementViewCount(videoData) {
  try {
    const response = await fetch('/api/view', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        owner: videoData.owner,
        permlink: videoData.permlink,
        type: videoData.type
      })
    });
    
    if (response.ok) {
      console.log('View count incremented');
    }
  } catch (error) {
    console.error('Error incrementing view count:', error);
  }
}

// Load video into player
async function loadVideoFromData(videoData) {
  if (!player) {
    console.error('Player not initialized');
    return;
  }

  currentVideoData = videoData;
  player.hasIncrementedView = false;
  player.triedFallback = false;

  // Set poster/thumbnail if available
  if (videoData.thumbnail) {
    debugLog('Setting thumbnail', videoData.thumbnail);
    player.poster(videoData.thumbnail);
  } else {
    console.log('No thumbnail available for this video');
  }

  // Set video sources with fallback
  const sources = [
    {
      src: videoData.videoUrl,
      type: 'application/x-mpegURL'
    }
  ];
  
  // Add fallback if available
  if (videoData.videoUrlFallback && videoData.videoUrlFallback !== videoData.videoUrl) {
    sources.push({
      src: videoData.videoUrlFallback,
      type: 'application/x-mpegURL'
    });
  }

  player.src(sources);
  player.load();
  
  debugLog('Video sources set', sources);
  
  // Update UI
  const title = videoData.title || `${videoData.owner}/${videoData.permlink}`;
  updateCurrentSource(title);
  
  // Update view count
  updateViewCount(videoData.views);
  
  // Update info panel
  if (videoData.isPlaceholder) {
    updatePlayerState(`Placeholder (${videoData.status})`);
  } else {
    updatePlayerState('Ready');
  }
  
  debugLog('Loaded video data', videoData);
}





// JW Player approach: Read video dimensions and set aspect ratio dynamically
function handleAspectRatio() {
  if (!player) return;
  
  const videoWidth = player.videoWidth();
  const videoHeight = player.videoHeight();
  
  if (!videoWidth || !videoHeight) {
    console.log('Video dimensions not yet available');
    return;
  }
  
  const isVertical = videoHeight > videoWidth;
  const aspectRatio = `${videoWidth}:${videoHeight}`;
  
  debugLog('handleAspectRatio video dimensions', {
    videoWidth,
    videoHeight,
    orientation: isVertical ? 'vertical' : 'horizontal'
  });
  
  // Check if we're in a fixed layout mode (mobile/square)
  const hasFixedLayout = document.body.classList.contains('layout-mobile') || 
                        document.body.classList.contains('layout-square');
  
  // Only set aspect ratio dynamically if NOT in a fixed layout mode
  // Fixed layouts handle their own aspect ratios via CSS
  if (!hasFixedLayout) {
    player.aspectRatio(aspectRatio);
    debugLog('Dynamic aspect ratio applied', aspectRatio);
  } else {
    debugLog('Fixed layout mode detected - skipping dynamic aspect ratio');
  }
  
  // Add class for any additional styling needs
  if (isVertical) {
    player.addClass('vertical-video');
  } else {
    player.removeClass('vertical-video');
  }
  
  // 🚀 FRONTEND INTEGRATION: Send video dimensions to parent window (for iframe embedding)
  // This allows frontends to dynamically adjust iframe size for vertical videos
  if (window.parent !== window) {
    const message = {
      type: '3speak-player-ready',
      isVertical: isVertical,
      width: videoWidth,
      height: videoHeight,
      aspectRatio: videoWidth / videoHeight,
      orientation: isVertical ? 'vertical' : (videoWidth === videoHeight ? 'square' : 'horizontal')
    };
    
    window.parent.postMessage(message, '*');
    console.log('📤 Sent video info to parent window:', message);
  }
}

// Show replay button overlay
function showReplayButton() {
  // Check if replay button already exists
  let replayBtn = document.querySelector('.vjs-replay-button');
  
  if (!replayBtn) {
    // Create replay button
    replayBtn = document.createElement('button');
    replayBtn.className = 'vjs-replay-button';
    replayBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
      </svg>
      <span>Replay</span>
    `;
    
    // Add click handler
    replayBtn.addEventListener('click', function() {
      if (player) {
        player.currentTime(0);
        player.play();
        replayBtn.style.display = 'none';
      }
    });
    
    // Add to player
    player.el().appendChild(replayBtn);
  }
  
  // Show the button
  replayBtn.style.display = 'flex';
  debugLog('Replay button shown');
}

// Update UI helpers
function updateCurrentSource(sourceName) {
  const sourceElement = document.getElementById('current-source');
  if (sourceElement) {
    sourceElement.textContent = sourceName;
  }
}

function updatePlayerState(state) {
  const stateElement = document.getElementById('player-state');
  if (stateElement) {
    stateElement.textContent = state;
  }
}

function updateViewCount(count) {
  const viewElement = document.getElementById('view-count');
  if (viewElement) {
    viewElement.textContent = count ? count.toLocaleString() : '-';
  }
}

// Show error message
function showError(message) {
  const container = document.querySelector('.container');
  if (container) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.innerHTML = `
      <h2>⚠️ Error Loading Video</h2>
      <p>${message}</p>
    `;
    container.insertBefore(errorDiv, container.firstChild);
  }
  updatePlayerState('Error');
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async function() {
  // 1. FIRST: Get URL parameters and apply classes BEFORE initializing player
  const { video, type, mode, layout, debug, noscroll } = getUrlParams();

  isDebugMode = ['1', 'true', 'yes', 'debug'].includes((debug || '').toLowerCase());
  debugLog('DOMContentLoaded params', { video, type, mode, layout, debug, noscroll });
  
  if (mode === 'iframe') {
    document.body.classList.add('iframe-mode');
    console.log('Iframe mode enabled - minimal UI');
  }
  
  if (layout) {
    document.body.classList.add(`layout-${layout}`);
    debugLog('Layout class added to body', `layout-${layout}`);
  } else {
    debugLog('No layout parameter provided');
  }
  
  // Apply no-scroll mode to prevent iframe scrollbars
  if (noscroll === '1' || noscroll === 'true') {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    debugLog('No-scroll mode enabled');
  }
  
  debugLog('Body class list before init', document.body.className);
  
  // 2. NOW: Initialize the player (it can now detect layout classes correctly)
  initializePlayer();
  
  if (!video) {
    showError('No video specified. URL should be: /watch?v=owner/permlink or /embed?v=owner/permlink');
    return;
  }
  
  debugLog('Beginning video load', { type, video });
  
  try {
    // Fetch video data from API
    const videoData = await fetchVideoData(video, type);
    
    // Load video into player
    await loadVideoFromData(videoData);
    
  } catch (error) {
    showError(error.message);
  }
});

// Export player instance for external access
export { player, loadVideoFromData };
