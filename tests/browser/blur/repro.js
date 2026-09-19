(() => {
  let calls = 0;
  const checks = [];
  let settings = {threshold: 0.65, blurEnabled: true, contextGuardEnabled: false, remoteAnalysisEnabled: true};
  let onSettings;
  globalThis.chrome = {runtime: {
    onMessage: {addListener(listener) { onSettings = listener; }},
    async sendMessage(message) {
      if (message.type === 'GET_PUBLIC_SETTINGS') return {ok: true, hasApiKey: true, settings};
      if (message.type === 'ANALYZE_TWEET') { calls++; return {ok: true, result: {score: 0.9}}; }
      return {ok: true};
    }
  }};
  function makePost() {
    const article = document.createElement('article');
    article.dataset.testid = 'tweet';
    article.innerHTML = '<strong>Publication témoin</strong> <a href="/fixture/status/62000"><time>1 min</time></a><div data-testid="tweetText">Texte témoin classé slop dans ce test.</div><div data-testid="tweetPhoto">MÉDIA À FLOUTER</div><div role="group"><button data-testid="reply">Répondre</button></div>';
    return article;
  }
  globalThis.blurFixture = {
    makePost,
    calls: () => calls,
    updateSettings(values) {
      settings = {...settings, ...values};
      onSettings({type: 'SETTINGS_UPDATED', settings, hasApiKey: true});
    }
  };
  const timelineArticle = makePost();
  document.querySelector('#post').append(timelineArticle);
  function record(step) {
    const article = document.querySelector('article');
    const media = article.querySelector('[data-testid="tweetPhoto"]');
    const result = {
      step, verdict: article.querySelector('.jev-result-slot')?.dataset.verdict,
      blurEnabledOnArticle: article.classList.contains('jev-slop-blurred'),
      mediaIsBlurTarget: media.classList.contains('jev-blur-target'),
      actualMediaFilter: getComputedStyle(media).filter,
      revealButton: article.querySelector('.jev-reveal')?.textContent,
      apiCalls: calls
    };
    result.status = result.blurEnabledOnArticle && !result.actualMediaFilter.includes('blur') ? 'FAIL: bouton visible mais média net' : 'PASS: média flouté';
    checks.push(result);
    document.querySelector('#result').textContent = JSON.stringify(checks, null, 2);
  }
  const afterRender = (step) => setTimeout(() => record(step), 300);
  setTimeout(() => record('initial'), 600);
  document.querySelector('#replace').addEventListener('click', () => {
    const oldMedia = document.querySelector('[data-testid="tweetPhoto"]');
    const newMedia = document.createElement('div');
    newMedia.dataset.testid = 'tweetPhoto';
    newMedia.textContent = 'MÉDIA CHARGÉ APRÈS LE VERDICT';
    oldMedia.replaceWith(newMedia);
    afterRender('media-replaced');
  });
  document.querySelector('#open').addEventListener('click', () => {
    document.querySelector('#route').textContent = 'Détail du tweet';
    document.querySelector('#post').replaceChildren(makePost());
    afterRender('detail-opened');
  });
  document.querySelector('#back').addEventListener('click', () => {
    document.querySelector('#route').textContent = 'Fil';
    document.querySelector('#post').replaceChildren(timelineArticle);
    afterRender('timeline-restored');
  });
})();
