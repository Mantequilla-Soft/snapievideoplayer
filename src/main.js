import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import qualityLevels from 'videojs-contrib-quality-levels';
import qualitySelector from 'videojs-hls-quality-selector';
import './styles.css';
import subtitleManager from './subtitleManager';
import { initCaptionUI, updateOverlay, onSubtitleUpdate } from './captionUI';
import { createScrubPreview } from './scrubPreview';
import { createHeatmap } from './heatmapBar';
import { createAdBreak } from './adBreak';

// Register plugins once
if (!videojs.getPlugin('qualityLevels')) {
  videojs.registerPlugin('qualityLevels', qualityLevels);
}
if (!videojs.getPlugin('hlsQualitySelector')) {
  videojs.registerPlugin('hlsQualitySelector', qualitySelector);
}

// Watch tracking used to persist a per-browser viewer id ('3speak_viewer_id') in
// localStorage, which made every browser a stable, trackable device across visits.
// It is gone — a watch session is identified only by the server-issued `sid`, held
// in memory for the duration of the watch. Evict the leftover from browsers that
// still carry one.
try { localStorage.removeItem('3speak_viewer_id'); } catch { /* storage disabled */ }

// Initialize Video.js player
let player;
let scrubPreview = null; // YouTube-style low-res seek-bar preview (created with the player)
let scrubPreviewEnabled = true; // on by default; disable with ?preview=0/false/no
let heatmapBar = null; // "most replayed" seek-bar heatmap (created with the player)
// Server-side ad insertion. Holds the mapping from the player's (stitched) timeline
// back to content time — see src/adBreak.js for why that matters.
const adBreak = createAdBreak();
let heatmapEnabled = true; // on by default; disable with ?heatmap=0/false/no
let currentVideoData = null;
let isDebugMode = false;
let shouldAutoplay = false;
let shouldShowControls = true; // Controls visible by default
let isChrome = false; // Detected once at startup for performance
let isTVMode = false; // TV mode disables video.js hotkeys, Enter toggles fullscreen
let shouldStartMuted = false; // Start player muted (parent can unmute via postMessage)
// intendedMuted tracks the mute state WE want, not what Video.js reports.
// Video.js can silently reset player.muted() during source changes / HLS setup.
// The play handler uses this flag to re-enforce the correct mute state before playing.
let intendedMuted = false;
let shouldLoop = false; // Loop video playback (seek to start on ended)
let videoIsVertical = false; // Tracks video orientation for screen.orientation.lock
let shouldShowCaptions = true; // Show captions by default (captions=0 disables)
let skipViewCount = false; // /play route or ?noview=1 → don't increment the view counter (watch-duration tracking still runs)

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
    muted: shouldStartMuted,
    fluid: !isFixedLayout,        // DISABLE fluid in mobile/square layouts
    responsive: !isFixedLayout,   // DISABLE responsive too
    playbackRates: [0.5, 1, 1.5, 2],
    userActions: {
      hotkeys: !isTVMode,  // Disable hotkeys in TV mode (we handle Enter for fullscreen)
      click: true  // Enable tap/click on video to play/pause
    },
    controlBar: {
      volumePanel: {
        inline: true
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

  debugLog('Player muted state from constructor:', player.muted(), '(shouldStartMuted:', shouldStartMuted, ')');

  // Apply loop — video.js native loop replays seamlessly without ended event
  if (shouldLoop) {
    player.loop(true);
    debugLog('Player looping enabled via URL parameter');
  }

  // Initialize quality selector plugin
  player.hlsQualitySelector({
    displayCurrentQuality: true,
  });

  // YouTube-style scrub preview above the seek bar (only meaningful when the
  // control bar / seek bar is present). A video already loaded before this
  // point gets its source applied immediately.
  if (shouldShowControls && scrubPreviewEnabled) {
    try {
      scrubPreview = createScrubPreview(player);
      if (currentVideoData && currentVideoData.videoUrl) {
        scrubPreview.setSource(currentVideoData.videoUrl);
      }
    } catch (e) {
      console.warn('Scrub preview init failed:', e);
    }
  }

  // "Most replayed" heatmap above the seek bar (same gating as the scrub preview).
  if (shouldShowControls && heatmapEnabled) {
    try {
      heatmapBar = createHeatmap(player);
      if (currentVideoData && currentVideoData.owner && currentVideoData.permlink) {
        heatmapBar.setVideo(currentVideoData.owner, currentVideoData.permlink, currentVideoData.type);
      }
    } catch (e) {
      console.warn('Heatmap init failed:', e);
    }
  }

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
      if (shouldStartMuted) {
        // URL requested muted start — just play muted, don't try unmuted first
        debugLog('Autoplay: mute param set, playing muted');
        player.muted(true);
        player.play().catch(function(err) {
          debugLog('Muted autoplay failed:', err.message);
        });
      } else if (isChrome) {
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
    
    // Increment view count on first play (unless /play route or ?noview=1)
    if (currentVideoData && !player.hasIncrementedView && !skipViewCount) {
      incrementViewCount(currentVideoData);
      player.hasIncrementedView = true;
    }

    // Open a server-measured watch-duration session on first play (always —
    // independent of the view counter, so /play still tracks duration).
    if (currentVideoData && !player.hasStartedWatchSession) {
      player.hasStartedWatchSession = true;
      startWatchSession(currentVideoData);
    }

    // Learn where the cut actually landed. Until this resolves, contentTime() is the
    // identity — under-reporting the offset for a second beats subtracting a guess.
    if (adBreak.active && !adBreak.resolved) {
      adBreak.resolve().then((w) => { if (w) debugLog('Sponsor break at', w); });
    }


    // Self-heal duration on first play — see maybeHealDuration for why this
    // isn't just `player.duration()` read synchronously here.
    if (currentVideoData && currentVideoData.type === 'embed' && !player.hasHealedDuration) {
      maybeHealDuration(currentVideoData);
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
    // Final measured beat for the sliver since the last one, so a viewer who
    // pauses is credited up to the pause point.
    watchBeat();
  });

  player.on('ended', function() {
    debugLog('Video ended');
    updatePlayerState('Ended');
    showReplayButton();
    // Capture the tail — a short video that ends before the first interval
    // still gets a genuine watched-duration row.
    watchBeat();
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
          console.warn('[3Speak Player] Too many stalls - switching to fallback gateway:', currentVideoData.videoUrlFallback);
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

  // Consolidated timeupdate handler — single listener for buffer cleanup + postMessage
  let lastTimeUpdate = 0;
  const isInIframe = window.parent !== window;
  player.on('timeupdate', function() {
    const currentTime = player.currentTime();

    // Watch-duration heartbeat — timeupdate only fires while the video is
    // genuinely advancing (not when paused), so it doubles as our "still
    // watching" signal. Beat at most once per interval; the server measures the
    // real wall-clock gap between beats.
    const W = player.watch;
    if (W && W.sid && Date.now() - W.lastBeatAt >= W.beatMs) {
      watchBeat();
    }

    // Disclosure. Required by EU and US advertising rules, and rendered in the
    // player's own chrome rather than as a separate element a filter list could
    // strip without breaking playback.
    if (adBreak.active) {
      const inside = adBreak.isInside(currentTime);
      updateSponsorLabel(inside);
      // Hide the scrubber while the SPOT is on screen. An advertiser paying for a
      // five-second spot should not be handed a drag handle straight past it, and a
      // timeline that still moves invites exactly that.
      //
      // 🚨 ROLL ONLY. isInside() reads the roll window; a banner has its own
      // (isBannerVisible) and deliberately does not come through here. A banner is
      // painted into the creator's video while it plays normally — taking the
      // timeline away then would be removing a control from ordinary playback.
      setRollChrome(inside);
      // A mid-roll that arrives with no warning is the part viewers resent most. A
      // few seconds' notice costs the advertiser nothing and turns an interruption
      // into a beat. Never while the spot is already playing.
      const left = inside ? null : adBreak.secondsUntil(currentTime);
      updateAdCountdown(left != null && left <= AD_COUNTDOWN_FROM ? Math.max(1, Math.ceil(left)) : null);
      // Skip: on screen for the WHOLE spot, counting down first and pressable after.
      // A button that appears partway through is one nobody is looking for.
      updateSkipControl(inside && adBreak.skipOffered
        ? { until: adBreak.secondsUntilSkip(currentTime), ready: adBreak.canSkip(currentTime) }
        : null);
    }
    // The banner is independent of the spot: it can run on a playback with no spot
    // at all, so it is driven on its own terms.
    updateBannerClick(adBreak.isBannerVisible(currentTime));

    // Periodic buffer cleanup for Mac OS (every 5 seconds during playback)
    if (isMac) {
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
    }

    // Send time updates to parent window for external timeline control
    // Throttle to ~4 updates per second to avoid flooding
    if (isInIframe) {
      const now = Date.now();
      if (now - lastTimeUpdate >= 250) {
        lastTimeUpdate = now;

        window.parent.postMessage({
          type: '3speak-timeupdate',
          currentTime: currentTime,
          duration: player.duration(),
          paused: player.paused(),
          muted: player.muted(),
          volume: player.volume()
        }, '*');
      }
    }
  });

  // Flush a final measured watch beat when the tab is hidden/closed (sendBeacon
  // survives unload) so the last watched sliver isn't lost.
  const flushWatchBeat = () => { if (player && player.watch && player.watch.sid) watchBeat(true); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWatchBeat();
  });
  window.addEventListener('pagehide', flushWatchBeat);

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
        console.log('[3Speak Player] MEDIA_ERR_DECODE - Trying fallback gateway:', currentVideoData.videoUrlFallback);
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
      console.log('[3Speak Player] Network/CORS error - Trying fallback gateway:', currentVideoData.videoUrlFallback);
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

  // Log when player starts loading a source
  player.on('loadstart', function() {
    debugLog('Loadstart - Current source:', player.currentSrc());
  });

  // Log when data is loaded
  player.on('loadeddata', function() {
    debugLog('Loaded successfully - Source:', player.currentSrc());
  });

  // Track muted state changes
  player.on('volumechange', function() {
    debugLog('VOLUMECHANGE: muted=' + player.muted() + ', volume=' + player.volume());
    if (window.parent !== window) {
      window.parent.postMessage({
        type: '3speak-volumechange',
        muted: player.muted(),
        volume: player.volume()
      }, '*');
    }
  });

  // Listen for postMessage commands from parent window (for TV/iframe control)
  window.addEventListener('message', function(event) {
    debugLog('Received postMessage from:', event.origin, 'data:', event.data);

    if (!player) {
      debugLog('Player not ready, ignoring message');
      return;
    }

    const data = event.data;
    if (!data) {
      return;
    }

    // Handle different message formats that parent might send
    const command = data.type || data.action || data.command;

    debugLog('Received postMessage command:', command, data);

    switch (command) {
      case 'play':
      case 'playVideo':
        // Use intendedMuted (our tracked state) instead of player.muted().
        // Video.js can silently reset player.muted() during source/HLS setup,
        // so player.muted() is unreliable. intendedMuted is always correct.
        debugLog('Play command, intendedMuted:', intendedMuted, ', player.muted():', player.muted());

        // Re-enforce the intended mute state before playing
        player.muted(intendedMuted);

        if (intendedMuted) {
          // Muted — just play, no unmute attempt
          player.play().catch(function(err) {
            debugLog('Muted play failed:', err.message);
          });
        } else {
          // Unmuted — try with sound, fall back to muted if blocked
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
        intendedMuted = true;
        player.muted(true);
        break;
      case 'unmute':
        intendedMuted = false;
        player.muted(false);
        break;
      case 'toggleMute':
        intendedMuted = !intendedMuted;
        player.muted(intendedMuted);
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
      case 'lock-orientation':
        // Lock screen orientation based on video dimensions
        // Portrait videos → lock portrait, landscape videos → lock landscape
        if (screen.orientation && screen.orientation.lock) {
          var orientationType = videoIsVertical ? 'portrait' : 'landscape';
          screen.orientation.lock(orientationType).then(function() {
            debugLog('Screen orientation locked to', orientationType);
          }).catch(function(err) {
            debugLog('Screen orientation lock failed:', err.message);
          });
        } else {
          debugLog('Screen orientation lock API not available');
        }
        break;
      case 'unlock-orientation':
        // Unlock screen orientation
        if (screen.orientation && screen.orientation.unlock) {
          screen.orientation.unlock();
          debugLog('Screen orientation unlocked');
        }
        break;
      case 'fullscreen-entered':
        // Parent entered CSS fullscreen, make player fill the container
        debugLog('Parent CSS fullscreen entered, enabling fill mode');
        player.fill(true);
        player.fluid(false);
        // Force dimensions
        player.width('100%');
        player.height('100%');
        // Add class for CSS override
        document.body.classList.add('tv-fullscreen-mode');
        break;
      case 'fullscreen-exited':
        // Parent exited CSS fullscreen, restore normal mode
        debugLog('Parent CSS fullscreen exited, restoring layout');
        // Remove class first
        document.body.classList.remove('tv-fullscreen-mode');
        // Reset inline styles on player-wrapper
        var playerWrapper = document.querySelector('.player-wrapper');
        if (playerWrapper) {
          playerWrapper.style.width = '';
          playerWrapper.style.height = '';
          playerWrapper.style.paddingBottom = '';
          playerWrapper.style.maxHeight = '';
        }
        // Reset inline styles on player element
        var playerEl = player.el();
        if (playerEl) {
          playerEl.style.position = '';
          playerEl.style.top = '';
          playerEl.style.left = '';
          playerEl.style.width = '';
          playerEl.style.height = '';
        }
        // Reset inline styles on video tech element
        var techEl = player.tech({ IWillNotUseThisInPlugins: true });
        if (techEl && techEl.el()) {
          techEl.el().style.width = '';
          techEl.el().style.height = '';
          techEl.el().style.position = '';
          techEl.el().style.top = '';
          techEl.el().style.left = '';
          techEl.el().style.transform = '';
        }
        // Check if we're in a fixed layout mode
        var isFixedLayoutOnExit = document.body.classList.contains('layout-mobile') ||
                                   document.body.classList.contains('layout-square') ||
                                   document.body.classList.contains('layout-desktop');
        // Restore player modes
        player.fill(false);
        // Only enable fluid mode if NOT in a fixed layout
        // Fixed layouts use CSS padding-bottom for aspect ratio - fluid mode calculates wrong dimensions
        if (!isFixedLayoutOnExit) {
          player.fluid(true);
          debugLog('Fluid mode restored (no fixed layout)');
        } else {
          debugLog('Skipping fluid mode (fixed layout handles aspect ratio via CSS)');
        }
        // Force player to recalculate dimensions
        player.width('');
        player.height('');
        // Trigger resize to recalculate layout
        setTimeout(function() {
          player.trigger('resize');
          player.trigger('playerresize');
          window.dispatchEvent(new Event('resize'));
          debugLog('Triggered resize events');
        }, 100);
        break;
      case 'setVolume':
      case 'set-volume':
        if (typeof data.volume === 'number') {
          // Clamp volume between 0 and 1
          var vol = Math.max(0, Math.min(1, data.volume));
          player.volume(vol);
          // Unmute if setting volume > 0
          if (vol > 0 && player.muted()) {
            intendedMuted = false;
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
          intendedMuted = false;
          player.muted(false);
        }
        break;
      case 'volumeDown':
      case 'volume-down':
        var currentVolDown = player.volume();
        var stepDown = data.step || 0.1;
        player.volume(Math.max(0, currentVolDown - stepDown));
        break;
      case 'toggle-pip':
      case 'togglePip':
        var videoEl = player.tech({ IWillNotUseThisInPlugins: true }).el();
        // tech.el() returns the wrapper div; get the actual <video> inside it
        if (videoEl && videoEl.tagName !== 'VIDEO') {
          videoEl = videoEl.querySelector('video');
        }
        debugLog('PiP toggle — videoEl:', videoEl?.tagName, 'pipEnabled:', document.pictureInPictureEnabled, 'current:', document.pictureInPictureElement);
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(function(err) {
            debugLog('Exit PiP failed:', err.message);
          });
        } else if (videoEl && videoEl.requestPictureInPicture) {
          videoEl.requestPictureInPicture().catch(function(err) {
            debugLog('Enter PiP failed:', err.message);
          });
        } else {
          debugLog('PiP not available — no video element or requestPictureInPicture not supported');
        }
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
            intendedMuted: intendedMuted,
            volume: player.volume(),
            ended: player.ended()
          }, '*');
        }
        break;
      case 'getQualityLevels':
      case 'get-quality-levels':
        if (window.parent !== window) {
          var ql = player.qualityLevels();
          var levels = [];
          var activeIndex = -1; // -1 = auto
          if (ql && ql.length > 0) {
            for (var qi = 0; qi < ql.length; qi++) {
              levels.push({
                index: qi,
                height: ql[qi].height || 0,
                width: ql[qi].width || 0,
                bitrate: ql[qi].bitrate || 0,
                label: ql[qi].height ? (ql[qi].height + 'p') : ('Level ' + qi),
                enabled: ql[qi].enabled !== false
              });
              // If only one level is enabled, that's the active one
            }
            // Detect active: if exactly one level is enabled, that's the selected one
            var enabledCount = levels.filter(function(l) { return l.enabled; }).length;
            if (enabledCount === 1) {
              activeIndex = levels.findIndex(function(l) { return l.enabled; });
            }
          }
          window.parent.postMessage({
            type: '3speak-quality-levels',
            levels: levels,
            currentIndex: activeIndex
          }, '*');
        }
        break;
      case 'setQualityLevel':
      case 'set-quality-level':
        var qlSet = player.qualityLevels();
        if (qlSet && qlSet.length > 0) {
          var targetLevel = data.level;
          if (targetLevel === -1 || targetLevel === 'auto') {
            // Auto: enable all levels
            for (var ai = 0; ai < qlSet.length; ai++) {
              qlSet[ai].enabled = true;
            }
            debugLog('Quality set to auto (all levels enabled)');
          } else if (typeof targetLevel === 'number' && targetLevel >= 0 && targetLevel < qlSet.length) {
            // Specific level: enable only that one
            for (var si = 0; si < qlSet.length; si++) {
              qlSet[si].enabled = (si === targetLevel);
            }
            debugLog('Quality set to level', targetLevel, '(' + (qlSet[targetLevel].height || '?') + 'p)');
          }
          // Notify parent of the change
          if (window.parent !== window) {
            window.parent.postMessage({
              type: '3speak-quality-changed',
              level: targetLevel
            }, '*');
          }
        }
        break;
      case 'setCaptions':
      case 'set-captions':
        if (shouldShowCaptions) {
          var captionLang = data.lang || null;
          subtitleManager.selectLanguage(captionLang);
        }
        break;
      case 'getCaptionLanguages':
      case 'get-caption-languages':
        if (window.parent !== window) {
          window.parent.postMessage({
            type: '3speak-caption-languages',
            languages: subtitleManager.availableLanguages,
            selectedLang: subtitleManager.selectedLang
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
  const path = window.location.pathname;
  // Route → video type: /embed → embed, /watch → legacy, /play → embed (or
  // ?type=legacy). The /play route (and ?noview=1) plays without counting a
  // view — watch-duration tracking still runs.
  let type;
  if (path.includes('/embed')) type = 'embed';
  else if (path.includes('/play')) type = params.get('type') === 'legacy' ? 'legacy' : 'embed';
  else type = 'legacy';
  const noview = path.includes('/play')
    || ['1', 'true', 'yes'].includes((params.get('noview') || '').toLowerCase());
  return {
    video: params.get('v'),
    type,
    noview,
    // Live OpenPods playback: `?live=<roomName>` streams a running standalone
    // OpenPods session over WebRTC (LiveKit) instead of HLS. `api`/`lk` let an
    // embedder point at a different hangouts API / LiveKit server.
    live: params.get('live') || params.get('room'),
    api: params.get('api'), // hangouts API base override (default preview)
    lk: params.get('lk'), // LiveKit ws URL override (default preview)
    mode: params.get('mode'), // 'iframe' for minimal embedding UI
    layout: params.get('layout'), // 'mobile', 'square', or 'desktop' (default)
    debug: params.get('debug'),
    noscroll: params.get('noscroll'), // '1' or 'true' to disable scrollbars
    autoplay: params.get('autoplay'), // '1' or 'true' to autoplay (muted)
    controls: params.get('controls'), // '0' or 'false' to hide controls
    tvmode: params.get('tvmode'), // '1' or 'true' for TV mode (Enter key toggles fullscreen)
    mute: params.get('mute'), // '1' or 'true' to start player muted (parent can unmute via postMessage)
    loop: params.get('loop'), // '1' or 'true' to loop video playback
    captions: params.get('captions'), // '0' or 'false' to disable captions
    preview: params.get('preview'), // '0' or 'false' to disable the seek-bar scrub preview (on by default)
    heatmap: params.get('heatmap') // '0' or 'false' to disable the "most replayed" heatmap (on by default)
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

// When there's no video entry for `v`, ask our own backend to resolve it as a
// live OpenPods stream. The backend probes the configured stream endpoints
// (STREAM_ENDPOINTS env) and returns { found, roomName, api, lk, host, … } so
// the embed URL stays identical to any other video and integrators change
// nothing — the player does all the routing.
async function resolveStream(videoParam) {
  if (!videoParam) return null;
  try {
    const res = await fetch(`/api/stream?v=${encodeURIComponent(videoParam)}`);
    // Parse the body even on 404 — a miss may still carry { endedStream: true }
    // when the id is a stream POST whose room has already closed.
    return await res.json().catch(() => null);
  } catch (error) {
    debugLog('Stream resolve failed', error?.message);
    return null;
  }
}

// Self-heal duration: update DB if stored duration is null/0/wrong
async function healDuration(videoData, realDuration) {
  try {
    const response = await fetch('/api/duration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: videoData.owner,
        permlink: videoData.permlink,
        duration: realDuration
      })
    });
    if (response.ok) {
      const payload = await response.json();
      if (payload.success) {
        debugLog(`Duration healed: ${realDuration}s`);
      } else {
        debugLog('Duration heal request accepted but not applied');
      }
    }
  } catch (error) {
    console.error('Error healing duration:', error);
  }
}

// Under HLS/MSE, player.duration() read right at 'play' (which fires right
// after 'loadedmetadata') can transiently report only the span of segments
// buffered so far — not the full manifest total — until VHS reconciles it a
// moment later via 'durationchange'. Reading it synchronously is how a
// 120s video was self-healed down to 6s in production. This waits for two
// consecutive equal readings (or a short timeout) before trusting the number.
function getStableDuration(maxWaitMs = 1500) {
  return new Promise((resolve) => {
    const first = player.duration();
    if (!isFinite(first) || first <= 0) {
      resolve(undefined);
      return;
    }

    let lastSeen = first;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      player.off('durationchange', onChange);
      clearTimeout(timer);
      resolve(value);
    };

    const onChange = () => {
      const next = player.duration();
      if (!isFinite(next) || next <= 0) return;
      if (next === lastSeen) {
        // Same value seen twice in a row (this change + the prior baseline) — stable.
        finish(next);
      }
      lastSeen = next;
    };
    player.on('durationchange', onChange);

    // No further durationchange within the window — treat the last value seen as stable.
    const timer = setTimeout(() => finish(lastSeen), maxWaitMs);
  });
}

// Self-heal duration on first play, but guarded against the read-too-early
// race above: growing a missing/zero stored duration is safe to do off a
// single read (there's nothing to corrupt), but SHRINKING an already-stored
// duration — the exact shape of the bug — waits for a stabilized reading
// first, so a transient short buffer-span never overwrites a good value.
async function maybeHealDuration(videoData) {
  const storedDuration = videoData.duration || 0;
  const firstRead = player.duration();

  if (storedDuration && isFinite(firstRead) && firstRead > 0 && firstRead < storedDuration - 1) {
    // Would shrink the stored duration — get a stabilized reading before acting.
    const stable = await getStableDuration();
    player.hasHealedDuration = true;
    if (stable && isFinite(stable) && stable > 0 && Math.abs(storedDuration - stable) > 1) {
      healDuration(videoData, stable);
    }
    return;
  }

  if (isFinite(firstRead) && firstRead > 0) {
    if (!storedDuration || Math.abs(storedDuration - firstRead) > 1) {
      healDuration(videoData, firstRead);
    }
    player.hasHealedDuration = true;
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

// ---------------------------------------------------------------------------
// Watch-duration heartbeat (server-measured, anti-forge).
// Mirrors the snapieaudio listen tracker: /api/watch/start opens a server-side
// session bound to (sid, owner, permlink, ip) via an HMAC token; /api/watch/beat
// is sent (throttled) while the video is genuinely playing. The server credits
// only the real wall-clock gap it measures between beats, so watch time can't be
// forged with a single request. Each session upserts ONE row into `view-durations`
// with watchedSeconds + watchedPct + ip + video. Runs regardless of the view
// counter — /play tracks duration without counting a view.
// ---------------------------------------------------------------------------
/**
 * Show or hide the Sponsored label over the break.
 *
 * Created lazily inside the player element so it inherits fullscreen and sits above
 * the video. Text comes from the server (`ad.label`) rather than being hardcoded, so
 * the wording can change without shipping a player build.
 */
let sponsorLabelEl = null;
let sponsorResumeEl = null;
let sponsorBuiltFor = null;

/**
 * Player chrome while a video roll is on screen. A class on the player root, so the
 * decision lives in CSS and nothing has to remember which controls were hidden in
 * order to put them back.
 */
function setRollChrome(inside) {
  const host = player && player.el && player.el();
  if (!host) return;
  host.classList.toggle('vjs-roll-playing', !!inside);
}

function updateSponsorLabel(show) {
  if (!show) {
    if (sponsorLabelEl) sponsorLabelEl.style.display = 'none';
    return;
  }
  const host = player && player.el && player.el();
  if (!host) return;
  const info = adBreak.info || {};
  const brand = info.brand || {};

  // Rebuilt only when the spot changes, not on every timeupdate: the countdown is
  // the one part that ticks, and it is updated in place below.
  if (!sponsorLabelEl || sponsorBuiltFor !== info.sid) {
    if (sponsorLabelEl && sponsorLabelEl.parentNode) sponsorLabelEl.parentNode.removeChild(sponsorLabelEl);
    sponsorBuiltFor = info.sid;

    // An anchor when there is somewhere to go, a plain div otherwise, so the
    // overlay never looks clickable while doing nothing. The href points at the
    // stitcher, which counts the click and then redirects — the advertiser's real
    // address is never in the page.
    const clickUrl = brand.clickUrl || null;
    sponsorLabelEl = document.createElement(clickUrl ? 'a' : 'div');
    sponsorLabelEl.className = 'vjs-sponsor-note' + (clickUrl ? ' vjs-sponsor-link' : '');
    if (clickUrl) {
      sponsorLabelEl.href = clickUrl;
      sponsorLabelEl.target = '_blank';
      sponsorLabelEl.rel = 'noopener noreferrer';
      sponsorLabelEl.setAttribute(
        'aria-label',
        'Open ' + (brand.productName || 'the advertiser') + "'s website in a new tab",
      );
      // videojs swallows clicks on its own surface, and a click here must never
      // also toggle play/pause.
      sponsorLabelEl.addEventListener('click', (e) => e.stopPropagation());
    }

    const from = document.createElement('span');
    from.className = 'vjs-sponsor-from';
    from.textContent = brand.account ? 'Advertisement from @' + brand.account : (info.label || 'Sponsored');
    sponsorLabelEl.appendChild(from);

    if (brand.productName || brand.slogan || brand.logoUrl) {
      const body = document.createElement('div');
      body.className = 'vjs-sponsor-body';

      const logo = document.createElement(brand.logoUrl ? 'img' : 'span');
      logo.className = 'vjs-sponsor-logo';
      if (brand.logoUrl) { logo.src = brand.logoUrl; logo.alt = ''; logo.loading = 'lazy'; }
      body.appendChild(logo);

      const text = document.createElement('div');
      text.className = 'vjs-sponsor-text';
      if (brand.productName) {
        const n = document.createElement('strong');
        n.className = 'vjs-sponsor-name';
        n.textContent = brand.productName;
        text.appendChild(n);
      }
      if (brand.slogan) {
        const sl = document.createElement('span');
        sl.className = 'vjs-sponsor-slogan';
        sl.textContent = brand.slogan;
        text.appendChild(sl);
      }
      body.appendChild(text);
      sponsorLabelEl.appendChild(body);
    }

    sponsorResumeEl = document.createElement('span');
    sponsorResumeEl.className = 'vjs-sponsor-resume';
    sponsorLabelEl.appendChild(sponsorResumeEl);

    host.appendChild(sponsorLabelEl);
  }

  // The wait, ticking in whole seconds. Held at "in a moment" rather than 0: the
  // last tick is over before the number could be read.
  const t = (player && isFinite(player.currentTime())) ? player.currentTime() : 0;
  const remain = adBreak.secondsRemaining(t);
  if (sponsorResumeEl) {
    sponsorResumeEl.textContent = remain == null
      ? ''
      : (Math.ceil(remain) > 0 ? 'Video continues in ' + Math.ceil(remain) + 's' : 'Video continues in a moment');
  }

  sponsorLabelEl.style.display = 'flex';
}

/** How many seconds of warning a viewer gets before the break. */
const AD_COUNTDOWN_FROM = 3;

/**
 * The pre-roll warning: "Ad in 3" counting down to the break.
 *
 * Deliberately separate from the disclosure overlay: it appears BEFORE the spot,
 * belongs to the content the viewer is still watching, and sits in the opposite
 * corner so it never covers the disclosure that follows it.
 */
let adCountdownEl = null;
function updateAdCountdown(secs) {
  if (secs == null) {
    if (adCountdownEl) adCountdownEl.style.display = 'none';
    return;
  }
  if (!adCountdownEl) {
    const host = player && player.el && player.el();
    if (!host) return;
    adCountdownEl = document.createElement('div');
    adCountdownEl.className = 'vjs-ad-countdown';
    host.appendChild(adCountdownEl);
  }
  adCountdownEl.textContent = 'Ad in ' + secs;
  adCountdownEl.style.display = 'block';
}

/**
 * A click target over the burned-in banner.
 *
 * The banner itself is composited into the video by the stitcher, so there is
 * nothing here to draw — only somewhere to click. Positioned from the placement
 * percentages the server reports rather than guessed, so the target sits exactly
 * where the pixels are, and only while the banner is actually on screen.
 */
let bannerClickEl = null;
// The close button that sits with it. Built and torn down together.
let bannerCloseEl = null;
/* How much playback to leave untouched when a banner is closed.
 *
 * 🚨 MEASURED, not guessed. We know nothing about the viewer's connection or device,
 * and any fixed number is wrong for somebody: too small on a phone on a bad signal and
 * it stalls, large enough for that phone and the banner outstays its welcome on fibre.
 *
 * The player already knows what it needs. VHS measures its own throughput, and the
 * playlist declares the rendition's bitrate and segment length, so how long a
 * replacement segment takes is arithmetic rather than a hunch:
 *
 *     seconds to fetch one segment = segment length x rendition bitrate / throughput
 *
 * The margin is a segment (the one being played through) plus several fetches' worth
 * of slack, so a connection that is just barely keeping up still gets its replacement
 * in time. Clamped at both ends: never less than a segment and a half, because
 * anything under that cannot survive a single slow response, and never more than half
 * a minute, because past that the banner has effectively not been closed.
 *
 * Falls back to a deliberately generous number when the measurements are missing. An
 * over-long margin costs a few extra seconds of banner; a short one costs a stall,
 * and only one of those is worth avoiding. */
const BANNER_MARGIN_MIN_S = 9;
const BANNER_MARGIN_MAX_S = 30;
const BANNER_MARGIN_FALLBACK_S = 15;

function bannerRemoveMargin(tech) {
  try {
    const vhs = tech && tech.vhs;
    const media = vhs && vhs.playlists && vhs.playlists.media && vhs.playlists.media();
    const target = Number(media && media.targetDuration) || 0;
    // What VHS has actually measured, in bits per second.
    const throughput = Number(vhs && vhs.bandwidth) || 0;
    // What this rendition costs, from the playlist itself.
    const bitrate = Number(media && media.attributes && media.attributes.BANDWIDTH) || 0;
    if (!target || !throughput || !bitrate) return BANNER_MARGIN_FALLBACK_S;

    const fetchSeconds = (target * bitrate) / throughput;
    // One segment to play through, plus three fetches of slack. Three because a single
    // slow response should not be able to catch us out, and the cost of being wrong in
    // this direction is only that the banner lingers.
    const wanted = target + (fetchSeconds * 3);
    return Math.min(BANNER_MARGIN_MAX_S, Math.max(BANNER_MARGIN_MIN_S, wanted));
  } catch (_) {
    return BANNER_MARGIN_FALLBACK_S;
  }
}
let bannerBuiltFor = null;
/**
 * The Skip control on a spot: bottom-right, above the control bar.
 *
 * One element with two states so it never moves under the cursor. Waiting is a plain
 * div, not a button: a control that looks pressable and does nothing is worse than one
 * that plainly is not ready yet.
 *
 * Pressing it tells the server (which counts the spot as watched, since the button only
 * exists after the threshold) and seeks to the end of the break. The spot is spliced
 * INTO the playlist, so moving the playhead past it is the whole of skipping.
 */
let skipEl = null;
function updateSkipControl(state) {
  if (!state) {
    if (skipEl) skipEl.style.display = 'none';
    return;
  }
  const host = player && player.el && player.el();
  if (!host) return;
  if (!skipEl) {
    skipEl = document.createElement('button');
    skipEl.type = 'button';
    skipEl.className = 'vjs-ad-skip';
    // Must not also reach the video surface, or the click toggles play/pause.
    skipEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (skipEl.dataset.ready !== '1') return;
      try { adBreak.recordSkip(); } catch (_) { /* the skip still happens */ }
      const to = adBreak.endOfBreak();
      if (isFinite(to)) { try { player.currentTime(to); } catch (_) { /* it plays out */ } }
    });
    host.appendChild(skipEl);
  }
  const ready = !!state.ready;
  skipEl.dataset.ready = ready ? '1' : '0';
  skipEl.className = 'vjs-ad-skip' + (ready ? ' vjs-ad-skip-ready' : ' vjs-ad-skip-waiting');
  skipEl.textContent = ready
    ? 'Skip ad'
    : 'Skip in ' + Math.max(1, Math.ceil(Number(state.until) || 0));
  skipEl.style.display = 'inline-flex';
}

function updateBannerClick(show) {
  const info = adBreak.bannerInfo;
  const clickUrl = info && info.brand && info.brand.clickUrl;
  if (!show || !clickUrl) {
    if (bannerClickEl) bannerClickEl.style.display = 'none';
    if (bannerCloseEl) bannerCloseEl.style.display = 'none';
    return;
  }
  if (!bannerClickEl || bannerBuiltFor !== clickUrl) {
    if (bannerClickEl && bannerClickEl.parentNode) bannerClickEl.parentNode.removeChild(bannerClickEl);
    const host = player && player.el && player.el();
    if (!host) return;
    bannerBuiltFor = clickUrl;
    bannerClickEl = document.createElement('a');
    bannerClickEl.className = 'vjs-banner-click';
    bannerClickEl.href = clickUrl;
    bannerClickEl.target = '_blank';
    bannerClickEl.rel = 'noopener noreferrer';
    bannerClickEl.setAttribute(
      'aria-label',
      'Open ' + ((info.brand && info.brand.productName) || info.advertiser || 'the advertiser') + "'s website in a new tab",
    );
    // Must not also reach the video surface, or the click toggles play/pause.
    bannerClickEl.addEventListener('click', (e) => e.stopPropagation());

    const pl = info.placement || {};
    // Percentages of the FRAME, which is what the stitcher burned against, so the
    // target tracks the banner through resizes and fullscreen without recalculating.
    const widthPct = Number(pl.widthPct) || 60;
    const bottomPct = Number(pl.bottomPct) || 6;
    const aspect = Number(pl.aspect) || 5.6;
    const maxHeightPct = Number(pl.maxHeightPct) || 15;
    bannerClickEl.style.width = widthPct + '%';
    bannerClickEl.style.bottom = bottomPct + '%';
    bannerClickEl.style.aspectRatio = String(aspect);
    bannerClickEl.style.maxHeight = maxHeightPct + '%';
    host.appendChild(bannerClickEl);

    /* Close, just above the banner's top-right corner.
     *
     * OUTSIDE the click target, deliberately: inside it, closing an ad would also
     * open the ad. A sibling positioned against the same host, offset off the top of
     * the banner box so it never covers the advertiser's artwork.
     */
    bannerCloseEl = document.createElement('button');
    bannerCloseEl.type = 'button';
    bannerCloseEl.className = 'vjs-banner-close';
    bannerCloseEl.setAttribute('aria-label', 'Close this ad');
    bannerCloseEl.title = 'Close this ad';
    bannerCloseEl.textContent = '\u00d7';
    bannerCloseEl.style.right = ((100 - widthPct) / 2) + '%';
    bannerCloseEl.style.bottom = 'calc(' + bottomPct + '% + ' + maxHeightPct + '%)';
    bannerCloseEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissBanner();
    });
    host.appendChild(bannerCloseEl);
  }
  bannerClickEl.style.display = 'block';
  if (bannerCloseEl) bannerCloseEl.style.display = 'flex';
}

/**
 * Close the banner: swap the source, do not try to un-burn what is downloaded.
 *
 * 🚨 The covered seconds keep the SAME segment urls whether or not a banner is on
 * them, so dropping the buffer just refetches the burned bytes and the browser serves
 * them from its own cache. A dismissed session's playlist points those seconds at the
 * CDN original instead, so RELOADING THE SOURCE genuinely changes which files play.
 *
 * The dismiss request is awaited: the playlist is only clean once the server knows, and
 * reloading first is a race the viewer loses about half the time.
 *
 * A spot already passed is retired, because reloading walks the playhead through zero
 * and a spot booked at the start of the video is inside its own window there. Its
 * chrome would otherwise come back over a video that is merely reloading.
 */
/* Temporary instrumentation for the close-button stall.
 *
 * Four rounds of reasoning about VHS internals have not settled why playback pauses,
 * and the console has shown nothing because nothing is throwing. So this records what
 * the media element actually DOES for ten seconds either side of a dismissal: which
 * events fire, in what order, and where the playhead and the buffer are when they do.
 *
 * Prints one table on demand. Remove once the cause is known. */
function traceDismiss(label) {
  const t0 = Date.now();
  const rows = [];
  const note = (what) => {
    let buffEnd = null;
    try {
      const b = player.buffered();
      buffEnd = b && b.length ? b.end(b.length - 1) : null;
    } catch (_) { /* not ready */ }
    rows.push({
      atMs: Date.now() - t0,
      event: what,
      currentTime: Number(player.currentTime().toFixed(2)),
      paused: player.paused(),
      readyState: (player.readyState && player.readyState()) || null,
      bufferedTo: buffEnd == null ? null : Number(buffEnd.toFixed(2)),
    });
  };
  const events = ['waiting', 'stalled', 'seeking', 'seeked', 'playing', 'pause', 'canplay', 'canplaythrough', 'emptied', 'loadstart', 'progress'];
  const offs = events.map((e) => {
    const fn = () => note(e);
    player.on(e, fn);
    return () => player.off(e, fn);
  });
  note(label);
  setTimeout(() => {
    offs.forEach((off) => off());
    /* eslint-disable no-console */
    console.log('[ad-dismiss] what the player did:');
    console.table(rows);
    /* eslint-enable no-console */
  }, 10000);
}

async function dismissBanner() {
  try { traceDismiss('x clicked'); } catch (_) { /* tracing must never break the close */ }
  if (bannerClickEl) bannerClickEl.style.display = 'none';
  if (bannerCloseEl) bannerCloseEl.style.display = 'none';
  try {
    const at = player && isFinite(player.currentTime()) ? player.currentTime() : null;
    const end = adBreak.endOfBreak();
    if (isFinite(end) && at != null && end <= at) adBreak.retireSpot();

    await adBreak.dismissBanner();

    if (at == null) return;

    /* SEAMLESS PATH: drop the buffer ahead and let VHS refill it.
     *
     * Reloading the source works but tears down the MediaSource, which costs about a
     * second of black. Nothing needs tearing down: the burned segments are served
     * `no-cache`, so a refetch reaches the server, and a dismissed session answers with
     * a 302 to the plain original. Removing the buffered range ahead of the playhead
     * makes VHS refetch exactly those seconds, and they come back without the banner.
     *
     * ⚠️ THE MARGIN IS THE WHOLE TRICK, and it has to be bigger than it looks.
     *
     * It buys the time VHS needs to fetch a replacement segment before the playhead
     * reaches the hole. At a second and a half it did not: a segment is about six
     * seconds and the round trip plus download regularly outruns that, so playback
     * caught up with the gap and stalled — the exact pause the buffer path exists to
     * avoid.
     *
     * A whole segment of runway is the honest number. The cost is that the banner
     * stays a few seconds longer, which is easy to accept because the CONTROLS vanish
     * on the click: the viewer gets their acknowledgement immediately and the picture
     * catches up. A stall is the thing they would actually notice.
     *
     * `sourceUpdater_` is internal, so this is guarded and falls through to the source
     * swap when it is not there — Safari plays HLS natively and has no VHS at all. The
     * Mac buffer cleanup above already leans on the same API, so it is not a new bet.
     */
    try {
      const tech = player.tech({ IWillNotUseThisInPlugins: true });
      const vhs = tech && tech.vhs;
      const su = vhs && vhs.sourceUpdater_;
      if (su && typeof su.remove === 'function') {
        const from = at + bannerRemoveMargin(tech);
        const dur = player.duration();
        const to = isFinite(dur) && dur > from ? dur : from + 600;
        su.remove('video', from, to);
        su.remove('audio', from, to);

        /* 🚨 REMOVING IS NOT ENOUGH. VHS has to be told it no longer has them.
         *
         * The loader tracks which segments it has APPENDED, not what is currently in
         * the buffer, so after a remove it still believes that range is done and never
         * refetches it. Playback simply runs into the hole and stalls — which is why
         * widening the margin only moved the pause later instead of preventing it.
         *
         * resetLoader() clears that bookkeeping (and, unlike resetEverything(), leaves
         * the buffer alone — that one removes from 0 to Infinity and rebuffers the
         * lot). monitorBuffer_() then kicks a refill immediately rather than waiting
         * for the next poll, so the replacement is on its way while the playhead still
         * has its margin to play through. */
        const loader = vhs.mainSegmentLoader_;
        if (loader && typeof loader.resetLoader === 'function') loader.resetLoader();
        if (loader && typeof loader.monitorBuffer_ === 'function') loader.monitorBuffer_();
        return;
      }
    } catch (_) { /* fall through to the source swap */ }

    const wasPlaying = player && !player.paused();
    const current = player.currentSource();
    if (!current || !current.src) return;

    const resume = () => {
      if (!wasPlaying || !player || !player.paused()) return;
      const p = player.play();
      if (p && p.catch) p.catch(() => { /* the viewer can press play */ });
    };

    /* 🚨 LISTEN FIRST, then swap.
     *
     * These were attached after player.src(), and a source that resolves quickly fires
     * loadedmetadata before the next statement runs — so the handler was never called,
     * the position was never restored and playback never resumed. The listener has to
     * exist before the thing it is listening for.
     */
    player.one('loadedmetadata', () => {
      try {
        player.currentTime(at);
        /* Play AFTER the seek lands, not alongside it. play() issued while the player
         * is still seeking is routinely interrupted, and video.js rejects the promise
         * rather than retrying. The timeout is the backstop for a seek that never
         * reports, which is common enough on a fresh MediaSource. */
        player.one('seeked', resume);
        setTimeout(resume, 900);
      } catch (_) { /* the viewer can press play */ }
    });

    // src() already loads in video.js; a second load() here can fire loadedmetadata
    // twice and re-run the seek on top of itself.
    player.src(current);
  } catch (_) { /* the banner runs its course */ }
}

/**
 * Who is watching, if the embedding page told us.
 *
 * The player has no session of its own, so this only works when the page passes
 * `?viewer=<hive account>` — the same shape as the existing `private` flag. Without
 * it a Pro subscriber cannot be recognised and WILL be shown ads, so any surface
 * that knows its viewer has to pass this.
 */
function viewerAccount() {
  const v = (new URLSearchParams(window.location.search).get('viewer') || '').trim().toLowerCase();
  return /^[a-z][a-z0-9.-]{2,15}$/.test(v) ? v : null;
}

/** Where the viewer is in the CONTENT, with any stitched ad time removed. */
function playerContentTime() {
  const t = (player && isFinite(player.currentTime())) ? player.currentTime() : 0;
  return adBreak.active ? adBreak.contentTime(t) : t;
}

async function startWatchSession(videoData) {
  if (!videoData || !videoData.owner || !videoData.permlink) return;
  player.watch = { sid: null, token: null, beatMs: 5000, lastBeatAt: 0, starting: true };
  try {
    // Prefer the STORED duration (from the embed-video doc, via /api/embed or
    // /api/watch) over a live player.duration() read — reading the DOM/MSE
    // duration right as playback starts is exactly the race that used to send
    // a transient ~6s buffer-span instead of the real duration (see
    // getStableDuration's comment). The stored value is only missing for a
    // brand-new upload that hasn't been healed yet, so THAT'S the one case
    // worth waiting on a stabilized live reading for.
    const storedDuration = videoData.duration;
    const realDuration = (storedDuration && isFinite(storedDuration) && storedDuration > 0)
      ? storedDuration
      : await getStableDuration();
    const response = await fetch('/api/watch/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: videoData.owner,
        permlink: videoData.permlink,
        type: videoData.type,
        duration: realDuration,
        position: playerContentTime(),
        source: 'player',
        // Marks the row as ad-free so the inventory forecast stops selling it.
        premium: adBreak.isPremiumViewer,
        private: ['1', 'true', 'yes'].includes((new URLSearchParams(window.location.search).get('private') || '').toLowerCase())
      })
    });
    if (!response.ok) return;
    const data = await response.json();
    // No session when the video has no measurable duration ({ tracked:false }).
    if (!data || !data.sid || !player.watch) return;
    player.watch.sid = data.sid;
    player.watch.token = data.token;
    player.watch.beatMs = (data.beatSeconds || 5) * 1000;
    player.watch.lastBeatAt = Date.now(); // first beat one interval from now
    debugLog('Watch session opened', data.sid);
  } catch (error) {
    debugLog('Could not open watch session:', error);
  } finally {
    if (player.watch) player.watch.starting = false;
  }
}

