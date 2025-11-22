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

function initializePlayer() {
  player = videojs('snapie-player', {
    controls: true,
    autoplay: false,
    preload: 'auto',
    fluid: true,
    playbackRates: [0.5, 1, 1.5, 2],
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
    console.log('Player is ready');
    updatePlayerState('Ready');
  });

  player.on('loadeddata', function() {
    // Small timeout to ensure HLS variant is chosen and real dimensions available
    setTimeout(handleVerticalVideoDetection, 50);
  });



  player.on('play', function() {
    console.log('Video is playing');
    updatePlayerState('Playing');
    
    // Increment view count on first play
    if (currentVideoData && !player.hasIncrementedView) {
      incrementViewCount(currentVideoData);
      player.hasIncrementedView = true;
    }
  });

  player.on('pause', function() {
    console.log('Video is paused');
    updatePlayerState('Paused');
    handleLogoVisibility();
  });

  player.on('ended', function() {
    console.log('Video ended');
    updatePlayerState('Ended');
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
    mode: params.get('mode') // 'iframe' for minimal embedding UI
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
    console.log('Setting thumbnail:', videoData.thumbnail);
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
  
  console.log('Video sources:', sources);
  
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
  
  console.log('Loaded video:', videoData);
}



// Handle vertical video detection and proper scaling
function handleVerticalVideoDetection() {
  if (!player) return;
  
  // Use player.tech().el() to get the actual rendering video element (works with HLS/VHS)
  const videoEl = player.tech().el();
  if (!videoEl) return;
  
  const { videoWidth, videoHeight } = videoEl;
  if (!videoWidth || !videoHeight) return;
  
  const isVertical = videoHeight > videoWidth;
  
  console.log(`Real dimensions: ${videoWidth}x${videoHeight} → vertical: ${isVertical}`);
  
  if (isVertical) {
    console.log('Detected vertical video - adding vertical-video class');
    player.addClass('vertical-video');
    // Also tag the wrapper so it can change aspect ratio
    const wrapper = player.el().closest('.player-wrapper');
    if (wrapper) wrapper.classList.add('vertical-video');
  } else {
    console.log('Detected horizontal video - removing vertical-video class');
    player.removeClass('vertical-video');
    // Also remove from wrapper
    const wrapper = player.el().closest('.player-wrapper');
    if (wrapper) wrapper.classList.remove('vertical-video');
  }
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
  // Initialize the player
  initializePlayer();

  // Get URL parameters
  const { video, type, mode } = getUrlParams();
  
  // Enable iframe mode if requested
  if (mode === 'iframe') {
    document.body.classList.add('iframe-mode');
    console.log('Iframe mode enabled - minimal UI');
  }
  
  if (!video) {
    showError('No video specified. URL should be: /watch?v=owner/permlink or /embed?v=owner/permlink');
    return;
  }
  
  console.log(`Loading ${type} video: ${video}`);
  
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
