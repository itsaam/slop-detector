(() => {
  const ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
  const MAX_PAGE_RESULTS = 1000;
  const observedTweets = new WeakMap();
  const observedAiLabels = new WeakMap();
  const observedGenerations = new WeakMap();
  const appliedResults = new WeakMap();
  const revealedTweets = new Set();
  const AI_LABEL_RESULT = Object.freeze({ verdict: "slop", score: null, source: "x-ai-label" });
  const AI_LABEL_TEXT = new Set(["made with ai", "fabriqué avec l'ia"]);
  const renderedResults = new Map();
  let analysisGeneration = 0;
  let settings = {
    threshold: 0.65,
    blurEnabled: false,
    blurThreshold: 0.78
  };
  let hasApiKey = false;

  const viewportObserver = new IntersectionObserver(onViewportChange, {
    rootMargin: "120px 0px",
    threshold: 0.08
  });

  const domObserver = new MutationObserver((mutations) => {
    const articles = new Set();
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (mutation.type === "attributes" && target?.closest('[data-jev-owned="true"]')) continue;
      const containingArticle = target?.closest(ARTICLE_SELECTOR);
      if (containingArticle) articles.add(containingArticle);
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(ARTICLE_SELECTOR)) articles.add(node);
        node.querySelectorAll(ARTICLE_SELECTOR).forEach((article) => articles.add(article));
      }
    }
    articles.forEach((article) => scanArticle(article));
  });

  initialize();

  async function initialize() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_PUBLIC_SETTINGS" });
      if (response?.ok) {
        settings = response.settings;
        hasApiKey = response.hasApiKey;
      }
    } catch {
      // The service worker may still be starting. Analysis will surface a retry state.
    }

    document.querySelectorAll(ARTICLE_SELECTOR).forEach((article) => scanArticle(article));
    domObserver.observe(document.documentElement, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-testid", "href"],
      subtree: true
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "SETTINGS_UPDATED") return;
    const analysisChanged =
      Boolean(settings.remoteAnalysisEnabled) !== Boolean(message.settings.remoteAnalysisEnabled) ||
      Boolean(settings.contextGuardEnabled) !== Boolean(message.settings.contextGuardEnabled) ||
      `${settings.provider || "typesafe"}\n${settings.model || ""}\n${settings.prompt || ""}` !==
      `${message.settings.provider || "typesafe"}\n${message.settings.model || ""}\n${message.settings.prompt || ""}`;
    settings = message.settings;
    hasApiKey = message.hasApiKey;

    if (analysisChanged) {
      analysisGeneration += 1;
      renderedResults.clear();
    }
    document.querySelectorAll(ARTICLE_SELECTOR).forEach((article) => {
      if (analysisChanged) {
        resetArticle(article);
        observedTweets.delete(article);
        scanArticle(article, true);
        return;
      }
      const data = extractTweet(article);
      if (!data) return;
      const cached = renderedResults.get(data.id);
      if (data.aiLabel) renderResult(article, AI_LABEL_RESULT);
      else if (cached) renderResult(article, cached);
      else scanArticle(article, true);
    });
  });

  function scanArticle(article, force = false) {
    if (!article.isConnected) return;
    const data = extractTweet(article);
    if (!data) {
      if (observedTweets.has(article)) resetArticle(article);
      observedTweets.delete(article);
      observedAiLabels.delete(article);
      observedGenerations.delete(article);
      return;
    }

    const previousId = observedTweets.get(article);
    const staleGeneration = observedGenerations.get(article) !== analysisGeneration;
    if (!force && !staleGeneration && previousId === data.id && observedAiLabels.get(article) === data.aiLabel) {
      // X reuses article nodes and replaces media after classification. Reconcile
      // only posts already rendered; pending/offscreen posts still use the observer.
      const applied = appliedResults.get(article);
      if (applied) renderResult(article, applied);
      return;
    }

    // Detached timeline nodes miss SETTINGS_UPDATED's document scan. Never restore
    // their old verdict after consent, provider, prompt or policy settings change.
    if (previousId && (staleGeneration || previousId !== data.id || observedAiLabels.get(article) !== data.aiLabel)) {
      resetArticle(article);
    }

    observedTweets.set(article, data.id);
    observedAiLabels.set(article, data.aiLabel);
    observedGenerations.set(article, analysisGeneration);
    viewportObserver.unobserve(article);
    viewportObserver.observe(article);
  }

  function onViewportChange(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      viewportObserver.unobserve(entry.target);
      analyzeArticle(entry.target);
    }
  }

  async function analyzeArticle(article) {
    const data = extractTweet(article);
    if (!data || observedTweets.get(article) !== data.id) return;
    const generation = analysisGeneration;

    // X's own media disclosure takes priority over the model and its cache.
    if (data.aiLabel) {
      renderResult(article, AI_LABEL_RESULT);
      return;
    }

    if (settings.remoteAnalysisEnabled !== true) {
      renderError(article, "Autorisez l’envoi du texte au fournisseur sélectionné dans les réglages.", "CONSENT_REQUIRED");
      return;
    }

    const existing = renderedResults.get(data.id);
    if (existing) {
      renderResult(article, existing);
      return;
    }

    if (!hasApiKey) {
      renderSetup(article);
      return;
    }

    const loadingTimer = setTimeout(() => {
      const current = extractTweet(article);
      if (
        generation === analysisGeneration &&
        article.isConnected &&
        current?.id === data.id &&
        observedTweets.get(article) === data.id
      ) {
        if (current.aiLabel) renderResult(article, AI_LABEL_RESULT);
        else renderLoading(article);
      }
    }, 180);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "ANALYZE_TWEET",
        tweetId: data.id,
        text: data.text,
        context: data.context
      });
      clearTimeout(loadingTimer);

      const current = extractTweet(article);
      if (
        generation !== analysisGeneration ||
        !article.isConnected ||
        current?.id !== data.id ||
        observedTweets.get(article) !== data.id
      ) return;
      if (current.aiLabel) {
        renderResult(article, AI_LABEL_RESULT);
        return;
      }
      if (!response?.ok) {
        if (response?.code === "NO_API_KEY") hasApiKey = false;
        renderError(article, response?.message || "Analyse indisponible.", response?.code);
        return;
      }

      rememberResult(data.id, response.result);
      renderResult(article, response.result);
    } catch (error) {
      clearTimeout(loadingTimer);
      const current = extractTweet(article);
      if (generation !== analysisGeneration || !article.isConnected || current?.id !== data.id) return;
      if (current.aiLabel) {
        renderResult(article, AI_LABEL_RESULT);
        return;
      }
      renderError(article, error?.message || "Impossible de joindre l'extension.");
    }
  }

  function hasPlatformAiLabel(article) {
    // Exact badge copy + X sparkle geometry, never keywords in authored text.
    const excluded = '[data-testid="tweetText"], [data-testid="User-Name"], [data-testid="quoteTweet"], div[role="link"], [data-testid="card.wrapper"], [data-jev-owned="true"]';
    for (const path of article.querySelectorAll("svg path")) {
      const geometry = (path.getAttribute("d") || "").replace(/[\s,]+/g, "");
      if (!geometry.startsWith("M12.9981.94c.183.015") && !geometry.startsWith("M142c03.35")) continue;
      const svg = path.closest("svg");
      if (svg.closest(excluded) || svg.closest(ARTICLE_SELECTOR) !== article) continue;
      let badge = svg.parentElement;
      for (let depth = 0; badge && badge !== article && depth < 3; depth++, badge = badge.parentElement) {
        const label = (badge.textContent || "").replace(/\s+/g, " ").trim().replace(/’/g, "'").toLowerCase();
        if (!AI_LABEL_TEXT.has(label) || badge.closest('[hidden], [aria-hidden="true"]')) continue;
        if (badge.getClientRects().length && getComputedStyle(badge).visibility !== "hidden") return true;
      }
    }
    return false;
  }

  function extractTweet(article) {
    const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')]
      .filter((node) => node.closest(ARTICLE_SELECTOR) === article);
    const isQuoted = (node) => Boolean(node.closest('[data-testid="quoteTweet"], div[role="link"]'));
    const readText = (nodes) => nodes.map((node) => node.innerText || "").join(" ").replace(/\s+/g, " ").trim();
    const mainText = readText(textNodes.filter((node) => !isQuoted(node)));
    const quotedText = readText(textNodes.filter(isQuoted));
    const time = article.querySelector("time");
    const statusLink = time?.closest('a[href*="/status/"]');
    const id = statusLink?.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1];
    const hasMedia = Boolean(article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], video'));
    const isTruncated = Boolean(article.querySelector('[data-testid="tweet-text-show-more-link"]'));
    const aiLabel = hasPlatformAiLabel(article);
    return id && (mainText || aiLabel || (settings.contextGuardEnabled && hasMedia)) ? {
      id,
      aiLabel,
      text: mainText,
      context: { mainText, quotedText, hasMedia, isTruncated }
    } : null;
  }

  function ensureSlot(article) {
    let slot = article.querySelector('.jev-result-slot[data-jev-owned="true"]');
    if (slot) return slot;

    slot = document.createElement("div");
    slot.className = "jev-result-slot";
    slot.dataset.jevOwned = "true";
    slot.setAttribute("role", "status");
    slot.setAttribute("aria-live", "polite");

    const actionBar = article
      .querySelector('[data-testid="reply"]')
      ?.closest('[role="group"]');
    if (actionBar?.parentElement) {
      slot.classList.add("jev-result-slot--inline");
      actionBar.parentElement.insertBefore(slot, actionBar);
    } else {
      article.append(slot);
    }
    return slot;
  }

  function renderLoading(article) {
    const slot = ensureSlot(article);
    clearSlot(slot);
    const badge = document.createElement("span");
    badge.className = "jev-badge jev-badge--loading";
    badge.append(createDot(), document.createTextNode("Jev analyse…"));
    slot.append(badge);
  }

  function renderResult(article, result) {
    const previous = appliedResults.get(article);
    appliedResults.set(article, result);
    const platformSlop = result.source === "x-ai-label";
    const uncertain = !platformSlop && (result.verdict === "uncertain" || result.score === null);
    const isSlop = !uncertain && (platformSlop || result.score >= settings.threshold);
    const shouldBlur = settings.blurEnabled && isSlop;
    setClass(article, "jev-slop-marked", isSlop);
    setClass(article, "jev-slop-blurred", shouldBlur);
    syncBlurTargets(article, shouldBlur);

    const tweetId = observedTweets.get(article);
    if (shouldBlur && revealedTweets.has(tweetId)) article.dataset.jevRevealed = "true";
    else delete article.dataset.jevRevealed;

    const currentStamp = article.querySelector(':scope > .jev-stamp[data-jev-owned="true"]');
    if (!isSlop) currentStamp?.remove();
    if (uncertain && !settings.contextGuardEnabled) {
      article.querySelector('.jev-result-slot[data-jev-owned="true"]')?.remove();
      return;
    }

    const slot = ensureSlot(article);
    const verdict = uncertain ? "uncertain" : isSlop ? "slop" : "clean";
    if (slot.dataset.verdict !== verdict) slot.replaceChildren();
    slot.dataset.verdict = verdict;
    if (uncertain) {
      delete slot.dataset.score;
      delete slot.dataset.source;
      let badge = slot.querySelector(".jev-badge--uncertain");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "jev-badge jev-badge--uncertain";
        badge.textContent = "Contexte insuffisant";
        slot.append(badge);
      }
      badge.title = result.reason === "truncated"
        ? "Le texte est tronqué. Ouvrez le post complet pour l’analyser."
        : "Légende courte : l’image ou la vidéo n’est pas analysée. Aucun verdict SLOP.";
      return;
    }
    const score = Math.round(result.score * 100);
    if (!platformSlop) slot.dataset.score = String(score);
    else delete slot.dataset.score;
    slot.dataset.source = platformSlop ? "x-ai-label" : "jev";

    if (isSlop && !currentStamp) {
      const stamp = document.createElement("span");
      stamp.className = "jev-stamp";
      stamp.dataset.jevOwned = "true";
      stamp.setAttribute("aria-label", "SLOP");
      if (platformSlop) stamp.title = "SLOP : ce média porte le badge « Made with AI » de X.";
      // Restoring a node removed by X is not a new verdict or a new animation.
      if (previous === result) stamp.style.animation = "none";

      const label = document.createElement("strong");
      label.textContent = "SLOP";
      stamp.append(label);
      // A direct article child avoids X's positioned action-bar containers.
      article.append(stamp);
    } else if (!isSlop) {
      let badge = slot.querySelector(".jev-badge--clean");
      const text = `Not slop · ${score}%`;
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "jev-badge jev-badge--clean";
        slot.append(badge);
      }
      if (badge.textContent !== text) {
        badge.replaceChildren(createDot(), document.createTextNode(text));
        badge.setAttribute("aria-label", `Not slop, probabilite de slop ${score} pour cent`);
      }
    }

    if (shouldBlur) {
      let reveal = slot.querySelector(".jev-reveal");
      if (!reveal) {
        reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "jev-reveal";
        reveal.addEventListener("click", () => {
          if (revealedTweets.has(tweetId)) revealedTweets.delete(tweetId);
          else {
            revealedTweets.add(tweetId);
            if (revealedTweets.size > MAX_PAGE_RESULTS) revealedTweets.delete(revealedTweets.values().next().value);
          }
          renderResult(article, appliedResults.get(article));
        });
        slot.append(reveal);
      }
      const text = revealedTweets.has(tweetId) ? "Masquer" : "Afficher";
      if (reveal.textContent !== text) reveal.textContent = text;
    } else {
      slot.querySelector(".jev-reveal")?.remove();
    }
  }

  function setClass(node, className, enabled) {
    if (node.classList.contains(className) !== enabled) node.classList.toggle(className, enabled);
  }

  function syncBlurTargets(article, enabled) {
    const candidates = enabled
      ? [...article.querySelectorAll('[data-testid="tweetText"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"], video')]
        .filter((node) => node.closest(ARTICLE_SELECTOR) === article)
      : [];
    const targets = new Set(candidates.filter((node) => !candidates.some((parent) => parent !== node && parent.contains(node))));
    article.querySelectorAll(".jev-blur-target").forEach((node) => {
      if (node.closest(ARTICLE_SELECTOR) === article && !targets.has(node)) node.classList.remove("jev-blur-target");
    });
    targets.forEach((node) => setClass(node, "jev-blur-target", true));
  }

  function renderSetup(article) {
    const slot = ensureSlot(article);
    clearSlot(slot);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "jev-badge jev-badge--action";
    button.textContent = "Configurer Jev";
    button.addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {})
    );
    slot.append(button);
  }

  function renderError(article, message, code) {
    const slot = ensureSlot(article);
    clearSlot(slot);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "jev-badge jev-badge--error";
    button.textContent = code === "CONSENT_REQUIRED" ? "Autoriser l’analyse"
      : code === "INVALID_API_KEY" ? "Cle Jev invalide" : "Jev indisponible · Reessayer";
    button.title = message;
    button.addEventListener("click", () => {
      if (code === "INVALID_API_KEY" || code === "NO_API_KEY" || code === "CONSENT_REQUIRED") {
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
      } else {
        analyzeArticle(article);
      }
    });
    slot.append(button);
  }

  function createDot() {
    const dot = document.createElement("span");
    dot.className = "jev-dot";
    dot.setAttribute("aria-hidden", "true");
    return dot;
  }

  function rememberResult(tweetId, result) {
    if (renderedResults.has(tweetId)) renderedResults.delete(tweetId);
    renderedResults.set(tweetId, result);
    if (renderedResults.size > MAX_PAGE_RESULTS) {
      renderedResults.delete(renderedResults.keys().next().value);
    }
  }

  function clearSlot(slot) {
    const article = slot.closest(ARTICLE_SELECTOR);
    if (article) appliedResults.delete(article);
    article?.querySelector(':scope > .jev-stamp[data-jev-owned="true"]')?.remove();
    article?.classList.remove("jev-slop-marked", "jev-slop-blurred");
    article?.querySelectorAll(".jev-blur-target").forEach((node) => node.classList.remove("jev-blur-target"));
    slot.replaceChildren();
    delete slot.dataset.verdict;
    delete slot.dataset.score;
    delete slot.dataset.source;
  }

  function resetArticle(article) {
    appliedResults.delete(article);
    viewportObserver.unobserve(article);
    article.querySelector(':scope > .jev-stamp[data-jev-owned="true"]')?.remove();
    article.querySelectorAll(".jev-blur-target").forEach((node) => node.classList.remove("jev-blur-target"));
    article.querySelector('.jev-result-slot[data-jev-owned="true"]')?.remove();
    article.classList.remove("jev-slop-blurred");
    article.classList.remove("jev-slop-marked");
    delete article.dataset.jevRevealed;
  }
})();
