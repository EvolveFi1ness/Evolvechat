// Dependency-free regression checks: node scripts/audit/verify.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const shared = read('shared.js');

function functionSource(file, name) {
  const source = read(file);
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, name + ' exists');
  const firstLine = source.slice(match.index, source.indexOf('\n', match.index));
  try { new vm.Script('(' + firstLine + ')'); return firstLine; } catch (_) {}
  for (let end = source.indexOf('\n}', match.index); end !== -1; end = source.indexOf('\n}', end + 2)) {
    const candidate = source.slice(match.index, end + 2);
    try { new vm.Script('(' + candidate + ')'); return candidate; } catch (_) {}
  }
  throw new Error('Cannot extract ' + name);
}
function context(values = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, AbortController, window: {}, ...values });
  vm.runInContext(shared, ctx);
  return ctx;
}
function load(ctx, file, ...names) { names.forEach(name => vm.runInContext(functionSource(file, name), ctx)); }

test('all inline scripts and project JavaScript pass node --check', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-check-'));
  try {
    for (const file of ['coach.html', 'index.html']) {
      let i = 0;
      for (const m of read(file).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\bsrc\s*=/.test(m[1]) || !m[2].trim()) continue;
        const name = path.join(temp, file + '-' + (++i) + '.js');
        fs.writeFileSync(name, m[2]);
        execFileSync(process.execPath, ['--check', name], { stdio: 'pipe' });
      }
    }
    for (const file of ['shared.js', 'sw.js', 'scripts/audit/verify.cjs', 'scripts/audit/browser.cjs']) {
      execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    }
  } finally { fs.rmSync(temp, { recursive: true }); }
});

test('food database coalesces reads, separates URLs, validates data, and retries after failure', async () => {
  let calls = [];
  let fail = false;
  const ctx = context({ fetch: async url => {
    calls.push(url);
    if (fail) throw Error('offline');
    return { ok: true, json: async () => [{ food_name: url }, null] };
  }, console: { warn() {} } });
  vm.runInContext('_foodDbLoader._maxRetries = 0', ctx);
  const first = ctx.loadFoodDatabase('foods');
  assert.equal(ctx.isFoodDatabaseLoading(), true);
  assert.equal(ctx.loadFoodDatabase('foods'), first);
  assert.equal((await first).length, 1);
  assert.equal(ctx.isFoodDatabaseLoading(), false);
  await ctx.loadFoodDatabase('foods');
  assert.deepEqual(calls, ['foods']);
  assert.equal((await ctx.loadFoodDatabase('nutrition'))[0].food_name, 'nutrition');
  ctx.resetFoodDatabaseLoader();
  fail = true;
  assert.equal((await ctx.loadFoodDatabase('foods')).length, 0);
  fail = false;
  assert.equal((await ctx.loadFoodDatabase('foods'))[0].food_name, 'foods');
  assert.equal(calls.length, 4);
  ctx.resetFoodDatabaseLoader();
  ctx.fetch = async () => ({ ok: true, json: async () => ({ invalid: true }) });
  assert.equal((await ctx.loadFoodDatabase('bad')).length, 0);
  assert.equal(ctx.getFoodDatabaseSync(), null);
});

test('a newer toast cancels the previous hide timer and announces status', () => {
  const timers = new Map(); let id = 0;
  const toast = { classList: { remove() {} }, setAttribute(k, v) { this[k] = v; } };
  const ctx = context({ document: { getElementById: () => toast },
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); } });
  ctx.showAppToast('First', '', 3000);
  ctx.showAppToast('Second', 'error', 6000);
  assert.equal(timers.size, 1);
  assert.equal(toast.textContent, 'Second');
  assert.equal(toast['aria-live'], 'polite');
});

test('photo due dates keep their local calendar day in UTC+8', () => {
  const script = shared + '\nif (localDateKey(new Date(2026, 9, 26)) !== "2026-10-26") process.exit(1);';
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Asia/Singapore' } });
  const ctx = context({ phNow: () => new Date(2026, 9, 26) });
  load(ctx, 'index.html', '_computeNextDue');
  const next = ctx._computeNextDue(1);
  assert.equal(next, '2026-11-09');
});

