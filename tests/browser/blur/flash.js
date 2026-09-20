(() => {
  const pending = new Set();
  let observer;
  let onSettings;
  let calls = 0;
  let settings = {threshold: 0.65, blurEnabled: true, remoteAnalysisEnabled: true};
  globalThis.IntersectionObserver = class {
    constructor(callback) { observer = callback; }
    observe(node) { pending.add(node); }
    unobserve(node) { pending.delete(node); }
  };
  globalThis.chrome = {runtime: {
    onMessage: {addListener(listener) { onSettings = listener; }},
    async sendMessage(message) {
      if (message.type === 'GET_PUBLIC_SETTINGS') return {ok: true, hasApiKey: true, settings};
      if (message.type === 'ANALYZE_TWEET') { calls++; return {ok: true, result: {score: 0.9}}; }
      return {ok: true};
    }
  }};
  const host = document.querySelector('#posts');
  const report = document.querySelector('#results');
  const makePost = () => {
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.innerHTML = '<a href="/fixture/status/63000"><time>1 min</time></a><div data-testid="tweetText">Post déjà classé</div><div data-testid="tweetPhoto">MÉDIA À FLOUTER</div><div role="group"><button data-testid="reply">Répondre</button></div>';
    return article;
  };
  const mediaOf = (article) => article.querySelector('[data-testid="tweetPhoto"]');
  const blur = (node) => getComputedStyle(node).filter === 'blur(7px)';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  document.querySelector('#run').addEventListener('click', async (event) => {
    event.target.disabled = true;
    const results = [];
    const test = async (name, run) => {
      try { await run(); results.push({name, status: 'PASS'}); }
      catch (error) { results.push({name, status: 'FAIL', error: error.message}); }
      report.textContent = JSON.stringify(results, null, 2);
    };
    let article = makePost();
    host.append(article);
    await tick();
    observer([...pending].map((target) => ({target, isIntersecting: true})));
    await tick();
    const initialCalls = calls;
    await test('Aucune transition du flou', () => {
      assert(getComputedStyle(mediaOf(article)).transitionDuration === '0s', 'Transition non nulle : contenu temporairement lisible');
    });
    await test('Média neuf flouté avant le MutationObserver', () => {
      const media = document.createElement('div');
      media.dataset.testid = 'tweetPhoto';
      media.textContent = 'Média remplacé';
      mediaOf(article).replaceWith(media);
      assert(blur(media), `Flou absent avant réconciliation : ${getComputedStyle(media).filter}`);
    });
    await tick();
    await test('Classes X réécrites : protection immédiate', () => {
      article.className = 'x-recycled';
      mediaOf(article).className = 'x-media';
      assert(blur(mediaOf(article)), 'Flou perdu lors de la réécriture des classes');
    });
    await tick();
    await test('Nouveau DOM du même tweet sans attendre IntersectionObserver', async () => {
      article = makePost();
      host.replaceChildren(article);
      await tick();
      assert(blur(mediaOf(article)), 'Cache non réappliqué avant IntersectionObserver');
      assert(!pending.has(article), 'Tweet connu inutilement en attente de visibilité');
      assert(calls === initialCalls, 'Nouvel appel API pour un résultat connu');
    });
    // Allow the remaining checks to run on the old implementation too.
    observer([...pending].map((target) => ({target, isIntersecting: true})));
    await tick();
    await test('Afficher puis Masquer : immédiat et volontaire', () => {
      article.querySelector('.jev-reveal').click();
      assert(!blur(mediaOf(article)), 'Afficher sans effet');
      article.querySelector('.jev-reveal').click();
      assert(blur(mediaOf(article)), 'Masquer ne floute pas immédiatement');
    });
    await test('Pas de double filtre pour une vidéo imbriquée', () => {
      const player = document.createElement('div');
      player.dataset.testid = 'videoPlayer';
      const video = document.createElement('video');
      player.append(video);
      article.append(player);
      assert(blur(player), 'Lecteur vidéo non protégé immédiatement');
      assert(getComputedStyle(video).filter === 'none', 'Double filtre sur la vidéo');
    });
    await test('Désactiver le flou enlève la protection', () => {
      settings = {...settings, blurEnabled: false};
      onSettings({type: 'SETTINGS_UPDATED', settings, hasApiKey: true});
      assert(!blur(mediaOf(article)), 'Protection conservée après désactivation');
    });
    report.dataset.status = results.every((result) => result.status === 'PASS') ? 'pass' : 'fail';
    report.textContent = `${results.filter((result) => result.status === 'PASS').length}/${results.length} PASS\n${JSON.stringify(results, null, 2)}`;
  });
})();
