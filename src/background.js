importScripts("shared.js");
const { DEFAULT_SETTINGS, LEGACY_PROMPT, POLICY_VERSION, SYSTEM_INSTRUCTIONS } = globalThis.SlopShared;

const PROVIDERS = Object.freeze({
  typesafe: { name: "TypeSafe", url: "https://api.typesafe.ai/v1/systemone", key: "apiKey" },
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/alpha/decisions", key: "openRouterApiKey" }
});
const CACHE_KEY = "analysisCache";
const SETTINGS_KEY = "userSettings";
const MAX_CACHE_ENTRIES = 1000;
const MAX_CONCURRENT_REQUESTS = 3;

const inflight = new Map();
const requestQueue = [];
let activeRequests = 0;
let cacheWriteQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  await protectLocalStorage();
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  } else {
    await migrateSettings(stored[SETTINGS_KEY]);
  }
});

chrome.runtime.onStartup.addListener(protectLocalStorage);
protectLocalStorage();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes[SETTINGS_KEY] || changes.apiKey || changes.openRouterApiKey)) {
    broadcastSettings().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        code: error.code || "INTERNAL_ERROR",
        message: error.code ? error.message : "Erreur inattendue. Réessayez dans un instant."
      });
    });
  return true;
});

async function protectLocalStorage() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older Chromium builds do not expose setAccessLevel. The content script
    // never reads storage directly, so the key still stays outside the page DOM.
  }
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    throw codedError("BAD_REQUEST", "Message invalide.");
  }

  if (message.type === "GET_PUBLIC_SETTINGS") {
    assertXSender(sender);
    const { settings, apiKey } = await getConfiguration();
    return { ok: true, settings, hasApiKey: Boolean(apiKey) };
  }

  if (message.type === "ANALYZE_TWEET") {
    assertXSender(sender);
    return analyzeTweet(message.tweetId, message.text, message.context);
  }

  if (message.type === "OPEN_OPTIONS") {
    assertXSender(sender);
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }

  if (message.type === "TEST_CONNECTION") {
    assertOptionsSender(sender);
    const { settings, apiKey } = await getConfiguration();
    if (!apiKey) {
      throw missingKeyError(settings.provider);
    }
    const result = await enqueueRequest(() =>
      callJev({
        apiKey,
        settings,
        text: "10 habits that will change your life forever. Number 7 will surprise you."
      })
    );
    return { ok: true, model: result.model, score: result.score };
  }

  throw codedError("BAD_REQUEST", "Action inconnue.");
}

async function analyzeTweet(tweetId, text, rawContext) {
  const normalizedId = String(tweetId || "").trim();
  if (!/^\d{5,30}$/.test(normalizedId) || typeof text !== "string") {
    throw codedError("BAD_TWEET", "Le post ne contient pas assez de texte a analyser.");
  }
  if (text.length > 12000) {
    throw codedError("BAD_TWEET", "Le post est trop long pour cette version.");
  }
  const normalizedText = normalizeText(text);
  const context = validateContext(rawContext, normalizedText);
  const { settings, apiKey } = await getConfiguration();
  assertRemoteAnalysisConsent(settings);
  const wordCount = normalizedText ? normalizedText.split(/\s+/u).length : 0;
  const reason = context?.isTruncated ? "truncated" : context?.hasMedia && wordCount < 18 ? "media_context" : null;
  if (settings.contextGuardEnabled && reason) {
    return {
      ok: true,
      cached: false,
      result: {
        score: null,
        verdict: "uncertain",
        reason,
        model: settings.model,
        provider: settings.provider,
        analyzedAt: Date.now()
      }
    };
  }
  if (!normalizedText) {
    throw codedError("BAD_TWEET", "Le post ne contient pas assez de texte à analyser.");
  }
  if (!apiKey) {
    throw missingKeyError(settings.provider);
  }

  const state = context ? JSON.stringify(context) : normalizedText;
  const cacheId = `${POLICY_VERSION}:${normalizedId}:${fingerprint(
    `${settings.provider}\n${settings.model}\n${settings.prompt}\n${state}`
  )}`;
  const cached = await readCacheEntry(cacheId);
  await requireCurrentConsent();
  if (cached) {
    return { ok: true, result: cached.result, cached: true };
  }

  if (inflight.has(cacheId)) {
    return inflight.get(cacheId);
  }

  const task = enqueueRequest(async () => {
    // Consent can be revoked while this post waits behind another request.
    await requireCurrentConsent();
    const result = await callJev({ apiKey, settings, text: state });
    await requireCurrentConsent();
    await writeCacheEntry(cacheId, result);
    await requireCurrentConsent();
    return { ok: true, result, cached: false };
  }).finally(() => inflight.delete(cacheId));

  inflight.set(cacheId, task);
  return task;
}