test('nutrition reads deduplicate by account and date without dropping a new day', async () => {
  const waits = [];
  const db = { collection() { return this; }, doc() { return this; }, where(field, op, value) {
    return { get: () => new Promise(resolve => waits.push({ field, value, resolve })) };
  } };
  const ctx = context({ db, currentUid: 'client', nutrFoodLogs: {}, NUTR_MEALS: ['Meal 1'] });
  vm.runInContext('const _nutrDayLoads = new Map();', ctx);
  load(ctx, 'index.html', 'nutrLoadDayLogs');
  const a = ctx.nutrLoadDayLogs('client', '2026-10-25');
  assert.equal(a, ctx.nutrLoadDayLogs('client', '2026-10-25'));
  const b = ctx.nutrLoadDayLogs('client', '2026-10-26');
  assert.equal(waits.length, 4);
  for (const wait of waits.slice(2)) wait.resolve({ docs: [] });
  await b;
  for (const wait of waits.slice(0, 2)) wait.resolve({ docs: [] });
  await a;
  assert.ok(ctx.nutrFoodLogs['2026-10-25']);
  assert.ok(ctx.nutrFoodLogs['2026-10-26']);
  const late = ctx.nutrLoadDayLogs('client', '2026-10-27');
  ctx.currentUid = 'another-client';
  for (const wait of waits.slice(4)) wait.resolve({ docs: [] });
  await late;
  assert.equal(ctx.nutrFoodLogs['2026-10-27'], undefined);
});

test('assigned-food updates change only day type and roll back failed saves', async () => {
  let fail = false; const writes = [];
  const ctx = context({
    db: { collection() { return this; }, doc() { return this; }, async update(data) {
      if (fail) throw Error('Denied'); writes.push(JSON.parse(JSON.stringify(data)));
    } }, document: { getElementById: () => ({ value: 'client' }) },
    showToast() {}, async loadAssignedFoodsPanel() {},
    window: { _foodLogsCache: { client: 1 }, _checkinMlCache: { client: 1 } }
  });
  load(ctx, 'coach.html', 'dayTypeLabel', 'coachUpdateAssignedFoodDayType');
  for (const [from, to] of [['', 'Rest Day'], ['Rest Day', 'Training Day'], ['Training Day', '']]) {
    const select = { value: to, dataset: { savedDayType: from } };
    await ctx.coachUpdateAssignedFoodDayType('client', 'food', select);
    assert.deepEqual(writes.at(-1), { dayType: to });
    assert.equal(select.disabled, false);
  }
  assert.equal(ctx.window._foodLogsCache.client, undefined);
  fail = true;
  const select = { value: 'Rest Day', dataset: { savedDayType: '' } };
  await ctx.coachUpdateAssignedFoodDayType('client', 'food', select);
  assert.equal(select.value, '');
  assert.equal(select.disabled, false);
});

test('assigned foods respect the selected day even when it has no specific foods', () => {
  const nodes = { 'nutr-assigned-plan': {}, 'nutr-macro-chips': {} };
  const training = { dayType: 'Training Day', planName: 'Training target', calories: 2300 };
  const rest = { dayType: 'Rest Day', planName: 'Rest target', calories: 1900 };
  const ctx = context({ document: { getElementById: id => nodes[id] },
    nutrDateKey: () => 'today', nutrCurrentDate: new Date(), todayWorkout: null,
    NUTR_MEALS: ['Meal 1'], MEAL_ICONS: {}, nutrAllMacroPlans: [training, rest], nutrPlan: training,
    nutrFoodLogs: { today: { __assigned__: [
      { food_name: 'Training oats', dayType: 'Training Day', servingG: 100 },
      { food_name: 'Daily banana', dayType: '', servingG: 100 }
    ] } }, window: { _nutrDayTypeFilter: 'Rest Day' }
  });
  load(ctx, 'index.html', 'nutrActiveDayType', 'nutrPlanForDayType', 'renderNutrAssignedPlan');
  ctx.renderNutrAssignedPlan();
  assert.doesNotMatch(nodes['nutr-assigned-plan'].innerHTML, /Training oats|Training target/);
  assert.match(nodes['nutr-assigned-plan'].innerHTML, /Daily banana/);
  assert.match(nodes['nutr-assigned-plan'].innerHTML, /Rest target/);
  ctx.window._nutrDayTypeFilter = 'Training Day';
  ctx.renderNutrAssignedPlan();
  assert.match(nodes['nutr-assigned-plan'].innerHTML, /Training oats/);
  assert.match(nodes['nutr-assigned-plan'].innerHTML, /Daily banana/);
  ctx.nutrFoodLogs.today.__assigned__.push({ food_name: 'Rest rice', dayType: 'Rest Day', servingG: 100 });
  ctx.window._nutrDayTypeFilter = 'Rest Day';
  ctx.nutrAllMacroPlans = [training];
  ctx.renderNutrAssignedPlan();
  assert.doesNotMatch(nodes['nutr-assigned-plan'].innerHTML, /Training oats|Training target/);
  assert.match(nodes['nutr-assigned-plan'].innerHTML, /Rest rice/);
  assert.equal(ctx.window._nutrDayTypeFilter, 'Rest Day');
  ctx.nutrFoodLogs.today.__assigned__ = [{ food_name: 'Training oats', dayType: 'Training Day', servingG: 100 }];
  ctx.renderNutrAssignedPlan();
  assert.match(nodes['nutr-assigned-plan'].innerHTML, /No foods assigned for this day type/);
  assert.equal(nodes['nutr-macro-chips'].innerHTML, '');
  ctx.nutrAllMacroPlans.push({ planName: 'Everyday target', dayType: '', calories: 2000 });
  assert.equal(ctx.nutrPlanForDayType('Rest Day').planName, 'Everyday target');
  ctx.nutrFoodLogs.today.__assigned__ = [{ food_name: 'Legacy daily food', servingG: 100 }];
  for (const day of ['Training Day', 'Rest Day']) {
    ctx.window._nutrDayTypeFilter = day;
    ctx.renderNutrAssignedPlan();
    assert.match(nodes['nutr-assigned-plan'].innerHTML, /Legacy daily food/);
  }
});

