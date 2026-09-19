const SETTINGS_KEY = "userSettings";
const { DEFAULT_SETTINGS, LEGACY_PROMPT } = globalThis.SlopShared;

const form = document.querySelector("#settings-form");
const apiKeyInput = document.querySelector("#api-key");
const providerInput = document.querySelector("#provider");
const modelInput = document.querySelector("#model");
const thresholdInput = document.querySelector("#threshold");
const thresholdValue = document.querySelector("#threshold-value");
const promptInput = document.querySelector("#prompt");
const blurEnabledInput = document.querySelector("#blur-enabled");
const contextGuardInput = document.querySelector("#context-guard-enabled");
const remoteAnalysisInput = document.querySelector("#remote-analysis-enabled");
const toggleKeyButton = document.querySelector("#toggle-key");
const testButton = document.querySelector("#test-connection");
const status = document.querySelector("#status");
const connectionState = document.querySelector("#connection-state");
const connectionDetails = document.querySelector("#connection-details");
const keyHelp = document.querySelector("#key-help");
const keyLink = document.querySelector("#key-link");
const PROVIDERS = {
  typesafe: {
    name: "TypeSafe",
    storageKey: "apiKey",
    keysUrl: "https://console.typesafe.ai/keys",
    notice: "Clé conservée dans ce navigateur et envoyée uniquement à TypeSafe. Le texte des posts est analysé par TypeSafe ; ni les images ni les vidéos."
  },
  openrouter: {
    name: "OpenRouter",
    storageKey: "openRouterApiKey",
    keysUrl: "https://openrouter.ai/settings/keys",
    notice: "Clé conservée dans ce navigateur et envoyée uniquement à OpenRouter. Le texte des posts passe par OpenRouter vers TypeSafe ; ni les images ni les vidéos."
  }
};
const keyDrafts = { typesafe: "", openrouter: "" };
const savedKeys = { typesafe: false, openrouter: false };
const changedKeys = new Set();
let activeProvider = "typesafe";
let ready = false;

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  try {
    await saveSettings();
    showStatus(!remoteAnalysisInput.checked
      ? "Réglages enregistrés. Analyse en ligne désactivée ; les badges IA restent détectés."
      : savedKeys[activeProvider]
        ? "Réglages enregistrés. Le flux X est mis à jour."
        : "Réglages enregistrés. Ajoutez une clé pour analyser les posts.", "success");
  } catch (error) {
    showStatus(error.message || "Impossible d'enregistrer les réglages.", "error");
  } finally {
    setBusy(false);
  }
});

testButton.addEventListener("click", async () => {
  if (!form.reportValidity()) return;
  setBusy(true);
  showStatus("Test de connexion à Jev…");
  try {
    await saveSettings({ applyRemoteAnalysisConsent: false });
    const key = PROVIDERS[activeProvider].storageKey;
    const stored = await chrome.storage.local.get(key);
    if (!stored[key]?.trim()) throw new Error(`Ajoutez une clé API ${PROVIDERS[activeProvider].name}.`);
    const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    if (!response?.ok) throw new Error(response?.message || "Test impossible.");
    showStatus(
      `Connexion réussie · ${response.model} · exemple ${Math.round(response.score * 100)}%. Enregistrez pour appliquer votre choix d’analyse en ligne.`,
      "success"
    );
  } catch (error) {
    showStatus(error.message || "Connexion impossible.", "error");
  } finally {
    setBusy(false);
  }
});

toggleKeyButton.addEventListener("click", () => {
  const isHidden = apiKeyInput.type === "password";
  apiKeyInput.type = isHidden ? "text" : "password";
  toggleKeyButton.textContent = isHidden ? "Masquer" : "Afficher";
  toggleKeyButton.setAttribute("aria-pressed", String(isHidden));
});

apiKeyInput.addEventListener("input", () => {
  keyDrafts[activeProvider] = apiKeyInput.value;
  changedKeys.add(activeProvider);
  updateConnectionState();
});
providerInput.addEventListener("change", () => {
  activeProvider = providerInput.value;
  renderProvider();
});
form.addEventListener("input", () => {
  if (ready) showStatus("Modifications non enregistrées.");
});
form.addEventListener("change", () => {
  if (ready) showStatus("Modifications non enregistrées.");
});
form.addEventListener("invalid", (event) => {
  const details = event.target.closest("details");
  if (details) details.open = true;
}, true);
thresholdInput.addEventListener("input", updateLabels);

