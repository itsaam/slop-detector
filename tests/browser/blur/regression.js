(() => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const waitFor = async (check) => {
    for (let index = 0; index < 100; index++) {
      if (check()) return;
      await delay(20);
    }
    throw new Error('État attendu absent après 2 s');
  };
  const mediaOf = (article) => article.querySelector('[data-testid="tweetPhoto"]');
  const isBlurred = (element) => getComputedStyle(element).filter.includes('blur');
  const results = [];
  const report = document.querySelector('#regressions');
  async function test(name, check) {
    await check();
    results.push({name, status: 'PASS'});
    report.textContent = JSON.stringify(results, null, 2);
  }
  function replaceMedia(article) {
    const media = document.createElement('div');
    media.dataset.testid = 'tweetPhoto';
    media.textContent = 'Média rechargé par X';
    mediaOf(article).replaceWith(media);
    return media;
  }
  const fixture = globalThis.blurFixture;
  document.querySelector('#run-tests').addEventListener('click', async (event) => {
    event.target.disabled = true;
    let watcher;
    try {
      let article = document.querySelector('article');
      article.scrollIntoView({block: 'center'});
      await waitFor(() => isBlurred(mediaOf(article)));
      const initialCalls = fixture.calls();
      const stamp = article.querySelector('.jev-stamp');
      await test('Média remplacé : flou restauré sans API ni nouveau tampon', async () => {
        const media = replaceMedia(article);
        await waitFor(() => isBlurred(media));
        assert(article.querySelector('.jev-stamp') === stamp, 'Tampon recréé');
        assert(fixture.calls() === initialCalls, 'Appel API supplémentaire');
      });
      await test('Classes de X réécrites : flou et état de l’article restaurés', async () => {
        article.className = 'x-replaced-class';
        mediaOf(article).className = 'x-media-class';
        await waitFor(() => isBlurred(mediaOf(article)));
        assert(article.classList.contains('x-replaced-class'), 'Classe X supprimée');
        assert(mediaOf(article).classList.contains('x-media-class'), 'Classe média X supprimée');
      });
      await test('Vidéo ajoutée tardivement : seule sa cible extérieure est floutée', async () => {
        const player = document.createElement('div');
        player.dataset.testid = 'videoPlayer';
        const video = document.createElement('video');
        player.append(video);
        article.append(player);
        await waitFor(() => isBlurred(player));
        assert(!video.classList.contains('jev-blur-target'), 'Double flou vidéo');
        const card = document.createElement('div');
        card.dataset.testid = 'card.wrapper';
        player.replaceWith(card);
        card.append(player);
        await waitFor(() => isBlurred(card) && !player.classList.contains('jev-blur-target'));
      });
      await test('Texte remplacé après classification : nouveau texte flouté', async () => {
        const text = document.createElement('div');
        text.dataset.testid = 'tweetText';
        text.textContent = 'Texte réhydraté dans le fil.';
        article.querySelector('[data-testid="tweetText"]').replaceWith(text);
        await waitFor(() => isBlurred(text));
      });
      await test('Bouton et slot retirés par X : restauration sans rejouer le tampon', async () => {
        article.querySelector('.jev-reveal').remove();
        await waitFor(() => article.querySelector('.jev-reveal'));
        article.querySelector('.jev-result-slot').remove();
        await waitFor(() => article.querySelector('.jev-reveal'));
        assert(article.querySelector('.jev-stamp') === stamp, 'Tampon recréé avec le slot');
      });
      await test('Tampon supprimé par X : restauration sans animation', async () => {
        article.querySelector('.jev-stamp').remove();
        await waitFor(() => article.querySelector('.jev-stamp'));
        assert(getComputedStyle(article.querySelector('.jev-stamp')).animationName === 'none', 'Animation rejouée');
      });
      await test('Afficher reste appliqué après remplacement des médias', async () => {
        article.querySelector('.jev-reveal').click();
        const media = replaceMedia(article);
        await waitFor(() => media.classList.contains('jev-blur-target'));
        assert(!isBlurred(media), 'Choix Afficher perdu');
        assert(article.querySelector('.jev-reveal').textContent === 'Masquer', 'Bouton désynchronisé');
      });
      await test('Détail puis retour au fil : choix Afficher conservé pour le même tweet', async () => {
        const timelineArticle = article;
        article = fixture.makePost();
        document.querySelector('#post').replaceChildren(article);
        article.scrollIntoView({block: 'center'});
        await waitFor(() => article.querySelector('.jev-reveal'));
        assert(!isBlurred(mediaOf(article)), 'Détail a oublié Afficher');
        document.querySelector('#post').replaceChildren(timelineArticle);
        article = timelineArticle;
        await delay(60);
        assert(!isBlurred(mediaOf(article)), 'Retour au fil a oublié Afficher');
        assert(fixture.calls() === initialCalls, 'Nouvel appel au retour');
      });
      await test('Masquer, ouvrir et revenir : flou immédiat dans les deux vues', async () => {
        article.querySelector('.jev-reveal').click();
        await waitFor(() => isBlurred(mediaOf(article)));
        const timelineArticle = article;
        article = fixture.makePost();
        document.querySelector('#post').replaceChildren(article);
        article.scrollIntoView({block: 'center'});
        await waitFor(() => isBlurred(mediaOf(article)));
        document.querySelector('#post').replaceChildren(timelineArticle);
        article = timelineArticle;
        await waitFor(() => isBlurred(mediaOf(article)));
      });
      await test('Article reconstruit sous le même ID : tous les contrôles et le flou reviennent', async () => {
        article.replaceChildren(...fixture.makePost().childNodes);
        await waitFor(() => isBlurred(mediaOf(article)) && article.querySelector('.jev-reveal'));
        assert(fixture.calls() === initialCalls, 'Nouvel appel après reconstruction');
      });
      await test('Réglages : désactivation puis réactivation du flou sans API', async () => {
        fixture.updateSettings({blurEnabled: false});
        await waitFor(() => !article.querySelector('.jev-reveal'));
        assert(!isBlurred(mediaOf(article)), 'Flou encore actif');
        replaceMedia(article);
        fixture.updateSettings({blurEnabled: true});
        await waitFor(() => isBlurred(mediaOf(article)));
        assert(fixture.calls() === initialCalls, 'Nouvel appel pour le réglage');
      });
      await test('Recyclage de l’article : Afficher ne fuit pas vers le nouveau tweet', async () => {
        article.querySelector('.jev-reveal').click();
        article.querySelector('time').parentElement.href = '/fixture/status/62001';
        await waitFor(() => fixture.calls() === initialCalls + 1 && isBlurred(mediaOf(article)));
        assert(article.querySelector('.jev-reveal').textContent === 'Afficher', 'Choix hérité du tweet précédent');
      });
      await test('L’observer se stabilise sans boucle de mutations', async () => {
        await delay(100);
        let mutations = 0;
        watcher = new MutationObserver((records) => { mutations += records.length; });
        watcher.observe(article, {attributes: true, characterData: true, childList: true, subtree: true});
        await delay(150);
        watcher.disconnect();
        assert(mutations === 0, `${mutations} mutations sans action`);
      });
      await test('Réécritures répétées des classes X : travail borné et tampon intact', async () => {
        const before = fixture.calls();
        const currentStamp = article.querySelector('.jev-stamp');
        let mutations = 0;
        watcher = new MutationObserver((records) => { mutations += records.length; });
        watcher.observe(article, {attributes: true, attributeFilter: ['class'], subtree: true});
        for (let index = 0; index < 12; index++) {
          mediaOf(article).className = `x-hydration-${index}`;
          await delay(10);
          assert(isBlurred(mediaOf(article)), 'Flou perdu pendant les réécritures');
        }
        await delay(50);
        watcher.disconnect();
        assert(mutations <= 36, `Trop de mutations de classes : ${mutations}`);
        assert(article.querySelector('.jev-stamp') === currentStamp, 'Tampon recréé');
        assert(fixture.calls() === before, 'Appel API pendant les réécritures');
      });
      await test('Retirer le consentement efface les résultats distants sans nouvel appel', async () => {
        const before = fixture.calls();
        fixture.updateSettings({remoteAnalysisEnabled: false});
        await waitFor(() => article.textContent.includes('Autoriser l’analyse'));
        assert(!article.querySelector('.jev-stamp') && !isBlurred(mediaOf(article)), 'Ancien résultat distant conservé');
        assert(fixture.calls() === before, 'Appel après retrait de consentement');
        fixture.updateSettings({remoteAnalysisEnabled: true});
        await waitFor(() => isBlurred(mediaOf(article)));
      });
      await test('Article détaché pendant le retrait du consentement : ancien verdict invalidé au retour', async () => {
        const before = fixture.calls();
        article.remove();
        fixture.updateSettings({remoteAnalysisEnabled: false});
        document.querySelector('#post').append(article);
        article.scrollIntoView({block: 'center'});
        await waitFor(() => article.textContent.includes('Autoriser l’analyse'));
        assert(!article.querySelector('.jev-stamp') && !isBlurred(mediaOf(article)), 'Résultat distant réappliqué après révocation');
        assert(fixture.calls() === before, 'Appel après révocation hors DOM');
        fixture.updateSettings({remoteAnalysisEnabled: true});
        await waitFor(() => isBlurred(mediaOf(article)));
        assert(fixture.calls() === before + 1, 'L’analyse ne reprend pas après opt-in');
      });
      report.dataset.status = 'pass';
      report.textContent = `${results.length}/${results.length} PASS — DOM et observers natifs, aucun appel externe\n${JSON.stringify(results, null, 2)}`;
    } catch (error) {
      watcher?.disconnect();
      report.dataset.status = 'fail';
      report.textContent = `FAIL après ${results.length} tests : ${error.message}\n${JSON.stringify(results, null, 2)}`;
      console.error(error);
    }
  });
})();
