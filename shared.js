/* shared.js — Pure utility functions shared between index.html and coach.html
   Loaded via <script src="shared.js"> before inline scripts in both files. */

function escapeHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function escapeAttr(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function sanitizeInput(raw, maxLen) {
  let s = String(raw ?? '');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '');
  s = s.trim();
  if (maxLen) s = s.slice(0, maxLen);
  return s;
}

function getSanitizedValue(id, maxLen) {
  const el = document.getElementById(id);
  return el ? sanitizeInput(el.value, maxLen) : '';
}

const _rateLimitState = {};
function rateLimited(key, minIntervalMs, message) {
  const now = Date.now();
  const last = _rateLimitState[key] || 0;
  if (now - last < minIntervalMs) {
    if (message && typeof showToast === 'function') showToast(message, 'error');
    return true;
  }
  _rateLimitState[key] = now;
  return false;
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch(e) {
    console.warn('localStorage.setItem failed for "' + key + '":', e.message);
    return false;
  }
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function recentlyDismissed(dismissKey, dismissDays) {
  try {
   var t = localStorage.getItem(dismissKey);
   if (!t) return false;
   return (Date.now() - parseInt(t, 10)) < dismissDays * 24 * 60 * 60 * 1000;
  } catch(e) { return false; }
}

function showBanner(dismissKey, dismissDays) {
  if (isStandalone() || recentlyDismissed(dismissKey, dismissDays)) return;
  var b = document.getElementById('a2hs-banner');
  if (b) b.classList.add('show');
}

function a2hsDismiss(dismissKey) {
  var b = document.getElementById('a2hs-banner');
  if (b) b.classList.remove('show');
  try { localStorage.setItem(dismissKey, String(Date.now())); } catch(e) {}
}

function a2hsCloseIosSheet() {
 var sheet = document.getElementById('a2hs-ios-backdrop');
 if (sheet) sheet.classList.remove('show');
}

// ═══════════════════════════════════════════════════════════════
// SHARED FOOD DATABASE LOADER
// Single point of entry for loading food data. Prevents duplicate
// fetches and provides retry capability.
// ═══════════════════════════════════════════════════════════════

const _foodDbLoader = {
 _cache: null,
 _promise: null,
 _error: null,
 _retryCount: 0,
 _maxRetries: 2
};

/**
 * Load the food database. Returns a promise that resolves to the food array.
 * @param {string} url - The URL to fetch the food database from
 * @param {string} [embeddedKey] - Key on window for embedded fallback data
 * @returns {Promise<Array>}
 */
function loadFoodDatabase(url, embeddedKey) {
 // Return cached data immediately if available
 if (_foodDbLoader._cache) {
  return Promise.resolve(_foodDbLoader._cache);
 }

 // Return existing promise if a load is in progress
 if (_foodDbLoader._promise) {
  return _foodDbLoader._promise;
 }

 _foodDbLoader._promise = new Promise((resolve, reject) => {
  const attemptLoad = (retryNum) => {
   fetch(url)
    .then(r => {
     if (!r.ok) throw new Error(`HTTP ${r.status}`);
     return r.json();
    })
    .then(data => {
     _foodDbLoader._cache = data || (embeddedKey && window[embeddedKey]) || [];
     _foodDbLoader._retryCount = 0;
     resolve(_foodDbLoader._cache);
    })
    .catch(err => {
     console.warn(`Food database load attempt ${retryNum + 1} failed:`, err.message);
     if (retryNum < _foodDbLoader._maxRetries) {
      // Retry with exponential backoff
      setTimeout(() => attemptLoad(retryNum + 1), 1000 * (retryNum + 1));
     } else {
      // Final fallback to embedded data if available
      _foodDbLoader._cache = (embeddedKey && window[embeddedKey]) || [];
      _foodDbLoader._error = err;
      resolve(_foodDbLoader._cache);
     }
    });
  };
  attemptLoad(0);
 });

 return _foodDbLoader._promise;
}

/**
 * Get the food database synchronously if loaded, or null if still loading.
 * @returns {Array|null}
 */
function getFoodDatabaseSync() {
 return _foodDbLoader._cache;
}

/**
 * Check if the food database is currently loading.
 * @returns {boolean}
 */
function isFoodDatabaseLoading() {
 return _foodDbLoader._promise !== null && _foodDbLoader._cache === null;
}

/**
 * Reset the food database loader (for testing or forced reload).
 */
function resetFoodDatabaseLoader() {
 _foodDbLoader._cache = null;
 _foodDbLoader._promise = null;
 _foodDbLoader._error = null;
 _foodDbLoader._retryCount = 0;
}
