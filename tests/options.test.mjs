import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../src/shared.js', import.meta.url), 'utf8');

async function createHarness(initialStorage = {}) {
  const storage = structuredClone(initialStorage);
  const controls = new Map();
  const writes = [];
  const messages = [];
  const element = (selector) => {
    if (!controls.has(selector)) {
      controls.set(selector, {
        value: '', type: selector === '#api-key' ? 'password' : 'text',
        checked: false, hidden: false, disabled: false, textContent: '', dataset: {},
        handlers: new Map(), attrs: {},
        addEventListener(type, callback) { this.handlers.set(type, callback); },
        setAttribute(name, value) { this.attrs[name] = value; },
        querySelectorAll() { return [...controls.values()].filter((item) => item !== this); },
        reportValidity() { return element('#prompt').value.length >= 20; },
        closest() { return null; }
      });
    }
    return controls.get(selector);
  };
  const chrome = {
    storage: {local: {
      async get(keys) {
        const selected = Array.isArray(keys) ? keys : [keys];
        return structuredClone(Object.fromEntries(selected.map((key) => [key, storage[key]])));
      },
      async set(values) { writes.push(structuredClone(values)); Object.assign(storage, structuredClone(values)); }
    }},
    runtime: {async sendMessage(message) {
      messages.push(message);
      return {ok: true, model: 'mock-jev', score: 0.8};
    }}
  };
  const context = vm.createContext({chrome, document: {querySelector: element}, console});
  vm.runInContext(shared, context);
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  const dispatch = async (selector, type) => {
    const target = element(selector);
    await target.handlers.get(type)?.({target, preventDefault() {}});
  };
  const switchProvider = async (provider) => {
    element('#provider').value = provider;
    await dispatch('#provider', 'change');
  };
  const typeKey = async (key) => {
    element('#api-key').value = key;
    await dispatch('#api-key', 'input');
  };
  return {storage, writes, messages, element, dispatch, switchProvider, typeKey};
}

const ui = await createHarness({apiKey: 'fake-typesafe', openRouterApiKey: 'fake-openrouter'});
assert.equal(ui.element('#api-key').value, 'fake-typesafe');
assert.equal(ui.element('#provider').value, 'typesafe');
assert.equal(ui.element('#context-guard-enabled').checked, false);
assert.equal(ui.element('#remote-analysis-enabled').checked, false);
ui.element('#context-guard-enabled').checked = true;
assert.equal(ui.element('#api-key').type, 'password');
await ui.dispatch('#toggle-key', 'click');
assert.equal(ui.element('#api-key').type, 'text');
await ui.switchProvider('openrouter');
assert.equal(ui.element('#api-key').type, 'password');
assert.equal(ui.element('#api-key').value, 'fake-openrouter');
assert.equal(ui.element('#toggle-key').attrs['aria-pressed'], 'false');
assert.match(ui.element('#key-help').textContent, /OpenRouter vers TypeSafe/);
await ui.typeKey('fake-new-openrouter');
await ui.switchProvider('typesafe');
assert.equal(ui.element('#api-key').value, 'fake-typesafe');
await ui.switchProvider('openrouter');
assert.equal(ui.element('#api-key').value, 'fake-new-openrouter');
await ui.dispatch('#settings-form', 'submit');
assert.equal(ui.storage.apiKey, 'fake-typesafe');
assert.equal(ui.storage.openRouterApiKey, 'fake-new-openrouter');
assert.equal(ui.storage.userSettings.provider, 'openrouter');
assert.equal(ui.storage.userSettings.contextGuardEnabled, true);
assert.equal(ui.storage.userSettings.remoteAnalysisEnabled, false, 'Saving a key does not opt in');
assert.ok(!('apiKey' in ui.writes.at(-1)), 'Untouched key must not be rewritten');

ui.storage.apiKey = 'fake-key-saved-in-other-window';
ui.element('#threshold').value = '85';
await ui.dispatch('#threshold', 'input');
await ui.dispatch('#settings-form', 'submit');
assert.equal(ui.storage.apiKey, 'fake-key-saved-in-other-window');
assert.deepEqual(Object.keys(ui.writes.at(-1)), ['userSettings']);
assert.equal(ui.storage.userSettings.threshold, 0.85);
assert.equal(ui.storage.userSettings.blurThreshold, 0.85);

const reopened = await createHarness(ui.storage);
assert.equal(reopened.element('#provider').value, 'openrouter');
assert.equal(reopened.element('#context-guard-enabled').checked, true);
assert.equal(reopened.element('#remote-analysis-enabled').checked, false);
assert.equal(reopened.element('#threshold').value, '85');
assert.equal(reopened.element('#api-key').value, 'fake-new-openrouter');
await reopened.dispatch('#test-connection', 'click');
assert.equal(reopened.messages.length, 1);
assert.equal(reopened.messages[0].type, 'TEST_CONNECTION');
reopened.element('#remote-analysis-enabled').checked = true;
await reopened.dispatch('#test-connection', 'click');
assert.equal(reopened.storage.userSettings.remoteAnalysisEnabled, false, 'Tester does not grant consent');
await reopened.dispatch('#settings-form', 'submit');
assert.equal(reopened.storage.userSettings.remoteAnalysisEnabled, true);
const consented = await createHarness(reopened.storage);
assert.equal(consented.element('#remote-analysis-enabled').checked, true);
await consented.switchProvider('typesafe');
assert.equal(consented.element('#remote-analysis-enabled').checked, true);
consented.element('#remote-analysis-enabled').checked = false;
await consented.dispatch('#settings-form', 'submit');
assert.equal(consented.storage.userSettings.remoteAnalysisEnabled, false);
assert.equal((await createHarness({userSettings:{remoteAnalysisEnabled:'true'}})).element('#remote-analysis-enabled').checked, false);

const empty = await createHarness();
await empty.dispatch('#settings-form', 'submit');
assert.equal(empty.storage.userSettings.provider, 'typesafe');
assert.equal(empty.storage.userSettings.contextGuardEnabled, false);
assert.equal(empty.storage.userSettings.remoteAnalysisEnabled, false);
assert.match(empty.element('#status').textContent, /enregistrés/);
await empty.switchProvider('openrouter');
await empty.dispatch('#test-connection', 'click');
assert.equal(empty.messages.length, 0);
assert.match(empty.element('#status').textContent, /clé API OpenRouter/);
assert.equal(empty.element('#test-connection').disabled, false);
empty.element('#prompt').value = 'court';
await empty.dispatch('#test-connection', 'click');
assert.equal(empty.element('#test-connection').disabled, false);
assert.equal(empty.messages.length, 0);

console.log('PASS: Legacy key, provider switching, isolated drafts, masked key, dirty-key saves, concurrent key preservation, thresholds, persistence, missing key and invalid prompt. No network request.');
