/* shared.js — Pure utility functions shared between index.html and coach.html
   Loaded via <script src="shared.js"> before inline scripts in both files. */

function escapeHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function escapeAttr(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Both apps use the embedded exercise map only if JSON cannot be loaded.
function _loadWorkoutsEmbeddedFallback() {
 return new Promise((resolve) => {
  if (window._WORKOUTS_EMBEDDED) { resolve(window._WORKOUTS_EMBEDDED); return; }
  const s = document.createElement('script');
  s.src = 'data/workouts.js';
  s.onload = () => resolve(window._WORKOUTS_EMBEDDED || {});
  s.onerror = () => resolve({});
  document.head.appendChild(s);
 });
}

// Reuse normalized search text and rank into buckets instead of cloning and
// sorting the entire catalog on each keystroke. Results retain the food objects.
const _foodSearchIndex = new WeakMap();
function searchFoodCatalog(foods, query) {
 const normalized = String(query || '').trim().toLowerCase();
 if (!normalized) return foods;
 const tokens = normalized.split(/\s+/);
 const ranked = [[], [], []];
 foods.forEach(food => {
  if (!food) return;
  const rawName = food.food_name || '';
  const rawCategory = food.category || '';
  let entry = _foodSearchIndex.get(food);
  if (!entry || entry.rawName !== rawName || entry.rawCategory !== rawCategory) {
   const name = rawName.toLowerCase();
   entry = { rawName, rawCategory, name, text: name + ' ' + rawCategory.toLowerCase(), words: name.split(/[,\s]+/) };
   _foodSearchIndex.set(food, entry);
  }
  if (!tokens.every(token => entry.text.includes(token))) return;
  const bucket = entry.name.startsWith(normalized) ? 0 : tokens.every(token => entry.words.some(word => word.startsWith(token))) ? 1 : 2;
  ranked[bucket].push(food);
 });
 return ranked[0].concat(ranked[1], ranked[2]);
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

// Format a calendar Date without converting local midnight to the previous UTC day.
function localDateKey(date) {
 return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

let _appToastTimer = null;
function showAppToast(message, type, duration) {
 const toast = document.getElementById('toast');
 if (!toast) return;
 clearTimeout(_appToastTimer);
 toast.setAttribute('role', 'status');
 toast.setAttribute('aria-live', 'polite');
 toast.setAttribute('aria-atomic', 'true');
 toast.textContent = message;
 toast.className = 'toast' + (type ? ' ' + type : '') + ' show';
 _appToastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

let _appConfirmPending = false;
function showConfirmDialog(opts) {
 opts = opts || {};
 // A repeated tap must not queue a second destructive operation.
 if (_appConfirmPending) return Promise.resolve(false);
 _appConfirmPending = true;
 let dialog = document.getElementById('app-confirm-dialog');
 if (!dialog) {
  dialog = document.createElement('dialog');
  dialog.id = 'app-confirm-dialog';
  dialog.className = 'ev-confirm';
  dialog.setAttribute('aria-labelledby', 'ev-confirm-title');
  dialog.setAttribute('aria-describedby', 'ev-confirm-message');
  dialog.innerHTML = '<h2 id="ev-confirm-title"></h2><p id="ev-confirm-message"></p><div class="ev-confirm-actions"><button type="button" data-action="cancel">Cancel</button><button type="button" data-action="confirm">Confirm</button></div>';
  document.body.appendChild(dialog);
 }
 const previousFocus = document.activeElement;
 const cancel = dialog.querySelector('[data-action="cancel"]');
 const confirm = dialog.querySelector('[data-action="confirm"]');
 dialog.querySelector('h2').textContent = opts.title || 'Confirm action';
 dialog.querySelector('p').textContent = opts.message || '';
 cancel.textContent = opts.cancelText || 'Cancel';
 confirm.textContent = opts.confirmText || 'Confirm';
 confirm.classList.toggle('ev-confirm-danger', !!opts.danger);
 return new Promise(resolve => {
  function finish(result) {
   dialog.removeEventListener('cancel', onCancel);
   dialog.removeEventListener('close', onClose);
   dialog.removeEventListener('click', onClick);
   dialog.removeEventListener('keydown', onKey);
   dialog.close();
   _appConfirmPending = false;
   if (previousFocus && previousFocus.isConnected) previousFocus.focus();
   resolve(result);
  }
  function onCancel(event) { event.preventDefault(); finish(false); }
  function onClose() { if (!dialog.open) finish(false); }
  function onKey(event) {
   if (event.key !== 'Tab') return;
   if (event.shiftKey && document.activeElement === cancel) {
    event.preventDefault(); confirm.focus();
   } else if (!event.shiftKey && document.activeElement === confirm) {
    event.preventDefault(); cancel.focus();
   }
  }
  function onClick(event) {
   if (event.target === confirm) finish(true);
   else if (event.target === cancel) finish(false);
  }
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onClose);
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('keydown', onKey);
  dialog.showModal();
  cancel.focus();
 });
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
 _entries: new Map(),
 _lastUrl: null,
 _maxRetries: 2
};

/**
 * Load the food database. Returns a promise that resolves to the food array.
 * @param {string} url - The URL to fetch the food database from
 * @param {string} [embeddedKey] - Key on window for embedded fallback data
 * @returns {Promise<Array>}
 */
function loadFoodDatabase(url, embeddedKey) {
 _foodDbLoader._lastUrl = url;
 let entry = _foodDbLoader._entries.get(url);
 if (!entry) {
  entry = { cache: null, promise: null };
  _foodDbLoader._entries.set(url, entry);
 }
 if (entry.cache) return Promise.resolve(entry.cache);
 if (entry.promise) return entry.promise;
 entry.promise = (async () => {
  for (let attempt = 0; attempt <= _foodDbLoader._maxRetries; attempt++) {
   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 10000);
   try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data) || !data.length) throw new Error('Food database is empty or invalid');
    entry.cache = data.filter(f => f && typeof f.food_name === 'string');
    if (!entry.cache.length) { entry.cache = null; throw new Error('Food database contains no foods'); }
    return entry.cache;
   } catch(err) {
    console.warn(`Food database load attempt ${attempt + 1} failed:`, err.message);
    if (attempt < _foodDbLoader._maxRetries) {
     await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
   } finally {
    clearTimeout(timeout);
   }
  }
  const fallback = embeddedKey && window[embeddedKey];
  // Do not cache a failed load: reopening search should retry after reconnection.
  return Array.isArray(fallback) ? fallback.filter(f => f && typeof f.food_name === 'string') : [];
 })().finally(() => { entry.promise = null; });
 return entry.promise;
}

/**
 * Get the food database synchronously if loaded, or null if still loading.
 * @returns {Array|null}
 */
function getFoodDatabaseSync() {
 return _foodDbLoader._entries.get(_foodDbLoader._lastUrl)?.cache || null;
}

/**
 * Check if the food database is currently loading.
 * @returns {boolean}
 */
function isFoodDatabaseLoading() {
 return !!_foodDbLoader._entries.get(_foodDbLoader._lastUrl)?.promise;
}

/**
 * Reset the food database loader (for testing or forced reload).
 */
function resetFoodDatabaseLoader() {
 _foodDbLoader._entries.clear();
 _foodDbLoader._lastUrl = null;
}
