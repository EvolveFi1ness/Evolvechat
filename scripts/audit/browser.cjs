// Uses an installed Playwright package and Chrome, with an isolated browser profile.
// No live Firebase data is read or written: SDK scripts are blocked and mocked.
// Start a static server, then run: node scripts/audit/browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.AUDIT_URL || 'http://127.0.0.1:8765';
const output = process.env.AUDIT_SCREENSHOTS || path.join(require('node:os').tmpdir(), 'evolve-audit-screenshots');
fs.mkdirSync(output, { recursive: true });

function mockFirebase() {
  window.__writes = [];
  window.__get = async () => ({ empty: true, docs: [], exists: false });
  class Query {
    constructor(path = '', filters = []) { this.path = path; this.filters = filters; }
    collection(name) { return new Query(this.path + '/' + name, this.filters); }
    doc(name) { return new Query(this.path + '/' + name, this.filters); }
    where(...filter) { return new Query(this.path, [...this.filters, filter]); }
    orderBy() { return this; } limit() { return this; } startAfter() { return this; }
    get() { return window.__get(this.path, this.filters); }
    onSnapshot() { return () => {}; }
    async update(data) { window.__writes.push({ path: this.path, data }); }
    async set(data) { window.__writes.push({ path: this.path, data }); }
    async add(data) { window.__writes.push({ path: this.path, data }); return { id: 'new' }; }
    async delete() { window.__writes.push({ path: this.path, deleted: true }); }
    async enablePersistence() {}
  }
  const db = new Query();
  const auth = { currentUser: null, onAuthStateChanged() { return () => {}; }, async signOut() { this.currentUser = null; } };
  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => null, delete: () => null, increment: n => n };
  firestore.Timestamp = { fromDate: date => date };
  window.firebase = { apps: [{}], auth: () => auth, firestore, storage: () => ({}) };
}

