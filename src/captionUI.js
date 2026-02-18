import subtitleManager from './subtitleManager';

// Supported language names for display
var LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', pl: 'Polish', tr: 'Turkish',
  sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', cs: 'Czech',
  ro: 'Romanian', hu: 'Hungarian', el: 'Greek', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', uk: 'Ukrainian', bg: 'Bulgarian', hr: 'Croatian',
  sk: 'Slovak', sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian',
  he: 'Hebrew', fa: 'Persian', bn: 'Bengali', ta: 'Tamil', te: 'Telugu',
  ur: 'Urdu', sw: 'Swahili', af: 'Afrikaans', ca: 'Catalan', gl: 'Galician',
  eu: 'Basque', sr: 'Serbian',
};

var overlayEl = null;
var overlayTextEl = null;
var menuEl = null;
var ccButtonEl = null;
var menuOpen = false;
var lastCueText = null;

/**
 * Initialize the caption UI.
 * @param {object} player - Video.js player instance
 */
function initCaptionUI(player) {
  createOverlay(player);
  createCCButton(player);
  createMenu(player);

  // Close menu when clicking outside
  document.addEventListener('click', function(e) {
    if (menuOpen && menuEl && ccButtonEl &&
        !menuEl.contains(e.target) && !ccButtonEl.contains(e.target)) {
      closeMenu();
    }
  });
}

/** Create the subtitle overlay element inside the player */
function createOverlay(player) {
  overlayEl = document.createElement('div');
  overlayEl.className = 'subtitle-overlay';

  overlayTextEl = document.createElement('span');
  overlayTextEl.className = 'subtitle-overlay-text';

  overlayEl.appendChild(overlayTextEl);
  player.el().appendChild(overlayEl);
}

/** Update the overlay text for a given playback time */
function updateOverlay(currentTime) {
  var text = subtitleManager.getActiveCue(currentTime);
  if (text !== lastCueText) {
    lastCueText = text;
    if (text) {
      overlayTextEl.textContent = text;
      overlayEl.style.display = '';
    } else {
      overlayEl.style.display = 'none';
    }
  }
}

/** Create the CC toggle button in the Video.js control bar */
function createCCButton(player) {
  var controlBar = player.controlBar.el();

  ccButtonEl = document.createElement('button');
  ccButtonEl.className = 'vjs-control vjs-button vjs-cc-button';
  ccButtonEl.setAttribute('type', 'button');
  ccButtonEl.setAttribute('aria-label', 'Captions');
  ccButtonEl.setAttribute('title', 'Captions');
  ccButtonEl.innerHTML = '<span class="vjs-cc-icon">CC</span>';

  ccButtonEl.addEventListener('click', function(e) {
    e.stopPropagation();
    if (menuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  // Insert before fullscreen button
  var fsButton = controlBar.querySelector('.vjs-fullscreen-control');
  if (fsButton) {
    controlBar.insertBefore(ccButtonEl, fsButton);
  } else {
    controlBar.appendChild(ccButtonEl);
  }

  updateCCButtonState();
}

/** Update CC button active state */
function updateCCButtonState() {
  if (!ccButtonEl) return;
  if (subtitleManager.selectedLang) {
    ccButtonEl.classList.add('active');
  } else {
    ccButtonEl.classList.remove('active');
  }
}

/** Create the caption language menu */
function createMenu(player) {
  menuEl = document.createElement('div');
  menuEl.className = 'vjs-caption-menu';
  menuEl.style.display = 'none';

  // Prevent clicks inside menu from bubbling to player (which would toggle play/pause)
  menuEl.addEventListener('click', function(e) {
    e.stopPropagation();
  });

  player.el().appendChild(menuEl);
  rebuildMenu();
}

function openMenu() {
  if (!menuEl) return;
  rebuildMenu();
  menuEl.style.display = '';
  menuOpen = true;
}

function closeMenu() {
  if (!menuEl) return;
  menuEl.style.display = 'none';
  menuOpen = false;
}

/** Rebuild the menu contents based on current state */
function rebuildMenu() {
  if (!menuEl) return;
  menuEl.innerHTML = '';

  // --- Language Section ---
  var langTitle = document.createElement('div');
  langTitle.className = 'vjs-caption-section-title';
  langTitle.textContent = 'Captions';
  menuEl.appendChild(langTitle);

  // "Off" option
  var offBtn = document.createElement('button');
  offBtn.className = 'vjs-caption-lang-item' + (!subtitleManager.selectedLang ? ' active' : '');
  offBtn.textContent = 'Off';
  offBtn.addEventListener('click', function() {
    subtitleManager.selectLanguage(null);
    updateCCButtonState();
    rebuildMenu();
  });
  menuEl.appendChild(offBtn);

  // Language options
  if (subtitleManager.availableLanguages) {
    for (var i = 0; i < subtitleManager.availableLanguages.length; i++) {
      (function(langEntry) {
        var langBtn = document.createElement('button');
        var langName = LANGUAGE_NAMES[langEntry.lang] || langEntry.lang;
        langBtn.className = 'vjs-caption-lang-item' +
          (subtitleManager.selectedLang === langEntry.lang ? ' active' : '');
        langBtn.textContent = langName;
        langBtn.addEventListener('click', function() {
          subtitleManager.selectLanguage(langEntry.lang);
          updateCCButtonState();
          rebuildMenu();
        });
        menuEl.appendChild(langBtn);
      })(subtitleManager.availableLanguages[i]);
    }
  }
}

/** Handle subtitleManager state updates */
function onSubtitleUpdate() {
  updateCCButtonState();
  if (menuOpen) {
    rebuildMenu();
  }
}

/** Show or hide the CC button */
function setCCButtonVisible(visible) {
  if (ccButtonEl) {
    ccButtonEl.style.display = visible ? '' : 'none';
  }
}

export { initCaptionUI, updateOverlay, onSubtitleUpdate, setCCButtonVisible };
