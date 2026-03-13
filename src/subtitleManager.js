import { parseSrt } from './srtParser';

const TRANSLATE_API_URL = 'https://3speak-translator.okinoko.io';
const IPFS_CDN_URL = 'https://hotipfs-3speak-1.b-cdn.net/ipfs';

const SUBTITLE_LANG_KEY = '3speak-subtitle-lang';

// In-memory cache: "author/permlink/lang" -> parsed cues array
const subtitleCache = {};

/**
 * Subtitle manager — vanilla JS replacement for the React useSubtitles hook.
 * Manages subtitle availability, fetching, parsing, caching, and style persistence.
 */
const subtitleManager = {
  availableLanguages: null,
  selectedLang: null,
  cues: [],
  loading: false,
  _author: null,
  _permlink: null,
  _onUpdate: null, // callback when state changes

  /** Initialize */
  init(onUpdate) {
    this._onUpdate = onUpdate;
  },

  /** Check which subtitle languages are available for a video */
  async checkAvailability(author, permlink) {
    this._author = author;
    this._permlink = permlink;
    this.availableLanguages = null;
    this.selectedLang = null;
    this.cues = [];

    if (!author || !permlink) {
      this._notify();
      return;
    }

    try {
      const res = await fetch(
        `${TRANSLATE_API_URL}/subtitles/${author}/${permlink}`
      );
      if (!res.ok) {
        this.availableLanguages = null;
        this._notify();
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        this.availableLanguages = null;
        this._notify();
        return;
      }
      this.availableLanguages = data;

      // Auto-select if user previously chose a language
      const stored = localStorage.getItem(SUBTITLE_LANG_KEY);
      if (stored) {
        if (data.some(function(d) { return d.lang === stored; })) {
          await this.selectLanguage(stored);
        } else if (data.some(function(d) { return d.lang === 'en'; })) {
          await this.selectLanguage('en');
        }
      }

      this._notify();
    } catch (err) {
      console.error('[subtitleManager] Failed to check availability:', err);
      this.availableLanguages = null;
      this._notify();
    }
  },

  /** Select a subtitle language (or null to disable) */
  async selectLanguage(lang) {
    this.selectedLang = lang;

    if (lang) {
      localStorage.setItem(SUBTITLE_LANG_KEY, lang);
    } else {
      localStorage.removeItem(SUBTITLE_LANG_KEY);
      this.cues = [];
      this._notify();
      return;
    }

    if (!this.availableLanguages) {
      this.cues = [];
      this._notify();
      return;
    }

    var langEntry = null;
    for (var i = 0; i < this.availableLanguages.length; i++) {
      if (this.availableLanguages[i].lang === lang) {
        langEntry = this.availableLanguages[i];
        break;
      }
    }
    if (!langEntry) {
      this.cues = [];
      this._notify();
      return;
    }

    var cacheKey = this._author + '/' + this._permlink + '/' + lang;
    if (subtitleCache[cacheKey]) {
      this.cues = subtitleCache[cacheKey];
      this._notify();
      return;
    }

    this.loading = true;
    this._notify();

    try {
      var res = await fetch(IPFS_CDN_URL + '/' + langEntry.cid);
      var srtText = await res.text();
      var parsed = parseSrt(srtText);
      // Cues are assumed sorted by start time (SRT spec); binary search depends on this
      subtitleCache[cacheKey] = parsed;
      this.cues = parsed;
    } catch (err) {
      console.error('[subtitleManager] Failed to fetch SRT:', err);
      this.cues = [];
    } finally {
      this.loading = false;
      this._notify();
    }
  },

  /** Get the active cue text for a given playback time (binary search with overlap scan) */
  getActiveCue(currentTime) {
    if (!this.cues || this.cues.length === 0) return null;
    var cues = this.cues;
    var lo = 0;
    var hi = cues.length - 1;
    // Binary search for the last cue whose start <= currentTime
    while (lo <= hi) {
      var mid = (lo + hi) >>> 1;
      if (cues[mid].start <= currentTime) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // hi is now the index of the last cue with start <= currentTime.
    // Scan backwards to handle overlapping cues — a later cue may have ended
    // while an earlier, longer cue is still active.
    for (var i = hi; i >= 0; i--) {
      if (currentTime >= cues[i].start && currentTime < cues[i].end) {
        return cues[i].text;
      }
    }
    return null;
  },

  /** Notify the update callback */
  _notify() {
    if (typeof this._onUpdate === 'function') {
      this._onUpdate();
    }
  }
};

export default subtitleManager;