async function loadSettings() {
  setBusy(true);
  applySettings(DEFAULT_SETTINGS);
  try {
    if (!globalThis.chrome?.storage?.local) {
      throw new Error("Ouvrez ce panneau depuis l’extension installée pour enregistrer vos réglages.");
    }
    const stored = await chrome.storage.local.get([SETTINGS_KEY, "apiKey", "openRouterApiKey"]);
    const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
    for (const [provider, config] of Object.entries(PROVIDERS)) {
      keyDrafts[provider] = typeof stored[config.storageKey] === "string" ? stored[config.storageKey] : "";
      savedKeys[provider] = Boolean(keyDrafts[provider].trim());
    }
    applySettings(settings);
    if (connectionDetails) connectionDetails.open = !savedKeys[activeProvider];
    ready = true;
    showStatus("Enregistrez pour appliquer vos changements.");
  } catch (error) {
    showStatus(error.message || "Chargement impossible. Rouvrez le panneau.", "error");
    if (connectionState) connectionState.textContent = "Réglages indisponibles";
  } finally {
    setBusy(!ready);
  }
}

function applySettings(settings) {
  activeProvider = settings.provider === "openrouter" ? "openrouter" : "typesafe";
  providerInput.value = activeProvider;
  modelInput.value = settings.model;
  thresholdInput.value = String(Math.round(settings.threshold * 100));
  promptInput.value = settings.prompt === LEGACY_PROMPT ? DEFAULT_SETTINGS.prompt : settings.prompt;
  blurEnabledInput.checked = settings.blurEnabled;
  contextGuardInput.checked = settings.contextGuardEnabled === true;
  remoteAnalysisInput.checked = settings.remoteAnalysisEnabled === true;
  updateLabels();
  renderProvider();
}

async function saveSettings({ applyRemoteAnalysisConsent = true } = {}) {
  const prompt = promptInput.value.trim();
  if (prompt.length < 20) throw new Error("La définition du slop est trop courte.");

  let remoteAnalysisEnabled = remoteAnalysisInput.checked === true;
  if (!applyRemoteAnalysisConsent) {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    remoteAnalysisEnabled = stored[SETTINGS_KEY]?.remoteAnalysisEnabled === true;
  }

  const updates = {
    [SETTINGS_KEY]: {
      provider: activeProvider,
      model: modelInput.value,
      threshold: Number(thresholdInput.value) / 100,
      prompt,
      blurEnabled: blurEnabledInput.checked,
      contextGuardEnabled: contextGuardInput.checked,
      remoteAnalysisEnabled,
      blurThreshold: Number(thresholdInput.value) / 100
    }
  };
  for (const provider of changedKeys) {
    updates[PROVIDERS[provider].storageKey] = keyDrafts[provider].trim();
  }
  await chrome.storage.local.set(updates);
  const stored = await chrome.storage.local.get(["apiKey", "openRouterApiKey"]);
  for (const [provider, config] of Object.entries(PROVIDERS)) {
    keyDrafts[provider] = typeof stored[config.storageKey] === "string" ? stored[config.storageKey] : "";
    savedKeys[provider] = Boolean(keyDrafts[provider].trim());
  }
  changedKeys.clear();
  renderProvider();
}

function renderProvider() {
  const provider = PROVIDERS[activeProvider];
  apiKeyInput.type = "password";
  apiKeyInput.value = keyDrafts[activeProvider];
  apiKeyInput.placeholder = `Collez votre clé ${provider.name}`;
  toggleKeyButton.textContent = "Afficher";
  toggleKeyButton.setAttribute("aria-pressed", "false");
  keyHelp.textContent = provider.notice;
  keyLink.href = provider.keysUrl;
  keyLink.textContent = `Gérer ma clé ${provider.name}`;
  updateConnectionState();
}

function updateConnectionState() {
  if (!connectionState) return;
  const state = changedKeys.has(activeProvider)
    ? "clé modifiée, à enregistrer"
    : savedKeys[activeProvider] ? "clé enregistrée" : "clé à ajouter";
  connectionState.textContent = `${PROVIDERS[activeProvider].name} · ${state}`;
}

function updateLabels() {
  thresholdValue.textContent = `${thresholdInput.value}%`;
}

function setBusy(isBusy) {
  form.setAttribute("aria-busy", String(isBusy));
  form.querySelectorAll("button, input, select, textarea").forEach((control) => {
    control.disabled = isBusy;
  });
}

function showStatus(message, kind = "") {
  status.textContent = message;
  if (kind) status.dataset.kind = kind;
  else delete status.dataset.kind;
}