async function dialogChecks(page) {
  const trigger = page.locator('button:visible').first();
  await trigger.focus();
  await page.evaluate(() => {
    window.__confirmation = null;
    showConfirmDialog({ title: 'Remove this item?', message: 'This removes the selected food.', confirmText: 'Remove', danger: true })
      .then(result => { window.__confirmation = result; });
  });
  const dialog = page.getByRole('dialog', { name: 'Remove this item?' });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.closest('dialog')?.id), 'app-confirm-dialog');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__confirmation === false);
  assert.equal(await page.evaluate(() => document.activeElement.closest('dialog')), null);
  await page.evaluate(() => {
    showConfirmDialog({ title: 'Remove this item?', confirmText: 'Remove', danger: true })
      .then(result => { window.__confirmation = result; });
  });
  assert.equal(await page.evaluate(() => showConfirmDialog({ title: 'Repeated tap' })), false);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForFunction(() => window.__confirmation === true);
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.AUDIT_BROWSER || 'chrome' });
  const results = [];
  try {
    // Explicitly exercise the real SDK-unavailable startup path as well as mocks.
    for (const file of ['index.html', 'coach.html']) {
      const page = await browser.newPage({ serviceWorkers: 'block' });
      await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/' + file, { waitUntil: 'networkidle' });
      assert.deepEqual(errors, [], file + ' tolerates unavailable Firebase scripts');
      await page.close();
    }
    for (const file of ['index.html', 'coach.html']) {
      for (const width of [390, 1366]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
        await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
        await page.addInitScript(mockFirebase);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(base + '/' + file, { waitUntil: 'networkidle' });
        await dialogChecks(page);
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await page.screenshot({ path: path.join(output, `${file}-${width}-${theme}-auth.png`) });
          assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'login has no horizontal overflow');
        }
        if (file === 'index.html') {
          await page.evaluate(() => {
            firebase.auth().currentUser = { uid: 'fixture-client' };
            currentUid = 'fixture-client';
            showScreen('screen-home');
            setTab('nutrition');
          });
          await page.evaluate(() => openNutrFoodSearch('Meal 1'));
          const rows = page.locator('#nutr-search-results [role="button"]');
          assert.ok(await rows.count() > 0, 'cold food search loads results: ' + JSON.stringify(await page.evaluate(() => ({
            count: NUTR_FOODS?.length, category: nutrCatFilter, text: document.getElementById('nutr-search-results').textContent.slice(0, 200)
          }))));
          await page.locator('#nutr-search-input').fill('no-food-with-this-name-xyz');
          await page.locator('#nutr-search-clear').click();
          await page.waitForTimeout(250);
          assert.ok(await rows.count() > 0, 'clear cancels obsolete search');
          await rows.first().focus();
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => !!nutrDetailFood);
          assert.equal(await page.evaluate(() => nutrDetailServing), await page.evaluate(() => nutrDetailFood.serving_size_g || 100), 'detail starts at a standard serving');
          await page.evaluate(() => { closeNutrDetail(); });
          await page.locator('#nutr-detail-modal').waitFor({ state: 'hidden' });
          await page.evaluate(() => closeNutrFoodSearch());
          await page.evaluate(() => {
            const training = { dayType: 'Training Day', planName: 'Training target', calories: 2300 };
            const rest = { dayType: 'Rest Day', planName: 'Rest target', calories: 1900 };
            nutrPlan = training;
            nutrAllMacroPlans = [training, rest];
            nutrFoodLogs[nutrDateKey(nutrCurrentDate)] = { __assigned__: [
              { food_name: 'Training oats', dayType: 'Training Day', servingG: 100 },
              { food_name: 'Daily banana', dayType: '', servingG: 100 }
            ] };
            window._nutrDayTypeFilter = 'Training Day';
            renderNutritionTab();
          });
          const assigned = page.locator('#nutr-assigned-plan');
          const dayTabs = page.locator('#nutr-daytype-pills');
          await dayTabs.getByRole('button', { name: 'Rest day', exact: true }).click();
          assert.doesNotMatch(await assigned.innerText(), /Training oats|Training target/);
          assert.match(await assigned.innerText(), /Daily banana/);
          assert.match(await assigned.innerText(), /Rest target/);
          assert.equal(await page.locator('#nutr-target-cals').textContent(), '1900');
          await dayTabs.getByRole('button', { name: 'Training', exact: true }).click();
          assert.match(await assigned.innerText(), /Training oats/);
          assert.match(await assigned.innerText(), /Daily banana/);
          assert.equal(await page.locator('#nutr-target-cals').textContent(), '2300');
          await page.evaluate(() => {
            nutrFoodLogs[nutrDateKey(nutrCurrentDate)].__assigned__.push({ food_name: 'Rest rice', dayType: 'Rest Day', servingG: 100 });
          });
          await dayTabs.getByRole('button', { name: 'Rest day', exact: true }).click();
          assert.match(await assigned.innerText(), /Rest rice/);
          assert.doesNotMatch(await assigned.innerText(), /Training oats/);
          await page.evaluate(() => {
            nutrAllMacroPlans = nutrAllMacroPlans.filter(plan => plan.dayType === 'Training Day');
            nutrFoodLogs[nutrDateKey(nutrCurrentDate)].__assigned__ = nutrFoodLogs[nutrDateKey(nutrCurrentDate)].__assigned__.filter(food => food.dayType === 'Training Day');
            renderNutritionTab();
          });
          assert.match(await assigned.innerText(), /No foods assigned for this day type/);
          assert.equal(await dayTabs.getByRole('button', { name: 'Rest day', exact: true }).getAttribute('aria-pressed'), 'true');
          await dayTabs.getByRole('button', { name: 'Training', exact: true }).click();
          assert.match(await assigned.innerText(), /Training oats/);
          for (const tab of ['home', 'log', 'progress', 'chat', 'profile', 'nutrition']) {
            await page.evaluate(tab => setTab(tab), tab);
          }
          await page.evaluate(async () => {
            const auth = firebase.auth();
            const signOut = auth.signOut;
            auth.signOut = async () => { throw new Error('Fixture sign-out failure'); };
            await handleLogout();
            auth.signOut = signOut;
          });
          assert.equal(await page.evaluate(() => currentUid), 'fixture-client', 'failed sign-out preserves the active session');
          await page.evaluate(async () => {
            _customFoodsLoaded = true;
            NUTR_FOODS.push({ id: 'custom', food_name: 'Private custom food', createdBy: 'fixture-client' });
            localStorage.setItem('evolve_profile_cache', JSON.stringify({ uid: 'fixture-client', firstName: 'Fixture' }));
            await handleBlockedSignOut();
          });
          assert.equal(await page.evaluate(() => localStorage.getItem('evolve_profile_cache')), null);
          assert.equal(await page.evaluate(() => _customFoodsLoaded), false);
          assert.equal(await page.evaluate(() => NUTR_FOODS.some(nutrIsMyCustomFood)), false);
          assert.equal(await page.evaluate(() => currentUid), null);
        } else {
          await page.evaluate(() => {
            document.getElementById('auth-screen').style.display = 'none';
            document.getElementById('app').classList.add('visible');
            document.body.classList.add('app-ready');
            allClients = [{ uid: 'fixture-client', firstName: 'Fixture', lastName: 'Client' }];
            showPage('nutrition');
            openNutritionTools();
          });
          await page.waitForFunction(() => document.querySelectorAll('.food-db-item').length === 60);
          assert.equal(await page.locator('.food-db-item').count(), 60);
          const first = page.locator('.food-db-item').first();
          const kcal = await first.locator('.food-db-item-kcal').boundingBox();
          const quick = await first.locator('.food-db-quick-btn').boundingBox();
          assert.ok(kcal.x + kcal.width <= quick.x, 'calories do not overlap quick assign');
          await page.locator('.food-db-load-more').click();
          assert.equal(await page.locator('.food-db-item').count(), 120);
          await page.evaluate(async () => {
            document.getElementById('nutr-assign-client').value = 'fixture-client';
            window.__get = async () => ({ empty: false, docs: [
              { id: 'food', data: () => ({ food_name: 'Long food name with "quotes" & ingredients <oats> and a detailed serving description', dayType: '', mealSlot: 'Meal 1', calories: 200, servingG: 80 }) },
              { id: 'logged', data: () => ({ food_name: 'Logged banana', completed: true, dayType: '', mealSlot: 'Meal 1' }) }
            ] });
            await loadAssignedFoodsPanel();
          });
          const select = page.locator('#assigned-foods-list select');
          assert.equal(await select.count(), 1, 'only pending food is editable');
          await select.selectOption('Rest Day');
          await page.waitForFunction(() => window.__writes.some(write => write.data?.dayType === 'Rest Day'));
          assert.equal(await page.evaluate(() => document.querySelector('#assigned-foods-list oats')), null, 'food names are escaped');
          const a = await page.locator('#assigned-foods-list').boundingBox();
          assert.ok(a.width <= width, 'assigned-food panel fits viewport');
          // Slow client A must not replace client B after a selection change.
          await page.evaluate(async () => {
            let resolveOld;
            __get = () => new Promise(resolve => { resolveOld = resolve; });
            const old = loadAssignedFoodsPanel();
            document.getElementById('nutr-assign-client').value = '';
            await loadAssignedFoodsPanel();
            resolveOld({ empty: true, docs: [] });
            await old;
          });
          assert.match(await page.locator('#assigned-foods-list').innerText(), /Select a client/);
          await page.evaluate(() => { __get = async () => ({ empty: true, docs: [], exists: false }); });
          for (const tab of ['clients', 'workouts', 'chat', 'settings', 'dashboard', 'nutrition']) {
            await page.evaluate(tab => showPage(tab), tab);
          }
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
        await page.screenshot({ path: path.join(output, `${file}-${width}-workflow.png`), fullPage: true });
        assert.deepEqual(errors, [], file + ' runtime errors');
        results.push(`${file}: ${width}px, both themes, dialog keyboard/cancel/confirm, food workflow, reduced motion`);
        await page.close();
      }
    }
    console.log(JSON.stringify({ passed: results, screenshots: output }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
