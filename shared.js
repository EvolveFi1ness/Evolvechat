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
// EXERCISE PRESCRIPTION HELPERS
// Shared by the coach builder (coach.html) and the client logger
// (index.html). Prescriptions are stored as structured fields plus a
// human display string:
//
//   { sets:2, minReps:12, maxReps:15, rir:3, note:'…',
//     target:'2 × 12–15 · RIR 3' }
//
// `target` is what every display renders verbatim, so old and new docs
// look identical everywhere. Structured fields drive logger prefill.
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a legacy prescription string ('4x8', '4×8', '2x12-15', '3×12/leg').
 * Returns { sets, minReps, maxReps } or null when unparseable.
 */
function parsePrescriptionTarget(str) {
  if (!str) return null;
  const m = String(str).match(/(\d+)\s*[×x]\s*(\d+)(?:\s*[–—-]\s*(\d+))?/);
  if (!m) return null;
  const sets = parseInt(m[1], 10);
  const minReps = parseInt(m[2], 10);
  let maxReps = m[3] ? parseInt(m[3], 10) : minReps;
  if (!(sets > 0) || !(minReps > 0)) return null;
  if (!(maxReps >= minReps)) maxReps = minReps;
  return { sets, minReps, maxReps };
}

/**
 * Format a prescription display string: '2 × 12–15 · RIR 3', '3 × 10'.
 */
function formatPrescription(p) {
  p = p || {};
  const sets = Math.min(99, Math.max(1, parseInt(p.sets, 10) || 3));
  const min = Math.min(999, Math.max(1, parseInt(p.minReps, 10) || parseInt(p.reps, 10) || 10));
  let max = parseInt(p.maxReps, 10);
  if (!(max >= min)) max = min;
  max = Math.min(999, max);
  let s = sets + ' × ' + min + (max > min ? '–' + max : '');
  const rir = parseInt(p.rir, 10) || 0;
  if (rir > 0) s += ' · RIR ' + Math.min(10, rir);
  return s;
}

/**
 * Normalize any exercise (new or legacy) to structured prescription
 * values, falling back to parsing `target`, then to defaults.
 * Never throws; always returns { sets, minReps, maxReps, rir, note }.
 */
function normalizeExercisePrescription(ex) {
  ex = ex || {};
  let parsed = null;
  try { parsed = parsePrescriptionTarget(ex.target); } catch (e) { parsed = null; }
  const sets = (ex.sets > 0) ? Math.min(99, ex.sets)
    : (parsed ? parsed.sets : 3);
  const minReps = (ex.minReps > 0) ? Math.min(999, ex.minReps)
    : (parsed ? parsed.minReps : 10);
  const maxReps = (ex.maxReps >= minReps) ? Math.min(999, ex.maxReps)
    : (parsed && parsed.maxReps >= minReps ? parsed.maxReps : minReps);
  const rir = (ex.rir > 0) ? Math.min(10, ex.rir) : 0;
  return { sets, minReps, maxReps, rir, note: ex.note || '' };
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
