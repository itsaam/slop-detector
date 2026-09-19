import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const extensionUrl = (path) => `chrome-extension://test-extension/${path}`;
const tweet = { type: "ANALYZE_TWEET", tweetId: "2100976648552169805", text: "10 habits that will change your life forever." };

function createHarness() {
  const storage = {
    apiKey: "test-typesafe-key",
    userSettings: {
      model: "jev-latest", threshold: 0.65, blurEnabled: false, blurThreshold: 0.78,
      remoteAnalysisEnabled: true,
      prompt: "Does this social post primarily contain generic engagement bait or AI slop?"
    }
  };
  let messageHandler;
  let storageHandler;
  let installHandler;
  const requests = [];
  const broadcasts = [];
  const harness = {
    storage, requests, broadcasts,
    response: { status: 200, body: { answers: { slop: { type: "noul", noul: 0.87 } } } },
    fetchError: null,
    fetchGate: null,
    install: () => installHandler(),
    send(message, url = "https://x.com/home") {
      return new Promise((resolve) => {
        assert.equal(messageHandler(message, { url }, resolve), true);
      });
    },
    async change(changes, area = "local") {
      storageHandler(changes, area);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      onInstalled: { addListener(handler) { installHandler = handler; } },
      onStartup: { addListener() {} },
      onMessage: { addListener(handler) { messageHandler = handler; } },
      openOptionsPage: async () => {},
      getURL: extensionUrl
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async (tabId, message) => { broadcasts.push({ tabId, message }); }
    },
    storage: {
      onChanged: { addListener(handler) { storageHandler = handler; } },
      local: {
        async get(keys) {
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(wanted.filter((key) => key in storage).map((key) => [key, storage[key]]));
        },
        async set(values) { Object.assign(storage, values); },
        async setAccessLevel() {}
      }
    }
  };
  const context = vm.createContext({
    chrome, AbortController, clearTimeout, console, setTimeout, URL,
    importScripts(path) {
      assert.equal(path, "shared.js");
      vm.runInContext(fs.readFileSync(new URL("../src/shared.js", import.meta.url), "utf8"), context);
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (harness.fetchGate) await harness.fetchGate;
      if (harness.fetchError) throw harness.fetchError;
      const { status, body } = harness.response;
      return { ok: status >= 200 && status < 300, status, async json() { return body; } };
    }
  });
  vm.runInContext(source, context);
  harness.shared = context.SlopShared;
  return harness;
}

test("fresh installation requires explicit consent before sending post text", async () => {
  const app = createHarness();
  delete app.storage.userSettings;
  await app.install();
  assert.equal(app.shared.DEFAULT_SETTINGS.remoteAnalysisEnabled, false);
  assert.equal(app.storage.userSettings.remoteAnalysisEnabled, false);
  const publicSettings = await app.send({ type: "GET_PUBLIC_SETTINGS" });
  assert.equal(publicSettings.settings.remoteAnalysisEnabled, false);
  const result = await app.send(tweet);
  assert.equal(result.code, "CONSENT_REQUIRED");
  assert.match(result.message, /^Autorisez/);
  assert.equal(app.requests.length, 0);
  assert.equal(app.storage.analysisCache, undefined);
});

test("existing settings without consent migrate to false without losing keys or preferences", async () => {
  const app = createHarness();
  delete app.storage.userSettings.remoteAnalysisEnabled;
  app.storage.openRouterApiKey = "test-openrouter-key";
  const originalSettings = { ...app.storage.userSettings };
  await app.install();
  assert.deepEqual({ ...app.storage.userSettings }, { ...originalSettings, remoteAnalysisEnabled: false });
  assert.equal(app.storage.apiKey, "test-typesafe-key");
  assert.equal(app.storage.openRouterApiKey, "test-openrouter-key");
  assert.equal((await app.send(tweet)).code, "CONSENT_REQUIRED");
  assert.equal(app.requests.length, 0);
});

test("consent migration also runs when settings are read before the install event", async () => {
  const app = createHarness();
  delete app.storage.userSettings.remoteAnalysisEnabled;
  const result = await app.send(tweet);
  assert.equal(result.code, "CONSENT_REQUIRED");
  assert.equal(app.storage.userSettings.remoteAnalysisEnabled, false);
  assert.equal(app.requests.length, 0);
});

