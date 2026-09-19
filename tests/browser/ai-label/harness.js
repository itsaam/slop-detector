(() => {
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><g><path d="M12.998 1.94c.18 3.015 1.04 5.156 2.473 6.59 1.433 1.433 3.574 2.292 6.589 2.472v1.996c-3.015.18-5.156 1.04-6.59 2.473-1.433 1.433-2.292 3.574-2.472 6.589h-1.996c-.18-3.015-1.04-5.156-2.473-6.59-1.433-1.433-3.574-2.292-6.589-2.472v-1.996c3.015-.18 5.156-1.04 6.59-2.473 1.433-1.433 2.292-3.574 2.472-6.589h1.996z"></path><path d="M4.997.95c.123 1.23.361 1.889.763 2.29.401.402 1.06.64 2.29.763v.994c-1.23.123-1.889.361-2.29.763-.402.401-.64 1.06-.763 2.29h-.994c-.123-1.23-.361-1.89-.763-2.29-.401-.402-1.06-.64-2.29-.763v-.994c1.23-.123 1.889-.361 2.29-.763.402-.401.64-1.06.763-2.29h.994z"></path></g></svg>';
  const publicIcon = '<svg data-icon="icon-sparkle" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2c0 3.35.74 5.53 2.1 6.9 1.36 1.36 3.55 2.1 6.9 2.1v2c-3.35 0-5.54.74-6.9 2.1-1.36 1.37-2.1 3.55-2.1 6.9h-2c0-3.35-.74-5.53-2.11-6.9C8.53 13.74 6.35 13 3 13v-2c3.35 0 5.53-.74 6.89-2.1C11.26 7.53 12 5.35 12 2h2zM5 1c0 1.66-1.34 3-3 3v1c1.66 0 3 1.34 3 3h1c0-1.66 1.34-3 3-3V4C7.34 4 6 2.66 6 1H5z"></path></svg>';
  let settings = {threshold: 0.65, blurEnabled: false, contextGuardEnabled: false, remoteAnalysisEnabled: true};
  let hasApiKey = true;
  let onSettings;
  let ready = false;
  let nextId = 51000;
  let passed = 0;
  const calls = new Map();
  const held = new Set();
  const pending = new Map();
  const response = {ok: true, result: {score: 0.05}};
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (condition, detail) => { if (!condition) throw new Error(detail); };
  const waitFor = async (condition) => {
    for (let i = 0; i < 100; i++) { if (condition()) return; await delay(15); }
    throw new Error('État attendu absent');
  };
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(target) { queueMicrotask(() => this.callback([{target, isIntersecting: true}])); }
    unobserve() {}
  };
  globalThis.chrome = {runtime: {
    onMessage: {addListener(fn) { onSettings = fn; }},
    async sendMessage(message) {
      if (message.type === 'GET_PUBLIC_SETTINGS') { ready = true; return {ok: true, settings, hasApiKey}; }
      if (message.type !== 'ANALYZE_TWEET') return {ok: true};
      calls.set(message.tweetId, (calls.get(message.tweetId) || 0) + 1);
      if (held.has(message.tweetId)) return new Promise((resolve, reject) => pending.set(message.tweetId, {resolve, reject}));
      return response;
    }
  }};
  function badge(text = 'Made with AI', shape = icon) {
    const el = document.createElement('div');
    el.className = 'ai-label';
    el.innerHTML = `${shape}<span>${text}</span>`;
    return el;
  }
  function tweet(text = 'Une publication avec une image.', label = null, keep = false) {
    const id = String(nextId++);
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.dataset.fixtureId = id;
    article.innerHTML = `<div data-testid="User-Name"><strong>Post témoin</strong> · <a href="/fixture/status/${id}"><time>1 min</time></a></div><div data-testid="tweetText"></div><div data-testid="tweetPhoto">Média témoin</div><div role="group"><button data-testid="reply">Répondre</button></div>`;
    article.querySelector('[data-testid="tweetText"]').textContent = text;
    if (label) article.insertBefore(label, article.lastElementChild);
    if (keep) article.dataset.keep = 'true';
    return article;
  }
  function mount(article) { document.querySelector('#examples').append(article); }
  const slot = (article) => article.querySelector('.jev-result-slot');
  const slop = (article) => slot(article)?.dataset.source === 'x-ai-label';
  const clean = (article) => slot(article)?.dataset.verdict === 'clean';
  const count = (article) => calls.get(article.dataset.fixtureId) || 0;
  function updateSettings(values = {}) {
    settings = {...settings, ...values};
    onSettings({type: 'SETTINGS_UPDATED', settings, hasApiKey});
  }
  async function test(name, fn) {
    await fn();
    const result = document.createElement('li');
    result.className = 'pass';
    result.textContent = `PASS — ${name}`;
    document.querySelector('#results').append(result);
    passed++;
    document.querySelectorAll('article:not([data-keep])').forEach((el) => el.remove());
  }
  document.querySelector('#run').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await waitFor(() => ready);
      await test('Badge anglais + icône fournie : SLOP sans API ni score inventé', async () => {
        const article = tweet('Image signalée par X.', badge(), true); mount(article);
        await waitFor(() => slop(article));
        check(count(article) === 0, 'Appel API inutile');
        check(!slot(article).hasAttribute('data-score'), 'Score inventé');
        check(article.querySelector('.jev-stamp')?.textContent === 'SLOP', 'Tampon incorrect');
        const post = article.getBoundingClientRect();
        const stamp = article.querySelector('.jev-stamp').getBoundingClientRect();
        await delay(500);
        const finalStamp = article.querySelector('.jev-stamp').getBoundingClientRect();
        check(Math.abs(finalStamp.y + finalStamp.height / 2 - post.y - post.height / 2) < 2, 'Tampon non centré');
      });
      await test('Parler d’IA sans badge reste une analyse normale : Not slop · 5%', async () => {
        const article = tweet('J’explique comment fonctionne l’IA et ChatGPT.', null, true); mount(article);
        await waitFor(() => clean(article));
        check(count(article) === 1 && slot(article).textContent.includes('5%'), 'Mention IA classée automatiquement');
      });
      await test('Badge français du DOM réel et deuxième icône reconnus', async () => {
        const article = tweet('', badge("Fabriqué avec l'IA", publicIcon)); mount(article);
        await waitFor(() => slop(article)); check(count(article) === 0, 'Média seul envoyé à Jev');
      });
      await test('Les mots Made with AI dans le tweet ne sont pas le badge', async () => {
        const article = tweet('Made with AI');
        article.querySelector('[data-testid="tweetText"]').append(badge()); mount(article);
        await waitFor(() => clean(article)); check(count(article) === 1, 'Texte de tweet pris pour un badge');
      });
      await test('Texte de libellé sans icône : aucun override', async () => {
        const article = tweet('Texte normal.', badge('Made with AI', '')); mount(article);
        await waitFor(() => clean(article));
      });
      await test('Badge d’un tweet cité et badge masqué ignorés', async () => {
        const quote = document.createElement('div'); quote.dataset.testid = 'quoteTweet'; quote.setAttribute('role', 'link'); quote.append(badge());
        const article = tweet('Je commente une publication.'); article.append(quote);
        const hiddenBadge = badge(); hiddenBadge.hidden = true; article.append(hiddenBadge); mount(article);
        await waitFor(() => clean(article)); check(count(article) === 1, 'Badge étranger utilisé');
      });
      await test('Badge ajouté après un Not slop en cache : priorité locale immédiate', async () => {
        const article = tweet(); mount(article); await waitFor(() => clean(article));
        const label = badge(); article.append(label); await waitFor(() => slop(article));
        check(count(article) === 1, 'Nouvel appel malgré le badge');
        label.remove(); await waitFor(() => clean(article));
        check(count(article) === 1, 'Cache perdu après retrait du badge');
      });
      await test('Hydratation tardive du texte du badge détectée', async () => {
        const label = badge('Chargement'); const article = tweet('Texte normal.', label); mount(article);
        await waitFor(() => clean(article)); label.querySelector('span').firstChild.data = 'Made with AI';
        await waitFor(() => slop(article));
      });
      for (const outcome of ['success', 'error', 'reject']) {
        await test(`Une réponse API tardive (${outcome}) ne remplace jamais le badge`, async () => {
          const article = tweet(); const id = article.dataset.fixtureId; held.add(id); mount(article);
          await waitFor(() => pending.has(id)); article.append(badge()); await waitFor(() => slop(article));
          await delay(220); check(slop(article), 'Indicateur de chargement a remplacé SLOP');
          if (outcome === 'reject') pending.get(id).reject(new Error('Test réseau'));
          else pending.get(id).resolve(outcome === 'success' ? response : {ok: false, code: 'RATE_LIMITED'});
          await delay(30); check(slop(article), 'Réponse tardive a remplacé SLOP');
        });
      }
      await test('Sans clé API, le badge suffit ; flou et Afficher/Masquer fonctionnent', async () => {
        hasApiKey = false; updateSettings({blurEnabled: true, threshold: 1});
        const article = tweet('Média.', badge()); mount(article); await waitFor(() => slop(article));
        check(count(article) === 0, 'Appel sans clé');
        const media = article.querySelector('[data-testid="tweetPhoto"]');
        check(getComputedStyle(media).filter.includes('blur'), 'Flou absent');
        article.querySelector('.jev-reveal').click();
        check(getComputedStyle(media).filter === 'none', 'Afficher ne révèle pas');
        article.querySelector('.jev-reveal').click();
        check(getComputedStyle(media).filter.includes('blur'), 'Masquer ne floute pas');
        hasApiKey = true; updateSettings({blurEnabled: false, threshold: 0.65});
      });
      await test('Recyclage d’un article X : aucun SLOP conservé sur le post suivant', async () => {
        const label = badge(); const article = tweet('Image.', label); mount(article); await waitFor(() => slop(article));
        article.querySelector('time').parentElement.href = `/fixture/status/${nextId++}`;
        label.remove(); await waitFor(() => clean(article));
      });
      document.querySelector('#summary').textContent = `${passed}/${passed} tests PASS · zéro appel réel`;
    } catch (error) {
      document.querySelector('#summary').textContent = `FAIL après ${passed} tests : ${error.message}`;
      document.querySelector('#summary').className = 'fail';
      console.error(error);
    }
  });
})();