async function getConfiguration() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, "apiKey", "openRouterApiKey"]);
  const settings = sanitizeSettings(await migrateSettings(stored[SETTINGS_KEY]));
  const key = stored[PROVIDERS[settings.provider].key];
  return {
    settings,
    apiKey: typeof key === "string" ? key.trim() : ""
  };
}

async function migrateSettings(candidate) {
  const existing = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  const migrated = { ...existing };
  let changed = candidate !== existing;
  if (typeof existing.remoteAnalysisEnabled !== "boolean") {
    migrated.remoteAnalysisEnabled = false;
    changed = true;
  }
  if (typeof existing.prompt === "string" && existing.prompt.trim() === LEGACY_PROMPT) {
    migrated.prompt = DEFAULT_SETTINGS.prompt;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [SETTINGS_KEY]: migrated });
  return migrated;
}

function assertRemoteAnalysisConsent(settings) {
  if (settings?.remoteAnalysisEnabled !== true) {
    throw codedError(
      "CONSENT_REQUIRED",
      "Autorisez l’envoi du texte des posts au fournisseur choisi dans les réglages pour activer l’analyse."
    );
  }
}

async function requireCurrentConsent() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  assertRemoteAnalysisConsent(stored[SETTINGS_KEY]);
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function validateContext(candidate, mainText) {
  if (candidate === undefined) return null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      typeof candidate.hasMedia !== "boolean" || typeof candidate.isTruncated !== "boolean" ||
      typeof candidate.mainText !== "string" || typeof candidate.quotedText !== "string" ||
      candidate.mainText.length > 12000 || candidate.quotedText.length > 12000 ||
      normalizeText(candidate.mainText) !== mainText) {
    throw codedError("BAD_CONTEXT", "Le contexte du post est invalide ou trop long.");
  }
  return {
    mainText,
    quotedText: normalizeText(candidate.quotedText),
    hasMedia: candidate.hasMedia,
    isTruncated: candidate.isTruncated
  };
}

function sanitizeSettings(candidate = {}) {
  candidate = candidate && typeof candidate === "object" ? candidate : {};
  const provider = candidate.provider === undefined ? DEFAULT_SETTINGS.provider : candidate.provider;
  if (provider !== "typesafe" && provider !== "openrouter") {
    throw codedError("INVALID_PROVIDER", "Choisissez TypeSafe ou OpenRouter dans les réglages.");
  }
  const model = ["jev-latest", "jev-1.13.0"].includes(candidate.model)
    ? candidate.model
    : DEFAULT_SETTINGS.model;
  const prompt =
    typeof candidate.prompt === "string" && candidate.prompt.trim().length >= 20
      ? candidate.prompt.trim().slice(0, 4000)
      : DEFAULT_SETTINGS.prompt;

  const threshold = clampNumber(candidate.threshold, 0.5, 0.95, DEFAULT_SETTINGS.threshold);
  return {
    provider,
    model,
    prompt,
    threshold,
    blurEnabled: candidate.blurEnabled === true,
    remoteAnalysisEnabled: candidate.remoteAnalysisEnabled === true,
    contextGuardEnabled: candidate.contextGuardEnabled === true,
    blurThreshold: threshold
  };
}

