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
let shouldAutoplay = false;
let isChrome = false; // Detected once at startup for performance

function debugLog(...args) {
  if (isDebugMode) {
    console.log('[3Speak Debug]', ...args);
  }
}

function initializePlayer() {
  const isFixedLayout = document.body.classList.contains('layout-mobile') ||
                        document.body.classList.contains('layout-square') ||
                        document.body.classList.contains('layout-desktop');

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
        enableLowInitialPlaylist: false,
        smoothQualityChange: true,
        overrideNative: true,
        // Reasonable buffering (not too aggressive)
        maxBufferLength: 30,              // 30 seconds ahead
        maxMaxBufferLength: 60,           // Max 60 seconds total
        maxBufferSize: 30 * 1000 * 1000,  // 30MB buffer
        maxBufferHole: 0.5,
        bandwidth: 5000000,               // Start with 5Mbps
        limitRenditionByPlayerDimensions: false,
        handleManifestRedirects: true,
        withCredentials: false
      },
      vhs: {
        enableLowInitialPlaylist: false,
        smoothQualityChange: true,
        overrideNative: true,
        // Reasonable buffering (not too aggressive)
        maxBufferLength: 30,              // 30 seconds ahead
        maxMaxBufferLength: 60,           // Max 60 seconds total
        maxBufferSize: 30 * 1000 * 1000,  // 30MB buffer
        maxBufferHole: 0.5,
        bandwidth: 5000000,               // Start with 5Mbps
        limitRenditionByPlayerDimensions: false,
        handleManifestRedirects: true,
        withCredentials: false
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

    // Autoplay: try with sound first, fall back to muted
    // Skip autoplay entirely on Chrome (unreliable autoplay policy)
    if (shouldAutoplay) {
      if (isChrome) {
        // Chrome: skip autoplay entirely (detected at startup)
        debugLog('Autoplay: Chrome detected, skipping autoplay');
      } else {
        // Other browsers: try with sound first, fall back to muted
        debugLog('Autoplay: attempting play with sound');
        player.muted(false);
        player.play().catch(function(error) {
          debugLog('Autoplay with sound failed, trying muted:', error.message);
          player.muted(true);
          player.play().then(function() {
            showMutedAutoplayInfo();
          }).catch(function(err) {
            debugLog('Muted autoplay also failed:', err.message);
          });
        });
      }
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

  // Track stall count for gateway rotation
  player.stallCount = 0;
  player.lastStallTime = 0;
  
  // Monitor buffering and force aggressive loading
  player.on('waiting', function() {
    debugLog('Player waiting/buffering');
    
    const now = Date.now();
    const timeSinceLastStall = now - player.lastStallTime;
    
    // If stalling frequently (within 10 seconds), increment counter
    if (timeSinceLastStall < 10000) {
      player.stallCount++;
      debugLog(`Stall count: ${player.stallCount}`);
    } else {
      player.stallCount = 1;
    }
    player.lastStallTime = now;
    
    // Try to force buffer ahead when stalling
    try {
      const tech = player.tech({ IWillNotUseThisInPlugins: true });
      if (tech && tech.vhs) {
        debugLog('VHS buffer info', {
          buffered: player.buffered(),
          currentTime: player.currentTime(),
          systemBandwidth: tech.vhs.systemBandwidth,
          bandwidth: tech.vhs.bandwidth,
          stallCount: player.stallCount
        });
        
        // Force bandwidth estimation higher if we're stalling
        if (tech.vhs.bandwidth && tech.vhs.bandwidth < 5000000) {
          debugLog('Increasing bandwidth estimate to prevent stalling');
          tech.vhs.bandwidth = Math.max(tech.vhs.bandwidth * 2, 5000000);
        }
        
        // After 3 stalls, try fallback gateway if available
        if (player.stallCount >= 3 && currentVideoData && currentVideoData.videoUrlFallback && !player.triedFallback) {
          console.warn('Too many stalls - switching to fallback gateway');
          player.triedFallback = true;
          player.stallCount = 0;
          
          player.src({
            src: currentVideoData.videoUrlFallback,
            type: 'application/x-mpegURL'
          });
          
          // Resume from current position
          const currentTime = player.currentTime();
          player.one('loadedmetadata', function() {
            player.currentTime(currentTime);
            player.play();
          });
          
          updatePlayerState('Switched to backup gateway');
        }
      }
    } catch (e) {
      debugLog('Could not access VHS tech:', e);
    }
  });

  player.on('error', function(error) {
    console.error('Player error:', error);
    debugLog('Player error details', error);
    
    // If error is CORS/network related and we have a fallback, try it
    if (currentVideoData && currentVideoData.videoUrlFallback && !player.triedFallback) {
      debugLog('Trying fallback gateway...');
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

  // Listen for postMessage commands from parent window (for TV/iframe control)
  window.addEventListener('message', function(event) {
    if (!player) return;

    const data = event.data;
    if (!data) return;

    // Handle different message formats that parent might send
    const command = data.type || data.action || data.command;

    debugLog('Received postMessage command:', command, data);

    switch (command) {
      case 'play':
      case 'playVideo':
        // Check if we have user activation (user gesture context)
        var hasUserActivation = navigator.userActivation && navigator.userActivation.isActive;
        debugLog('User activation status:', hasUserActivation);

        if (hasUserActivation) {
          // We have user gesture - try unmuted play
          player.muted(false);
          player.play().catch(function(error) {
            debugLog('Play with sound failed despite user activation:', error.message);
            // Fall back to muted
            player.muted(true);
            player.play().then(function() {
              showMutedAutoplayInfo();
            });
          });
        } else {
          // No user gesture - try unmuted first, fall back to muted
          player.muted(false);
          player.play().catch(function(error) {
            debugLog('Play with sound blocked, trying muted:', error.message);
            player.muted(true);
            player.play().then(function() {
              showMutedAutoplayInfo();
            }).catch(function(err) {
              debugLog('Muted play also failed:', err.message);
            });
          });
        }
        break;
      case 'pause':
      case 'pauseVideo':
        player.pause();
        break;
      case 'toggle-play':
      case 'togglePlay':
        if (player.paused()) {
          player.play();
        } else {
          player.pause();
        }
        break;
      case 'mute':
        player.muted(true);
        break;
      case 'unmute':
        player.muted(false);
        break;
      case 'toggleMute':
        player.muted(!player.muted());
        break;
      case 'seek':
        if (typeof data.time === 'number') {
          player.currentTime(data.time);
        }
        break;
      case 'seekForward':
        player.currentTime(player.currentTime() + (data.seconds || 10));
        break;
      case 'seekBackward':
        player.currentTime(player.currentTime() - (data.seconds || 10));
        break;
      default:
        // Unknown command, ignore
        break;
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
    noscroll: params.get('noscroll'), // '1' or 'true' to disable scrollbars
    autoplay: params.get('autoplay') // '1' or 'true' to autoplay (muted)
  };
}

// Fetch video data from API
async function fetchVideoData(videoParam, type) {
  try {
    const endpoint = type === 'embed' ? '/api/embed' : '/api/watch';
    const url = `${endpoint}?v=${videoParam}`;
    
    debugLog(`Fetching video data from: ${url}`);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch video');
    }
    
    const data = await response.json();
    
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
      debugLog('View count incremented');
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
    debugLog('No thumbnail available for this video');
  }

  // Set video sources with CDN-first fallback chain
  const sources = [
    {
      src: videoData.videoUrl,
      type: 'application/x-mpegURL'
    }
  ];
  
  // Add fallback chain: CDN -> Supernode -> Hotnode -> Audionode
  if (videoData.videoUrlFallback1 && videoData.videoUrlFallback1 !== videoData.videoUrl) {
    sources.push({
      src: videoData.videoUrlFallback1,
      type: 'application/x-mpegURL'
    });
  }
  
  if (videoData.videoUrlFallback2 && videoData.videoUrlFallback2 !== videoData.videoUrl) {
    sources.push({
      src: videoData.videoUrlFallback2,
      type: 'application/x-mpegURL'
    });
  }
  
  if (videoData.videoUrlFallback3 && videoData.videoUrlFallback3 !== videoData.videoUrl) {
    sources.push({
      src: videoData.videoUrlFallback3,
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
  
  // If the browser hasn't parsed the HLS stream yet, dimensions are 0
  // This is a race condition bug - wait for the next frame to try again
  if (videoWidth === 0 || videoHeight === 0) {
    debugLog('Video dimensions are zero - waiting for loadeddata event');
    player.one('loadeddata', handleAspectRatio);
    return;
  }
  
  if (!videoWidth || !videoHeight) {
    debugLog('Video dimensions not yet available');
    return;
  }
  
  const isVertical = videoHeight > videoWidth;
  const aspectRatio = `${videoWidth}:${videoHeight}`;
  
  debugLog('handleAspectRatio video dimensions', {
    videoWidth,
    videoHeight,
    orientation: isVertical ? 'vertical' : 'horizontal'
  });
  
  // Check if we're in a fixed layout mode (mobile/square/desktop)
  const hasFixedLayout = document.body.classList.contains('layout-mobile') ||
                        document.body.classList.contains('layout-square') ||
                        document.body.classList.contains('layout-desktop');
  
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
    debugLog('Sent video info to parent window:', message);
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

// Show muted autoplay info button
function showMutedAutoplayInfo() {
  // Check if info already exists
  let infoContainer = document.querySelector('.vjs-muted-autoplay-info');

  if (!infoContainer) {
    // Create info button container
    infoContainer = document.createElement('div');
    infoContainer.className = 'vjs-muted-autoplay-info';
    infoContainer.innerHTML = `
      <button type="button" aria-label="Sound info">i</button>
      <div class="vjs-muted-autoplay-popup">
        <p>Sound is off because your browser blocked autoplay with audio. Tap the speaker icon to unmute.</p>
        <div class="browser-links">
          <p>Allow autoplay with sound:</p>
          <a href="https://support.mozilla.org/en-US/kb/block-autoplay" target="_blank" rel="noopener">Firefox</a>
          <a href="https://browserhow.com/how-to-allow-or-block-sound-and-media-on-brave-browser/" target="_blank" rel="noopener">Brave</a>
          <a href="https://www.microsoft.com/en-us/edge/learning-center/manage-autoplay" target="_blank" rel="noopener">Edge</a>
          <span class="chrome-strikeout">Chrome</span>
        </div>
      </div>
    `;

    const btn = infoContainer.querySelector('button');
    const popup = infoContainer.querySelector('.vjs-muted-autoplay-popup');

    // Toggle popup on click
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      popup.classList.toggle('visible');
    });

    // Close popup when clicking elsewhere
    document.addEventListener('click', function() {
      popup.classList.remove('visible');
    });

    // Hide info when user unmutes
    player.on('volumechange', function() {
      if (!player.muted()) {
        infoContainer.classList.remove('visible');
      }
    });

    // Add to player
    player.el().appendChild(infoContainer);
  }

  // Show the info button
  infoContainer.classList.add('visible');
  debugLog('Muted autoplay info shown');
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
  const { video, type, mode, layout, debug, noscroll, autoplay } = getUrlParams();

  isDebugMode = ['1', 'true', 'yes', 'debug'].includes((debug || '').toLowerCase());
  shouldAutoplay = ['1', 'true', 'yes'].includes((autoplay || '').toLowerCase());

  // PERFORMANCE: Detect Chrome once at startup (avoid regex on every video load)
  isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|Brave/.test(navigator.userAgent);

  debugLog('DOMContentLoaded params', { video, type, mode, layout, debug, noscroll, autoplay, shouldAutoplay, isChrome });
  
  if (mode === 'iframe') {
    document.body.classList.add('iframe-mode');
    debugLog('Iframe mode enabled - minimal UI');
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