test("only a strict boolean opt-in enables remote analysis", async () => {
  const app = createHarness();
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    app.storage.userSettings.remoteAnalysisEnabled = value;
    const publicSettings = await app.send({ type: "GET_PUBLIC_SETTINGS" });
    assert.equal(publicSettings.settings.remoteAnalysisEnabled, false);
    assert.equal(app.storage.userSettings.remoteAnalysisEnabled, false);
    assert.equal((await app.send(tweet)).code, "CONSENT_REQUIRED");
  }
  assert.equal(app.requests.length, 0);
  app.storage.userSettings.remoteAnalysisEnabled = true;
  assert.equal((await app.send(tweet)).ok, true);
  assert.equal(app.requests.length, 1);
});

test("revoking consent blocks cached results and fresh requests without exposing credentials", async () => {
  const app = createHarness();
  assert.equal((await app.send(tweet)).ok, true);
  assert.equal((await app.send(tweet)).cached, true);
  app.storage.userSettings.remoteAnalysisEnabled = false;
  for (const message of [tweet, { ...tweet, tweetId: "2100976648552169806" }]) {
    const result = await app.send(message);
    assert.equal(result.ok, false);
    assert.equal(result.code, "CONSENT_REQUIRED");
    assert.equal(result.result, undefined);
    assert.doesNotMatch(JSON.stringify(result), /test-typesafe-key|test-openrouter-key/);
  }
  assert.equal(app.requests.length, 1);
  await app.change({ userSettings: { newValue: app.storage.userSettings } });
  assert.equal(app.broadcasts.at(-1).message.settings.remoteAnalysisEnabled, false);
  assert.doesNotMatch(JSON.stringify(app.broadcasts), /test-typesafe-key|test-openrouter-key/);
});