test('grams edits reject invalid input and scale from the last saved quantity', async () => {
  let writes = []; let exists = true;
  const nodes = { 'afg-food': { value: '-10', focus() {} }, 'afg-save-food': {} };
  const ctx = context({ document: { getElementById: id => nodes[id] }, showToast() {}, loadAssignedFoodsPanel() {},
    db: { collection() { return this; }, doc() { return this; },
      async get() { return { exists, data: () => ({ servingG: 80, calories: 200, protein_g: 20, carbs_g: 10, fat_g: 5 }) }; },
      async update(data) { writes.push(JSON.parse(JSON.stringify(data))); } } });
  load(ctx, 'coach.html', 'coachUpdateAssignedFoodGrams');
  for (const value of ['-10', '', 'Infinity', '0']) {
    nodes['afg-food'].value = value;
    await ctx.coachUpdateAssignedFoodGrams('client', 'food', 100);
  }
  assert.equal(writes.length, 0);
  nodes['afg-food'].value = '160';
  await ctx.coachUpdateAssignedFoodGrams('client', 'food', 100);
  assert.equal(writes[0].calories, 400);
  assert.equal(writes[0].protein_g, 40);
  exists = false;
  await ctx.coachUpdateAssignedFoodGrams('client', 'food', 100);
  assert.equal(nodes['afg-save-food'].disabled, false);
});

test('service worker serves cached assets offline without an unhandled background rejection', async () => {
  const handlers = {}; let fetched = 0; const puts = [];
  const ctx = vm.createContext({ URL, location: { origin: 'https://evolve.test' },
    self: { addEventListener: (name, fn) => { handlers[name] = fn; } },
    caches: { match: async () => 'cached', open: async () => ({ put: async (...args) => puts.push(args) }) },
    fetch: async () => { fetched++; throw Error('offline'); } });
  vm.runInContext(read('sw.js'), ctx);
  let response; let background;
  handlers.fetch({ request: { url: 'https://evolve.test/shared.js' },
    respondWith(promise) { response = promise; }, waitUntil(promise) { background = promise; } });
  assert.equal(await response, 'cached');
  await background;
  assert.equal(fetched, 1);
  ctx.fetch = async () => ({ ok: false });
  handlers.fetch({ request: { url: 'https://evolve.test/shared.js' },
    respondWith(promise) { response = promise; }, waitUntil(promise) { background = promise; } });
  await response; await background;
  assert.equal(puts.length, 0);
  ctx.fetch = async () => { fetched++; return { ok: true, clone() { return this; } }; };
  ctx.caches.match = async () => null;
  handlers.fetch({ request: { url: 'https://fonts.googleapis.com/css2?family=Inter' }, respondWith(promise) { response = promise; } });
  await response;
  assert.equal(fetched, 2);
});