async function callJev({ apiKey, settings, text }) {
  const provider = PROVIDERS[settings.provider];
  const model = settings.provider === "openrouter"
    ? (settings.model === "jev-1.13.0" ? "typesafe/jev-1.13" : "~typesafe/jev-latest")
    : settings.model;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(provider.url, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        state: text,
        questions: {
          slop: {
            type: "noul",
            instructions: `${SYSTEM_INSTRUCTIONS}\n\nUser definition:\n${settings.prompt}`,
            criteria: {
              true: "The author's own text clearly shows empty formulaic marketing or explicit low-substance engagement bait, with positive textual evidence.",
              false: "There is no clear textual evidence of low-substance engagement bait in the author's own text, including humour, news, reactions, useful content, or insufficient media context."
            }
          }
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw codedError("INVALID_API_KEY", `Clé API ${provider.name} invalide ou expirée.`);
      }
      if (response.status === 402) {
        throw codedError("INSUFFICIENT_CREDITS", `Crédits ${provider.name} insuffisants ou plafond de la clé atteint.`);
      }
      if (response.status === 403) {
        throw codedError("API_ACCESS_DENIED", `${provider.name} refuse l'accès à Jev. Vérifiez les autorisations de votre compte et de la clé.`);
      }
      if (response.status === 429 || response.status === 529) {
        throw codedError("API_BUSY", "Jev est temporairement sature. Reessayez dans un instant.");
      }
      throw codedError(
        "API_ERROR",
        `${provider.name} a répondu ${response.status}. Réessayez ou vérifiez votre compte.`
      );
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw codedError("BAD_API_RESPONSE", "La réponse Jev n'est pas un JSON valide.");
    }
    const rawScore = data?.answers?.slop?.noul;
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore) || rawScore < 0 || rawScore > 1) {
      throw codedError("BAD_API_RESPONSE", "La reponse Jev ne contient pas de score noul valide.");
    }

    return {
      score: rawScore,
      provider: settings.provider,
      model: typeof data.model === "string" ? data.model : model,
      analyzedAt: Date.now()
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw codedError("API_TIMEOUT", "Jev met trop de temps a repondre.");
    }
    if (error.code) throw error;
    throw codedError("API_NETWORK", `Impossible de joindre ${provider.name}. Vérifiez votre connexion.`);
  } finally {
    clearTimeout(timeout);
  }
}

function enqueueRequest(work) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ work, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length) {
    const job = requestQueue.shift();
    activeRequests += 1;
    Promise.resolve()
      .then(job.work)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeRequests -= 1;
        drainQueue();
      });
  }
}

async function readCacheEntry(cacheId) {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const entry = stored[CACHE_KEY]?.[cacheId];
  return entry && entry.result ? entry : null;
}

function writeCacheEntry(cacheId, result) {
  cacheWriteQueue = cacheWriteQueue.then(async () => {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const cache = stored[CACHE_KEY] || {};
    cache[cacheId] = { result, touchedAt: Date.now() };

    const ids = Object.keys(cache);
    if (ids.length > MAX_CACHE_ENTRIES) {
      ids
        .sort((left, right) => cache[left].touchedAt - cache[right].touchedAt)
        .slice(0, ids.length - MAX_CACHE_ENTRIES)
        .forEach((id) => delete cache[id]);
    }

    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  });
  return cacheWriteQueue;
}

async function broadcastSettings() {
  const { settings, apiKey } = await getConfiguration();
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.map((tab) =>
      tab.id
        ? chrome.tabs.sendMessage(tab.id, {
            type: "SETTINGS_UPDATED",
            settings,
            hasApiKey: Boolean(apiKey)
          })
        : Promise.resolve()
    )
  );
}

function assertXSender(sender) {
  let url;
  try {
    url = new URL(sender.url || "");
  } catch {
    throw codedError("FORBIDDEN", "Origine non autorisee.");
  }
  if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) {
    throw codedError("FORBIDDEN", "Origine non autorisee.");
  }
}

function assertOptionsSender(sender) {
  const allowedPages = ["options/options.html", "options/popup.html"].map((path) =>
    chrome.runtime.getURL(path)
  );
  if (!allowedPages.includes(sender.url?.split(/[?#]/)[0])) {
    throw codedError("FORBIDDEN", "Cette action est réservée aux réglages de l'extension.");
  }
}

function missingKeyError(provider) {
  return codedError("NO_API_KEY", `Ajoutez votre clé ${PROVIDERS[provider].name} dans les réglages de l'extension.`);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function fingerprint(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
