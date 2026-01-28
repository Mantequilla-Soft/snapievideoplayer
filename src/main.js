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
let shouldShowControls = true; // Controls visible by default
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

  // Detect Mac OS - all browsers on Mac have strict SourceBuffer quota limits
  const isMac = /Mac|iPad|iPhone|iPod/.test(navigator.platform) || 
                /Mac|iPad|iPhone|iPod/.test(navigator.userAgent);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  
  // Mac OS has strict memory quotas - apply conservative buffer settings for ALL browsers on Mac
  const bufferSettings = isMac ? {
    maxBufferLength: 20,              // Mac: 20 seconds (conservative)
    maxMaxBufferLength: 40,           // Mac: 40 seconds max
    maxBufferSize: 20 * 1000 * 1000,  // Mac: 20MB buffer limit
    maxBufferHole: 0.3,
    bandwidth: 3000000,               // Mac: Start conservative
  } : {
    maxBufferLength: 30,              // Linux/Windows: 30 seconds
    maxMaxBufferLength: 60,           // 60 seconds max
    maxBufferSize: 30 * 1000 * 1000,  // 30MB buffer
    maxBufferHole: 0.5,
    bandwidth: 5000000,               // Start with 5Mbps
  };
  
  debugLog('Buffer settings', { isMac, isSafari, platform: navigator.platform, bufferSettings });

  player = videojs('snapie-player', {
    controls: shouldShowControls,
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
        overrideNative: isSafari && !isMac,  // Only use native on Safari non-Mac (iOS)
        ...bufferSettings,
        limitRenditionByPlayerDimensions: false,
        handleManifestRedirects: true,
        withCredentials: false
      },
      vhs: {
        enableLowInitialPlaylist: false,
        smoothQualityChange: true,
        overrideNative: isSafari && !isMac,  // Only use native on Safari non-Mac (iOS)
        ...bufferSettings,
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

  // Monitor buffering and manage buffer cleanup (especially important for Safari)
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

        // Mac OS: Aggressive buffer cleanup to avoid quota errors (all browsers on Mac)
        const isMac = /Mac|iPad|iPhone|iPod/.test(navigator.platform) ||
                      /Mac|iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isMac && tech.vhs.sourceUpdater_) {
          try {
            const currentTime = player.currentTime();
            const sourceUpdater = tech.vhs.sourceUpdater_;

            // Remove old buffered data (keep only 10 seconds behind current time)
            if (currentTime > 10) {
              debugLog('Mac OS: Cleaning old buffer to prevent quota errors');
              sourceUpdater.remove('video', 0, currentTime - 10);
              sourceUpdater.remove('audio', 0, currentTime - 10);
            }
          } catch (e) {
            debugLog('Could not clean buffer:', e);
          }
        }

        // Force bandwidth estimation higher if we're stalling (but not on Mac)
        if (!isMac && tech.vhs.bandwidth && tech.vhs.bandwidth < 5000000) {
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

  // Periodic buffer cleanup for Mac OS (every 5 seconds during playback)
  // This applies to ALL browsers on Mac (Safari, Chrome, Firefox, etc.)
  player.on('timeupdate', function() {
    const isMac = /Mac|iPad|iPhone|iPod/.test(navigator.platform) ||
                  /Mac|iPad|iPhone|iPod/.test(navigator.userAgent);
    if (!isMac) return;

    // Only clean every 5 seconds
    const currentTime = player.currentTime();
    if (!player.lastBufferCleanTime || currentTime - player.lastBufferCleanTime > 5) {
      player.lastBufferCleanTime = currentTime;

      try {
        const tech = player.tech({ IWillNotUseThisInPlugins: true });
        if (tech && tech.vhs && tech.vhs.sourceUpdater_ && currentTime > 15) {
          const sourceUpdater = tech.vhs.sourceUpdater_;
          const cleanupPoint = currentTime - 10; // Keep 10 seconds behind

          debugLog('Mac OS: Periodic buffer cleanup', { currentTime, cleanupPoint });
          sourceUpdater.remove('video', 0, cleanupPoint);
          sourceUpdater.remove('audio', 0, cleanupPoint);
        }
      } catch (e) {
        // Silently fail buffer cleanup
      }
    }
  });

  // Send time updates to parent window for external timeline control
  // Throttle to ~4 updates per second to avoid flooding
  let lastTimeUpdate = 0;
  player.on('timeupdate', function() {
    if (window.parent === window) return; // Not in iframe

    const now = Date.now();
    if (now - lastTimeUpdate < 250) return; // Throttle
    lastTimeUpdate = now;

    window.parent.postMessage({
      type: '3speak-timeupdate',
      currentTime: player.currentTime(),
      duration: player.duration(),
      paused: player.paused(),
      muted: player.muted(),
      volume: player.volume()
    }, '*');
  });

  // Send duration when it becomes available
  player.on('durationchange', function() {
    if (window.parent === window) return;

    window.parent.postMessage({
      type: '3speak-durationchange',
      duration: player.duration()
    }, '*');
  });

  // Send play/pause state changes to parent window
  player.on('play', function() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: '3speak-play' }, '*');
    }
  });

  player.on('pause', function() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: '3speak-pause' }, '*');
    }
  });

  player.on('ended', function() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: '3speak-ended' }, '*');
    }
  });

  player.on('error', function(error) {
    console.error('Player error:', error);
    debugLog('Player error details', error);
    
    const playerError = player.error();
    
    // Enhanced error diagnostics
    if (playerError) {
      const errorInfo = {
        code: playerError.code,
        message: playerError.message,
        type: ['MEDIA_ERR_ABORTED', 'MEDIA_ERR_NETWORK', 'MEDIA_ERR_DECODE', 'MEDIA_ERR_SRC_NOT_SUPPORTED'][playerError.code - 1] || 'UNKNOWN',
        currentSrc: player.currentSrc(),
        networkState: player.networkState(),
        readyState: player.readyState(),
        browser: navigator.userAgent,
        platform: navigator.platform
      };
      
      console.error('🔴 DETAILED ERROR INFO:', errorInfo);
      
      // Try to get tech-specific error details
      try {
        const tech = player.tech({ IWillNotUseThisInPlugins: true });
        if (tech && tech.vhs) {
          console.error('VHS State:', {
            currentPlaylist: tech.vhs.playlists?.media()?.uri || 'unknown',
            bandwidth: tech.vhs.bandwidth,
            systemBandwidth: tech.vhs.systemBandwidth,
            mediaRequests: tech.vhs.mediaRequests_,
            hasPlaylists: !!tech.vhs.playlists,
            masterPlaylistController: !!tech.vhs.masterPlaylistController_
          });
        }
      } catch (e) {
        console.error('Could not get VHS details:', e);
      }
    }
    
    // Check for MEDIA_ERR_DECODE (code 3)
    // This could be: codec issue, corrupted segments, CORS, or network problems
    if (playerError && playerError.code === 3) {
      console.error('🔴 MEDIA_ERR_DECODE detected');
      console.error('Possible causes: 1) Codec incompatibility (HEVC) 2) Corrupted segments 3) CORS issues 4) Network problems');
      
      // First, try fallback gateway - might be corrupted segments on this gateway
      if (currentVideoData && currentVideoData.videoUrlFallback && !player.triedFallback) {
        console.log('⚠️ Trying fallback gateway (might fix corrupted segments)...');
        player.triedFallback = true;
        player.src({
          src: currentVideoData.videoUrlFallback,
          type: 'application/x-mpegURL'
        });
        player.load();
        updatePlayerState('Retrying with different gateway...');
        return;
      }
      
      // If fallback also failed, show codec error
      console.error('❌ Fallback also failed - likely codec or corruption issue');
      showCodecError();
      updatePlayerState('Decode Error - See Console');
      return;
    }
    
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
    // Always log ALL incoming messages for debugging
    console.log('[3Speak Player] Received postMessage from:', event.origin, 'data:', event.data);

    if (!player) {
      console.log('[3Speak Player] Player not ready, ignoring message');
      return;
    }

    const data = event.data;
    if (!data) {
      console.log('[3Speak Player] No data in message, ignoring');
      return;
    }

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
      case 'toggleFullscreen':
      case 'toggle-fullscreen':
        if (player.isFullscreen()) {
          player.exitFullscreen();
        } else {
          player.requestFullscreen();
        }
        break;
      case 'enterFullscreen':
      case 'enter-fullscreen':
        if (!player.isFullscreen()) {
          player.requestFullscreen();
        }
        break;
      case 'exitFullscreen':
      case 'exit-fullscreen':
        if (player.isFullscreen()) {
          player.exitFullscreen();
        }
        break;
      case 'setVolume':
      case 'set-volume':
        if (typeof data.volume === 'number') {
          // Clamp volume between 0 and 1
          var vol = Math.max(0, Math.min(1, data.volume));
          player.volume(vol);
          // Unmute if setting volume > 0
          if (vol > 0 && player.muted()) {
            player.muted(false);
          }
        }
        break;
      case 'volumeUp':
      case 'volume-up':
        var currentVol = player.volume();
        var stepUp = data.step || 0.1;
        player.volume(Math.min(1, currentVol + stepUp));
        if (player.muted()) {
          player.muted(false);
        }
        break;
      case 'volumeDown':
      case 'volume-down':
        var currentVolDown = player.volume();
        var stepDown = data.step || 0.1;
        player.volume(Math.max(0, currentVolDown - stepDown));
        break;
      case 'getState':
      case 'get-state':
        // Return current player state to parent
        if (window.parent !== window) {
          window.parent.postMessage({
            type: '3speak-state',
            currentTime: player.currentTime(),
            duration: player.duration(),
            paused: player.paused(),
            muted: player.muted(),
            volume: player.volume(),
            ended: player.ended()
          }, '*');
        }
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
    autoplay: params.get('autoplay'), // '1' or 'true' to autoplay (muted)
    controls: params.get('controls') // '0' or 'false' to hide controls
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

// Show codec/decode error overlay
function showCodecError() {
  // Check if error overlay already exists
  let errorOverlay = document.querySelector('.vjs-codec-error-overlay');
  
  if (!errorOverlay) {
    // Create codec error overlay
    errorOverlay = document.createElement('div');
    errorOverlay.className = 'vjs-codec-error-overlay';
    errorOverlay.innerHTML = `
      <div class="codec-error-content">
        <div class="codec-error-icon">⚠️</div>
        <h3>Video Playback Error</h3>
        <p>The video cannot be decoded properly. This could be due to several reasons:</p>
        <div class="codec-error-details">
          <h4>Possible Causes:</h4>
          <p><strong>1. Codec Incompatibility:</strong> Video may use H.265/HEVC codec (not supported in Chrome/Firefox)</p>
          <p><strong>2. Corrupted Segments:</strong> Some video segments may be incomplete or damaged</p>
          <p><strong>3. Network Issues:</strong> Segments failed to download completely</p>
          <p><strong>4. CORS/Gateway Problems:</strong> Server configuration blocking proper playback</p>
          
          <h4>What to try:</h4>
          <p>✓ Refresh the page and try again</p>
          <p>✓ Try a different browser (if it works there, it's a codec issue)</p>
          <p>✓ Check browser console (F12) for detailed error messages</p>
          <p>✓ Contact video creator if problem persists</p>
        </div>
        <div class="codec-error-technical">
          <strong>Technical Details:</strong><br>
          Error Code: MEDIA_ERR_DECODE (3)<br>
          Browser: <span id="error-browser">Unknown</span><br>
          Platform: <span id="error-platform">Unknown</span><br>
          <br>
          Check console for full diagnostic information.
        </div>
      </div>
    `;
    
    // Add to player
    player.el().appendChild(errorOverlay);
    
    // Fill in browser/platform info
    const browserSpan = errorOverlay.querySelector('#error-browser');
    const platformSpan = errorOverlay.querySelector('#error-platform');
    if (browserSpan) browserSpan.textContent = navigator.userAgent.split(' ').pop() || 'Unknown';
    if (platformSpan) platformSpan.textContent = navigator.platform || 'Unknown';
  }
  
  // Show the overlay
  errorOverlay.style.display = 'flex';
  debugLog('Decode error overlay shown');
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async function() {
  // 1. FIRST: Get URL parameters and apply classes BEFORE initializing player
  const { video, type, mode, layout, debug, noscroll, autoplay, controls } = getUrlParams();

  isDebugMode = ['1', 'true', 'yes', 'debug'].includes((debug || '').toLowerCase());
  shouldAutoplay = ['1', 'true', 'yes'].includes((autoplay || '').toLowerCase());
  // Controls are shown by default, hide only if explicitly set to '0' or 'false'
  shouldShowControls = !['0', 'false', 'no'].includes((controls || '').toLowerCase());

  // PERFORMANCE: Detect Chrome once at startup (avoid regex on every video load)
  isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|Brave/.test(navigator.userAgent);

  debugLog('DOMContentLoaded params', { video, type, mode, layout, debug, noscroll, autoplay, controls, shouldAutoplay, shouldShowControls, isChrome });
  
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