/**
 * Send one watch heartbeat. Called (throttled) from timeupdate while the video
 * is really advancing, plus a final beat on pause/end/tab-hide. Best-effort —
 * never disrupts playback. Uses sendBeacon on tab-hide so the tail isn't lost.
 */
function watchBeat(useBeacon) {
  const W = player && player.watch;
  if (!W || !W.sid) return;
  W.lastBeatAt = Date.now(); // throttle before the async call so we don't double-fire
  // CONTENT time, not player time. With a spot stitched in, currentTime() runs ahead
  // of the video by the ad's length, and reporting that would credit ad seconds as
  // watch time on the creator's video.
  const position = playerContentTime();
  const rate = (player && player.playbackRate) ? player.playbackRate() : 1;
  const payload = JSON.stringify({ sid: W.sid, token: W.token, position, rate });
  try {
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/watch/beat', new Blob([payload], { type: 'application/json' }));
      return;
    }
    fetch('/api/watch/beat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(() => {});
  } catch (error) {
    // best-effort — never disrupt playback
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
  player.hasHealedDuration = false;
  player.hasStartedWatchSession = false;
  player.watch = null;
  player.triedFallback = false;

  // Set poster/thumbnail if available
  if (videoData.thumbnail) {
    debugLog('Setting thumbnail', videoData.thumbnail);
    player.poster(videoData.thumbnail);
  } else {
    debugLog('No thumbnail available for this video');
  }

  // Ask whether this playback carries a sponsor spot. A stitched manifest plays the
  // ad inline; anything less than a clear yes falls straight through to the content
  // URL, because no ad is always better than no video.
  adBreak.reset();
  let primaryUrl = videoData.videoUrl;
  try {
    // 🚨 NEVER ON A SHORT. The only slot that fits inside a short is a pre-roll, and
    // a 15-second spot in front of a 12-second short delivers an impression to
    // someone who never wanted the content — which is why shorts have their own
    // format (shorts_roll) played BETWEEN them rather than inside one.
    //
    // The shorts FEED honoured this by never asking. This player asks for anything
    // it is handed, so a short opened as an embed got a roll spliced into it. The
    // server refuses too, but not asking is the better fix: it is one condition on
    // data the player already has, and it does not depend on the API being the one
    // that remembers.
    //
    // The FLAG, not the length. Length was never the test — the shorts that surfaced
    // this are 61-68s, past any threshold anyone would pick.
    const stitched = videoData.short === true ? null : await adBreak.request({
      owner: videoData.owner,
      permlink: videoData.permlink,
      viewer: viewerAccount(),
      manifestUrl: videoData.videoUrl,
    });
    if (stitched) {
      primaryUrl = stitched;
      debugLog('Playing with a sponsor break', adBreak.info);
    }
    // Exposed under ?debug=1 only. The Sponsored label is driven by timeupdate,
    // which needs decodable media — so on any browser without H.264 it can never
    // be exercised. Set here rather than on play for exactly that reason.
    if (isDebugMode) window.__3sAdDebug = { adBreak, updateSponsorLabel };
  } catch (_) { /* play the plain video */ }

  // Set video sources with CDN-first fallback chain. The stitched manifest goes
  // FIRST and the original stays right behind it, so a stitcher outage degrades to
  // ordinary playback instead of a dead player.
  const sources = [
    {
      src: primaryUrl,
      type: 'application/x-mpegURL'
    }
  ];
  if (primaryUrl !== videoData.videoUrl) {
    sources.push({ src: videoData.videoUrl, type: 'application/x-mpegURL' });
  }
  
  debugLog('Primary video URL:', videoData.videoUrl);
  
  // Add fallback chain: CDN -> Supernode -> Hotnode -> Audionode
  if (videoData.videoUrlFallback1 && videoData.videoUrlFallback1 !== videoData.videoUrl) {
    sources.push({
      src: videoData.videoUrlFallback1,
      type: 'application/x-mpegURL'
    });
    debugLog('Fallback1 video URL:', videoData.videoUrlFallback1);
  }
  
  if (videoData.videoUrlFallback2 && videoData.videoUrlFallback2 !== videoData.videoUrl) {
    sources.push({
      src: videoData.videoUrlFallback2,
      type: 'application/x-mpegURL'
    });
    debugLog('Fallback2 video URL:', videoData.videoUrlFallback2);
  }
  
  if (videoData.videoUrlFallback3 && videoData.videoUrlFallback3 !== videoData.videoUrl) {
    sources.push({
      src: videoData.videoUrlFallback3,
      type: 'application/x-mpegURL'
    });
    debugLog('Fallback3 video URL:', videoData.videoUrlFallback3);
  }

  player.src(sources);
  player.load();

  // Point the scrub-preview at the same manifest (pinned to lowest rendition).
  if (scrubPreview && videoData.videoUrl) {
    // Always the original: the stitched playlist is per-session and no-store, and
    // scrubbing should preview the video, not the sponsor spot.
    scrubPreview.setSource(videoData.videoUrl);
  }

  // Load the "most replayed" heatmap for this video.
  if (heatmapBar && videoData.owner && videoData.permlink) {
    heatmapBar.setVideo(videoData.owner, videoData.permlink, videoData.type);
  }

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
  videoIsVertical = isVertical; // Store at module level for postMessage orientation commands
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
// Chrome-less, centered message covering the whole player frame — no bright red
// banner, no play button/controls, with the 3Speak logo kept top-left. Fills
// the iframe viewport (position:fixed) so it stays visible even in iframe mode,
// where .player-wrapper has min-height:0 and collapses once the (uninitialized)
// video is hidden. Used for BOTH live-stream states ("already ended") and video
// load failures.
function renderCenteredOverlay(message, stateLabel, subText) {
  const wrapper = document.querySelector('.player-wrapper');

  // Hide the video + any leftover chrome so no play button, control bar, LIVE
  // badge or "Connecting…" text shows behind the message. We draw our own logo
  // into the overlay, so the wrapper's copy is removed to avoid a double.
  const video = document.getElementById('snapie-player');
  if (video) {
    video.removeAttribute('controls');
    video.classList.remove('video-js', 'vjs-default-skin');
    video.style.display = 'none';
  }
  if (wrapper) {
    wrapper.querySelectorAll('.player-logo, .live-badge, .live-viewers, .live-placeholder, .live-unmute')
      .forEach((n) => n.remove());
    wrapper.style.background = '#000';
  }

  document.querySelector('.player-message')?.remove();
  const box = document.createElement('div');
  box.className = 'player-message';
  Object.assign(box.style, {
    position: 'fixed', inset: '0', zIndex: '999',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    textAlign: 'center', padding: '0 24px',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    color: '#e6e6e6', background: '#000',
  });

  // 3Speak logo, kept top-left.
  const logo = document.createElement('img');
  logo.src = '/assets/legacyLogo3Speaksmall.png';
  logo.alt = '3Speak';
  Object.assign(logo.style, {
    position: 'absolute', top: '12px', left: '12px',
    width: '25px', height: 'auto', opacity: '0.85', pointerEvents: 'none',
  });
  box.appendChild(logo);

  const text = document.createElement('span');
  Object.assign(text.style, { fontSize: '16px', fontWeight: '600' });
  text.textContent = message;
  box.appendChild(text);

  // Optional debug sub-line (e.g. the `v` param) — non-bold, muted, below.
  if (subText) {
    const sub = document.createElement('span');
    Object.assign(sub.style, {
      marginTop: '6px', fontSize: '13px', fontWeight: '400',
      color: '#8a8a8a', wordBreak: 'break-all',
    });
    sub.textContent = subText;
    box.appendChild(sub);
  }

  document.body.appendChild(box);
  updatePlayerState(stateLabel || 'Error');
}

// Live-stream state (e.g. "This stream has already ended").
function showPlayerMessage(message, subText) {
  renderCenteredOverlay(message, 'Ended', subText);
}

// Video load failure — same clean centered card as the live states (replaces
// the old bright-red banner).
function showError(message, subText) {
  renderCenteredOverlay(message, 'Error', subText);
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
  const { video, type, noview, live, api, lk, mode, layout, debug, noscroll, autoplay, controls, tvmode, mute, loop, captions, preview, heatmap } = getUrlParams();

  // Live OpenPods session (`?live=<roomName>`) takes a completely separate
  // path: a WebRTC/LiveKit viewer, NOT the Video.js/HLS pipeline. Branch out
  // before any HLS player init so nothing below runs for the live case.
  if (live) {
    isDebugMode = ['1', 'true', 'yes', 'debug'].includes((debug || '').toLowerCase());
    if (mode === 'iframe') {
      document.body.classList.add('iframe-mode');
      document.documentElement.classList.add('iframe-mode');
    }
    if (layout) document.body.classList.add(`layout-${layout}`);
    if (noscroll === '1' || noscroll === 'true') {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    }
    try {
      // Dynamic import so livekit-client is code-split out of the main HLS
      // bundle — it only downloads when someone actually watches a live pod.
      const { initLiveSession } = await import('./live.js');
      await initLiveSession({
        roomName: live,
        apiBase: api,
        lkUrl: lk,
        muted: ['1', 'true', 'yes'].includes((mute || '').toLowerCase()),
      });
    } catch (error) {
      showError(error?.message || 'Could not start the live session');
    }
    return;
  }

  skipViewCount = !!noview;
  isDebugMode = ['1', 'true', 'yes', 'debug'].includes((debug || '').toLowerCase());
  shouldAutoplay = ['1', 'true', 'yes'].includes((autoplay || '').toLowerCase());
  isTVMode = ['1', 'true', 'yes'].includes((tvmode || '').toLowerCase());
  shouldStartMuted = ['1', 'true', 'yes'].includes((mute || '').toLowerCase());
  intendedMuted = shouldStartMuted; // Sync initial intent
  shouldLoop = ['1', 'true', 'yes'].includes((loop || '').toLowerCase());
  // Controls are shown by default, hide only if explicitly set to '0' or 'false'
  shouldShowControls = !['0', 'false', 'no'].includes((controls || '').toLowerCase());
  // Captions are shown by default, disable only if explicitly set to '0' or 'false'
  shouldShowCaptions = !['0', 'false', 'no'].includes((captions || '').toLowerCase());
  // Scrub preview is on by default, disable only if explicitly set to '0' or 'false'
  scrubPreviewEnabled = !['0', 'false', 'no'].includes((preview || '').toLowerCase());
  // "Most replayed" heatmap is on by default, disable only if explicitly '0'/'false'
  heatmapEnabled = !['0', 'false', 'no'].includes((heatmap || '').toLowerCase());

  // PERFORMANCE: Detect Chrome once at startup (avoid regex on every video load)
  isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|Brave/.test(navigator.userAgent);

  debugLog('DOMContentLoaded params', { video, type, mode, layout, debug, noscroll, autoplay, controls, mute, loop, captions, shouldAutoplay, shouldShowControls, shouldStartMuted, shouldLoop, shouldShowCaptions, isChrome });
  
  if (mode === 'iframe') {
    document.body.classList.add('iframe-mode');
    document.documentElement.classList.add('iframe-mode');
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

  if (!video) {
    showError('No video specified. URL should be: /watch?v=owner/permlink or /embed?v=owner/permlink');
    return;
  }

  // 2. Decide video-vs-stream BEFORE touching Video.js — same `?v=` URL for
  //    both, so integrators change nothing. A video is always "owner/permlink"
  //    (has a slash); a live OpenPods room name never does. So a slash-less id
  //    IS a stream: resolve it across the configured endpoints, and if nothing
  //    answers, the stream has ended. A live stream uses a WebRTC pipeline and
  //    must NOT initialize Video.js.
  const looksLikeStream = !video.includes('/');

  if (looksLikeStream) {
    debugLog('Slash-less id → treating as a live stream', video);
    const stream = await resolveStream(video);
    if (stream && stream.found) {
      debugLog('Live stream resolved', stream);
      try {
        const { initLiveSession } = await import('./live.js');
        await initLiveSession({
          roomName: stream.roomName,
          apiBase: stream.api,
          lkUrl: stream.lk,
          host: stream.host,
          muted: shouldStartMuted,
        });
      } catch (e) {
        showPlayerMessage(e?.message || 'Could not start the live session');
      }
      return;
    }
    showPlayerMessage('This stream has already ended');
    return;
  }

  // 3. Has a slash → normally a regular video ("owner/permlink"). But a live
  //    OpenPods announcement embeds as "host/roomName" too (peakd/ecency and our
  //    own PostView build the player from video.info.author + video.info.permlink),
  //    so if there's no video entry, probe the stream endpoints once before
  //    giving up. A resolved stream uses the WebRTC path (no Video.js).
  debugLog('Beginning video load', { type, video });
  let videoData = null;
  let videoError = null;
  try {
    videoData = await fetchVideoData(video, type);
  } catch (error) {
    videoError = error;
  }

  if (!videoData) {
    const stream = await resolveStream(video);
    if (stream && stream.found) {
      debugLog('Live stream resolved from owner/room id', stream);
      try {
        const { initLiveSession } = await import('./live.js');
        await initLiveSession({
          roomName: stream.roomName,
          apiBase: stream.api,
          lkUrl: stream.lk,
          host: stream.host,
          muted: shouldStartMuted,
        });
      } catch (e) {
        showPlayerMessage(e?.message || 'Could not start the live session');
      }
      return;
    }
    // It was a stream POST, but the room has closed → "already ended", not
    // "video not found".
    if (stream && stream.endedStream) {
      showPlayerMessage('This stream has already ended', video);
      return;
    }
    // Neither a video nor a live stream — surface the id for later debugging.
    showError(videoError?.message || 'Video not found', video);
    return;
  }

  //    NOW initialize Video.js (it can detect layout classes correctly) and
  //    wire captions / TV mode.
  initializePlayer();

  if (shouldShowCaptions) {
    subtitleManager.init(onSubtitleUpdate);
    initCaptionUI(player);
    player.on('timeupdate', function() {
      if (subtitleManager.cues.length > 0) {
        // CONTENT time, not player time. Cues are timed against the creator's video;
        // a stitched spot pushes everything after it later in the PLAYER's timeline,
        // so raw currentTime runs every cue early by the length of the spot for the
        // whole rest of the video. contentTime() is a no-op when nothing is spliced.
        //
        // And nothing over the spot itself: contentTime() clamps to the cut point
        // while the break runs, so the last cue before the ad would otherwise sit
        // frozen on top of somebody else's video for its whole length.
        var t = player.currentTime();
        if (adBreak.active && adBreak.isInside(t)) updateOverlay(-1);
        else updateOverlay(adBreak.contentTime(t));
      }
    });
  }

  // No seeking out of a spot from the keyboard.
  //
  // Hiding the control bar takes away the BUTTONS, but video.js hotkeys are still
  // listening — so the arrow keys walked straight past an ad the advertiser had
  // paid for, which made the hidden bar mostly decorative.
  //
  // Capture phase on document, the same trick TV mode uses below: video.js binds on
  // the player element, so intercepting at the document on the way DOWN is what gets
  // there first.
  //
  // Only the keys that move the playhead. Space and K still pause, M still mutes, F
  // is still fullscreen and the volume keys still work — the viewer keeps every
  // control that does not skip the ad, which is the whole point.
  var SEEK_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  document.addEventListener('keydown', function(event) {
    if (!adBreak.active || !player) return;
    var t = player.currentTime();
    if (!adBreak.isInside(t)) return;              // 🚨 roll only — banners keep every key
    if (SEEK_KEYS.indexOf(event.key) === -1) return;
    event.preventDefault();
    event.stopPropagation();
  }, true); // capture phase

  // TV Mode: Enter key toggles fullscreen (direct user gesture in iframe)
  // Use capture phase to intercept before video.js hotkeys handle it
  debugLog('TV Mode check:', isTVMode, 'tvmode param:', tvmode);
  if (isTVMode) {
    debugLog('TV Mode ENABLED - Enter key will toggle fullscreen');
    document.addEventListener('keydown', function(event) {
      if (event.keyCode === 13 || event.key === 'Enter') {
        debugLog('Enter key pressed, toggling fullscreen');
        if (player && player.isFullscreen()) {
          player.exitFullscreen();
        } else if (player) {
          player.requestFullscreen();
        }
        event.preventDefault();
        event.stopPropagation();
      }
    }, true); // capture phase
  }

  try {
    // Load video into player
    await loadVideoFromData(videoData);

    // Check for available captions
    if (shouldShowCaptions && videoData.owner && videoData.permlink) {
      subtitleManager.checkAvailability(videoData.owner, videoData.permlink);
    }

  } catch (error) {
    showError(error.message, video);
  }
});

// Export player instance for external access
export { player, loadVideoFromData };