test("revocation prevents queued requests from sending and suppresses pending results", async () => {
  const app = createHarness();
  let releaseRequests;
  app.fetchGate = new Promise((resolve) => { releaseRequests = resolve; });
  const responses = Array.from({ length: 5 }, (_, index) => app.send({ ...tweet, tweetId: String(2100000000 + index) }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.requests.length, 3);
  app.storage.userSettings.remoteAnalysisEnabled = false;
  releaseRequests();
  for (const result of await Promise.all(responses)) {
    assert.equal(result.code, "CONSENT_REQUIRED");
    assert.equal(result.result, undefined);
  }
  assert.equal(app.requests.length, 3);
  assert.equal(app.storage.analysisCache, undefined);
});

test("connection tests use only synthetic text even with consent disabled", async () => {
  const app = createHarness();
  app.storage.userSettings.remoteAnalysisEnabled = false;
  const result = await app.send({ type: "TEST_CONNECTION", text: "PRIVATE POST THAT MUST NOT BE SENT" }, extensionUrl("options/popup.html"));
  assert.equal(result.ok, true);
  const payload = JSON.parse(app.requests[0].options.body);
  assert.equal(payload.state, "10 habits that will change your life forever. Number 7 will surprise you.");
  assert.doesNotMatch(app.requests[0].options.body, /PRIVATE POST/);
});

test("legacy TypeSafe sends a direct noul request using its original key", async () => {
  const app = createHarness();
  const result = await app.send(tweet);
  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.equal(result.result.score, 0.87);
  assert.equal(result.result.provider, "typesafe");
  const { url, options } = app.requests[0];
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer test-typesafe-key");
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  const payload = JSON.parse(options.body);
  assert.equal(payload.model, "jev-latest");
  assert.equal(payload.questions.slop.type, "noul");
  assert.ok(payload.questions.slop.instructions.startsWith(app.shared.SYSTEM_INSTRUCTIONS));
  assert.ok(payload.questions.slop.instructions.endsWith(app.storage.userSettings.prompt));
  assert.equal(payload.state, tweet.text);
  assert.deepEqual(Object.keys(payload.questions.slop.criteria), ["true", "false"]);
});

test("repeat tweets use the persistent cache", async () => {
  const app = createHarness();
  await app.send(tweet);
  assert.equal((await app.send(tweet)).cached, true);
  assert.equal(app.requests.length, 1);
});

test("OpenRouter routes its own key to Decisions with the latest alias", async () => {
  const app = createHarness();
  app.storage.userSettings.provider = "openrouter";
  app.storage.openRouterApiKey = "test-openrouter-key";
  const result = await app.send(tweet);
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, "openrouter");
  assert.equal(app.requests[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(app.requests[0].options.headers.Authorization, "Bearer test-openrouter-key");
  const payload = JSON.parse(app.requests[0].options.body);
  assert.equal(payload.model, "~typesafe/jev-latest");
  assert.equal(payload.questions.slop.type, "noul");
  assert.equal(payload.state, tweet.text);
});

test("fixed model maps per provider and caches remain separate", async () => {
  const app = createHarness();
  app.storage.userSettings.model = "jev-1.13.0";
  await app.send(tweet);
  assert.equal(JSON.parse(app.requests[0].options.body).model, "jev-1.13.0");
  app.storage.userSettings.provider = "openrouter";
  app.storage.openRouterApiKey = "test-openrouter-key";
  assert.equal((await app.send(tweet)).cached, false);
  assert.equal(app.requests.length, 2);
  assert.equal(JSON.parse(app.requests[1].options.body).model, "typesafe/jev-1.13");
  assert.equal((await app.send(tweet)).cached, true);
  app.storage.userSettings.provider = "typesafe";
  assert.equal((await app.send(tweet)).cached, true);
  assert.equal(app.requests.length, 2);
});

test("missing OpenRouter key never falls back to saved TypeSafe key", async () => {
  const app = createHarness();
  app.storage.userSettings.provider = "openrouter";
  const result = await app.send(tweet);
  assert.equal(result.code, "NO_API_KEY");
  assert.match(result.message, /OpenRouter/);
  assert.equal(app.requests.length, 0);
  assert.equal((await app.send({ type: "GET_PUBLIC_SETTINGS" })).hasApiKey, false);
});

test("missing TypeSafe key never falls back to saved OpenRouter key", async () => {
  const app = createHarness();
  delete app.storage.apiKey;
  app.storage.openRouterApiKey = "test-openrouter-key";
  assert.equal((await app.send(tweet)).code, "NO_API_KEY");
  assert.equal(app.requests.length, 0);
});

test("unknown providers fail closed without requests", async () => {
  const app = createHarness();
  for (const provider of ["custom", "https://example.com", "__proto__", "", null]) {
    app.storage.userSettings.provider = provider;
    assert.equal((await app.send(tweet)).code, "INVALID_PROVIDER");
  }
  assert.equal(app.requests.length, 0);
});

test("public settings and key-change broadcasts never expose credentials", async () => {
  const app = createHarness();
  app.storage.openRouterApiKey = "test-openrouter-key";
  const result = await app.send({ type: "GET_PUBLIC_SETTINGS" });
  assert.equal(result.ok, true);
  assert.equal(result.settings.provider, "typesafe");
  assert.equal(result.settings.remoteAnalysisEnabled, true);
  assert.equal(result.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(result), /test-typesafe-key|test-openrouter-key|openRouterApiKey/);
  for (const key of ["apiKey", "openRouterApiKey", "userSettings"]) {
    await app.change({ [key]: { newValue: app.storage[key] } });
  }
  assert.equal(app.broadcasts.length, 3);
  assert.ok(app.broadcasts.every(({ message }) => message.settings.remoteAnalysisEnabled === true));
  assert.doesNotMatch(JSON.stringify(app.broadcasts), /test-typesafe-key|test-openrouter-key|openRouterApiKey/);
});

test("connection tests accept both exact settings pages", async () => {
  const app = createHarness();
  for (const page of ["options/options.html", "options/popup.html", "options/popup.html?test=1#settings"]) {
    assert.equal((await app.send({ type: "TEST_CONNECTION" }, extensionUrl(page))).ok, true);
  }
  assert.equal(app.requests.length, 3);
});

test("unauthorized senders cannot test connections or analyze tweets", async () => {
  const app = createHarness();
  for (const url of ["https://x.com/home", "https://example.com", extensionUrl("options/popup.html/fake"), "chrome-extension://other/options/popup.html"]) {
    assert.equal((await app.send({ type: "TEST_CONNECTION" }, url)).code, "FORBIDDEN");
  }
  for (const url of ["https://x.com.evil.example", "https://example.com", "http://x.com/home", "not a URL"]) {
    assert.equal((await app.send(tweet, url)).code, "FORBIDDEN");
  }
  assert.equal(app.requests.length, 0);
});

for (const [status, code] of [[401, "INVALID_API_KEY"], [402, "INSUFFICIENT_CREDITS"], [403, "API_ACCESS_DENIED"], [429, "API_BUSY"], [529, "API_BUSY"], [500, "API_ERROR"]]) {
  test(`HTTP ${status} returns a safe error without raw provider details`, async () => {
    const app = createHarness();
    app.storage.userSettings.provider = "openrouter";
    app.storage.openRouterApiKey = "test-openrouter-key";
    app.response = { status, body: { error: { message: "sensitive-provider-message test-openrouter-key" } } };
    const result = await app.send(tweet);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.doesNotMatch(result.message, /sensitive-provider-message|test-openrouter-key/);
    assert.equal(app.storage.analysisCache, undefined);
  });
}

test("invalid noul scores do not become success badges", async () => {
  const app = createHarness();
  for (const noul of [undefined, null, "0.5", -0.1, 1.1, NaN]) {
    app.response.body = { answers: { slop: { noul } } };
    assert.equal((await app.send(tweet)).code, "BAD_API_RESPONSE");
  }
  assert.equal(app.storage.analysisCache, undefined);
});

test("network errors never expose raw messages", async () => {
  const app = createHarness();
  app.fetchError = new TypeError("sensitive-provider-message test-typesafe-key");
  const result = await app.send(tweet);
  assert.equal(result.code, "API_NETWORK");
  assert.doesNotMatch(result.message, /sensitive-provider-message|test-typesafe-key/);
});

test("provider changes participate in content-script cache invalidation", () => {
  const content = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  assert.ok(content.includes('settings.provider || "typesafe"'));
  assert.ok(content.includes('message.settings.provider || "typesafe"'));
});

test("short media captions receive the real model score without an uncertain verdict", async () => {
  const app = createHarness();
  for (const mainText of ["Bonne technique pour éviter l’amende", "AI almost threw us in WW3..."]) {
    const result = await app.send({ ...tweet, text: mainText, context: {
      hasMedia: true, mainText,
      quotedText: "This is a much longer quoted news article with specific reporting, many details, and enough words to exceed the caption length limit.",
      isTruncated: false
    } });
    assert.equal(result.ok, true);
    assert.equal(result.result.verdict, undefined);
    assert.equal(result.result.score, 0.87);
  }
  assert.equal(app.requests.length, 2);
});

test("truncated visible text is scored with its context rather than showing a third verdict", async () => {
  const app = createHarness();
  const result = await app.send({ ...tweet, context: {
    hasMedia: false, mainText: tweet.text, quotedText: "", isTruncated: true
  } });
  assert.equal(result.result.verdict, undefined);
  assert.equal(result.result.score, 0.87);
  assert.equal(app.requests.length, 1);
  assert.equal(JSON.parse(JSON.parse(app.requests[0].options.body).state).isTruncated, true);
});

test("enabling the optional context guard abstains and disabling it resumes classification", async () => {
  const app = createHarness();
  const message = {...tweet, text: "Bonne technique pour éviter l’amende", context: {
    hasMedia: true, mainText: "Bonne technique pour éviter l’amende", quotedText: "", isTruncated: false
  }};
  assert.equal((await app.send({type:"GET_PUBLIC_SETTINGS"})).settings.contextGuardEnabled, false);
  app.storage.userSettings.contextGuardEnabled = true;
  const uncertain = await app.send(message);
  assert.equal(uncertain.result.verdict, "uncertain");
  assert.equal(uncertain.result.score, null);
  assert.equal(app.requests.length, 0);
  app.storage.userSettings.contextGuardEnabled = false;
  const scored = await app.send(message);
  assert.equal(scored.result.score, 0.87);
  assert.equal(scored.result.verdict, undefined);
  assert.equal(app.requests.length, 1);
  app.storage.userSettings.contextGuardEnabled = true;
  assert.equal((await app.send(message)).result.verdict, "uncertain");
  assert.equal(app.requests.length, 1);
});

test("malformed contexts are rejected before any request", async () => {
  const app = createHarness();
  const valid = { hasMedia: false, mainText: tweet.text, quotedText: "", isTruncated: false };
  for (const context of [null, [], "media", { ...valid, hasMedia: "true" }, { ...valid, isTruncated: 1 }, { ...valid, mainText: {} }, { ...valid, quotedText: "x".repeat(12001) }]) {
    assert.equal((await app.send({ ...tweet, context })).code, "BAD_CONTEXT");
  }
  assert.equal(app.requests.length, 0);
});

test("the word AI alone does not bypass classification or become an automatic verdict", async () => {
  const app = createHarness();
  const result = await app.send({ ...tweet, text: "AI" });
  assert.equal(app.requests.length, 1);
  assert.equal(result.result.score, 0.87);
  const instructions = JSON.parse(app.requests[0].options.body).questions.slop.instructions;
  assert.match(instructions, /mentions? of AI, IA, or ChatGPT/i);
});

test("media-only posts cannot invent a score without text", async () => {
  const app = createHarness();
  delete app.storage.apiKey;
  for (const isTruncated of [false, true]) {
    const result = await app.send({ ...tweet, text: "", context: {
      hasMedia: true, mainText: "", quotedText: "", isTruncated
    } });
    assert.equal(result.ok, false);
    assert.equal(result.code, "BAD_TWEET");
  }
  assert.equal(app.requests.length, 0);
});

test("18-word media caption is analyzed with quoted text explicitly separated", async () => {
  const app = createHarness();
  const mainText = "The camera shows the player stepping away from the defender before making a pass to his teammate today.";
  const quotedText = "Like, reply and share this post to win a prize.";
  const context = { hasMedia: true, mainText, quotedText, isTruncated: false };
  const result = await app.send({ ...tweet, text: mainText, context });
  assert.equal(result.ok, true);
  assert.equal(app.requests.length, 1);
  const payload = JSON.parse(app.requests[0].options.body);
  assert.deepEqual(JSON.parse(payload.state), { mainText, quotedText, hasMedia: true, isTruncated: false });
  assert.match(payload.questions.slop.instructions, /quotedText belongs to another author/);
  await app.send({ ...tweet, text: mainText, context: { ...context, quotedText: "A different quoted context." } });
  assert.equal(app.requests.length, 2);
});

test("caption length no longer creates a separate abstention category", async () => {
  const app = createHarness();
  for (const wordCount of [1, 17, 18]) {
    const mainText = Array.from({ length: wordCount }, (_, index) => `word${index}`).join(" ");
    const result = await app.send({ ...tweet, text: mainText, context: { hasMedia: true, mainText, quotedText: "", isTruncated: false } });
    assert.equal(result.result.score, 0.87);
  }
  assert.equal(app.requests.length, 3);
});

test("context cannot substitute a different author's main text", async () => {
  const app = createHarness();
  const result = await app.send({ ...tweet, context: { hasMedia: false, mainText: "different author text", quotedText: "", isTruncated: false } });
  assert.equal(result.code, "BAD_CONTEXT");
  assert.equal(app.requests.length, 0);
});

test("legacy default prompt is migrated without touching credentials or custom settings", async () => {
  const app = createHarness();
  app.storage.userSettings.prompt = app.shared.LEGACY_PROMPT;
  app.storage.userSettings.threshold = 0.72;
  app.storage.openRouterApiKey = "test-openrouter-key";
  const settings = (await app.send({ type: "GET_PUBLIC_SETTINGS" })).settings;
  assert.equal(settings.prompt, app.shared.DEFAULT_SETTINGS.prompt);
  assert.equal(app.storage.userSettings.prompt, app.shared.DEFAULT_SETTINGS.prompt);
  assert.equal(settings.threshold, 0.72);
  assert.equal(settings.blurThreshold, 0.72);
  assert.equal(settings.remoteAnalysisEnabled, true);
  assert.equal(app.storage.apiKey, "test-typesafe-key");
  assert.equal(app.storage.openRouterApiKey, "test-openrouter-key");
});

test("custom prompts remain unchanged but mandatory guardrails still apply", async () => {
  const app = createHarness();
  const customPrompt = "My own definition focuses only on repetitive marketing claims.";
  app.storage.userSettings.prompt = customPrompt;
  await app.send(tweet);
  assert.equal(app.storage.userSettings.prompt, customPrompt);
  const instructions = JSON.parse(app.requests[0].options.body).questions.slop.instructions;
  assert.ok(instructions.startsWith(app.shared.SYSTEM_INSTRUCTIONS));
  assert.ok(instructions.endsWith(customPrompt));
});

test("policy version prevents reusing scores from the original cache format", async () => {
  const app = createHarness();
  const input = `typesafe\njev-latest\n${app.storage.userSettings.prompt}\n${tweet.text}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193);
  const oldId = `${tweet.tweetId}:${(hash >>> 0).toString(36)}`;
  app.storage.analysisCache = { [oldId]: { result: { score: 0.99 }, touchedAt: Date.now() } };
  const result = await app.send(tweet);
  assert.equal(result.cached, false);
  assert.equal(result.result.score, 0.87);
  assert.equal(app.requests.length, 1);
  assert.ok(Object.keys(app.storage.analysisCache).some((key) => key.startsWith(`${app.shared.POLICY_VERSION}:`)));
});
