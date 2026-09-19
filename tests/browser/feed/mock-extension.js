(() => {
  let messageHandler;
  let storageHandler;
  const contentHandlers = [];
  let calls = 0;
  const store = {apiKey: 'fixture-only-key', userSettings: {...SlopShared.DEFAULT_SETTINGS, blurEnabled: true, remoteAnalysisEnabled: true}};
  globalThis.importScripts = (path) => {
    if (path !== 'shared.js' || !globalThis.SlopShared) throw new Error('Missing shared fixture script');
  };
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(target) { queueMicrotask(() => this.callback([{isIntersecting: true, target}])); }
    unobserve() {}
  };
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(handler) { if (!messageHandler) messageHandler = handler; else contentHandlers.push(handler); } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: (path) => `chrome-extension://fixture/${path}`,
      openOptionsPage: async () => {},
      sendMessage: (message) => new Promise((resolve) => messageHandler(message, {url:'https://x.com/home'}, resolve))
    },
    tabs: {query: async () => [{id:1}], sendMessage: async (_id,message) => contentHandlers.forEach((handler) => handler(message))},
    storage: {
      onChanged: {addListener(handler) {storageHandler=handler;}},
      local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]])),
        set: async (values) => {Object.assign(store, values); storageHandler?.(Object.fromEntries(Object.entries(values).map(([key,newValue]) => [key,{newValue}])), 'local');},
        setAccessLevel: async () => {}
      }
    }
  };
  document.querySelector('#fixture-context-guard').addEventListener('change', (event) => {
    chrome.storage.local.set({userSettings:{...store.userSettings, contextGuardEnabled:event.target.checked}});
  });
  // Deterministic responses only: no billable API calls or network access.
  globalThis.fetch = async (_url, request) => {
    calls += 1;
    document.querySelector('#fixture-calls').textContent = `${calls} appels simulés`;
    const {state} = JSON.parse(request.body);
    const slop = state.includes('10 habits');
    return {ok:true, status:200, json:async () => ({model:'fixture-jev', answers:{slop:{noul:slop ? 0.69 : 0.18}}})};
  };
})();
