/* Original pages supplement the exact extracted evidence; no text is reconstructed here. */
const A2MEDDocumentView = (() => {
  const views = new Set();
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, cls) => {
    const node = el('button', cls, text); node.type = 'button'; return node;
  };

  async function checked(fetcher, path, accept) {
    const response = await fetcher(path, { headers: { Accept: accept } });
    if (response.status === 401 || response.status === 403) {
      throw new Error('Accès expiré ou refusé. Reconnectez-vous pour ouvrir le document ; le texte cité reste disponible.');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Page originale non disponible (' + response.status + ').');
    }
    return response;
  }

  function caption(status) {
    const physical = Number.isInteger(status.page_physique_1based)
      ? status.page_physique_1based : Number(status.page_physique) + 1;
    const printed = status.page_du_document;
    return 'Page PDF ' + physical + ' / ' + status.nb_pages
      + (printed !== null && printed !== undefined && printed !== ''
        ? ' · numéro imprimé ' + printed : ' · numéro imprimé non identifié');
  }

  function enlarge(src, label, trigger) {
    const position = window.scrollY || 0;
    const priorFocus = document.activeElement;
    const priorOverflow = document.body.style.overflow;
    const dialog = el('dialog', 'doc-agrandissement');
    dialog.setAttribute('aria-label', label);
    const bar = el('div', 'doc-outils');
    const close = button('Fermer', 'doc-fermer');
    const smaller = button('−', 'doc-zoom'); smaller.setAttribute('aria-label', 'Réduire la page');
    const bigger = button('+', 'doc-zoom'); bigger.setAttribute('aria-label', 'Agrandir la page');
    const fit = button('Ajuster', 'doc-zoom');
    const zoomLabel = el('span', 'doc-zoom-label', '100 %');
    zoomLabel.setAttribute('aria-live', 'polite');
    const viewport = el('div', 'doc-pan'); viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', 'Page entière ; déplacez-vous dans la page agrandie');
    const img = el('img', 'doc-page-grande'); img.src = src; img.alt = label;
    viewport.append(img);
    bar.append(close, smaller, zoomLabel, bigger, fit);
    dialog.append(bar, el('p', 'doc-legende', label), viewport);
    document.body.append(dialog);
    document.body.style.overflow = 'hidden';
    let zoom = 1, closed = false;
    const adjust = (next) => {
      zoom = Math.max(1, Math.min(4, next));
      img.style.width = (zoom * 100) + '%';
      zoomLabel.textContent = Math.round(zoom * 100) + ' %';
      smaller.disabled = zoom <= 1; bigger.disabled = zoom >= 4;
    };
    const dismiss = () => {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', keyboard);
      if (dialog.open && dialog.close) dialog.close();
      dialog.remove(); document.body.style.overflow = priorOverflow;
      const focus = trigger && trigger.isConnected ? trigger : priorFocus;
      if (focus && focus.isConnected && focus.focus) focus.focus({ preventScroll: true });
      window.scrollTo(0, position);
    };
    const keyboard = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
      if (event.key !== 'Tab') return;
      const controls = [close, smaller, bigger, fit, viewport].filter(n => !n.disabled);
      const active = document.activeElement;
      if (event.shiftKey && active === controls[0]) {
        event.preventDefault(); controls[controls.length - 1].focus();
      } else if (!event.shiftKey && active === controls[controls.length - 1]) {
        event.preventDefault(); controls[0].focus();
      }
    };
    close.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) dismiss(); });
    document.addEventListener('keydown', keyboard);
    smaller.addEventListener('click', () => adjust(zoom - .5));
    bigger.addEventListener('click', () => adjust(zoom + .5));
    fit.addEventListener('click', () => { adjust(1); viewport.scrollTo(0, 0); });
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    adjust(1); close.focus();
    return dismiss;
  }

  function create(apiBase, source, options = {}) {
    const node = el('details', 'doc-vue');
    const summary = el('summary', 'doc-resume', 'Voir le document original');
    const content = el('div', 'doc-contenu');
    const state = el('p', 'doc-etat'); state.setAttribute('role', 'status');
    node.append(summary, content); content.append(state);
    const doc = source.document || source.doc || '';
    const page = source.page;
    const fetcher = options.apiFetch;
    const urls = new Set();
    let disposed = false, loaded = false, busy = false, dismiss, version;
    node._disposeDocumentView = () => {
      disposed = true;
      if (dismiss) dismiss();
      urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); views.delete(node);
    };
    views.add(node);
    if (!doc || page === undefined || page === null || page === '') {
      state.textContent = 'Page originale non disponible : document ou page non transmis.';
      return node;
    }
    if (typeof fetcher !== 'function') {
      state.textContent = 'Page originale non disponible : connexion au service non configurée.';
      return node;
    }
    const path = kind => '/api/document/' + kind + '?doc=' + encodeURIComponent(doc)
      + (kind === 'pdf' ? '' : '&page=' + encodeURIComponent(page))
      + (version && kind !== 'status' ? '&v=' + encodeURIComponent(version) : '');
    const retry = button('Réessayer', 'doc-bouton'); retry.hidden = true;
    content.append(retry);
    const load = async () => {
      if (disposed || loaded || busy) return;
      busy = true; retry.hidden = true; state.textContent = 'Chargement de la page originale…';
      try {
        const status = await (await checked(fetcher, path('status'), 'application/json')).json();
        if (disposed) return;
        version = status.empreinte_sha256;
        const response = await checked(fetcher, path('page'), 'image/png');
        const blob = await response.blob();
        if (disposed) return;
        const src = URL.createObjectURL(blob); urls.add(src);
        const label = caption(status);
        state.textContent = label;
        const preview = button('', 'doc-agrandir');
        preview.setAttribute('aria-label', 'Agrandir : ' + label);
        const img = el('img', 'doc-image'); img.src = src; img.alt = label + ' · ' + doc;
        preview.append(img);
        preview.addEventListener('click', () => { dismiss = enlarge(src, label, preview); });
        const hint = el('p', 'doc-aide', 'Page complète. Touchez la page pour agrandir, puis utilisez + et − ou le zoom de votre navigateur.');
        const pdf = button('Ouvrir le PDF complet', 'doc-bouton');
        pdf.addEventListener('click', async () => {
          // Open the tab within the gesture, before the authenticated request completes.
          const tab = window.open('about:blank', '_blank');
          if (tab) { tab.opener = null; tab.document.title = 'Chargement du document…'; }
          pdf.disabled = true;
          try {
            const pdfResponse = await checked(fetcher, path('pdf'), 'application/pdf');
            const pdfBlob = await pdfResponse.blob();
            if (disposed) { if (tab) tab.close(); return; }
            const pdfUrl = URL.createObjectURL(pdfBlob); urls.add(pdfUrl);
            const physical = Number.isInteger(status.page_physique_1based)
              ? status.page_physique_1based : Number(status.page_physique) + 1;
            if (tab && !tab.closed) tab.location.replace(pdfUrl + '#page=' + physical);
            else {
              const link = el('a', 'doc-bouton', 'Ouvrir le PDF téléchargé');
              link.href = pdfUrl + '#page=' + physical; link.target = '_blank'; link.rel = 'noopener';
              content.append(link);
              state.textContent = label + ' · Le navigateur a bloqué le nouvel onglet : utilisez le lien ci-dessous.';
            }
          } catch (error) {
            if (tab) tab.close();
            state.textContent = error.message;
          } finally { pdf.disabled = false; }
        });
        content.append(preview, hint, pdf);
        if (options.expert) content.append(el('p', 'doc-aide', 'Le document apporte du contexte ; le verdict porte sur les passages cités.'));
        loaded = true;
      } catch (error) {
        if (!disposed) {
          state.textContent = error instanceof TypeError
            ? 'Impossible de joindre le service documentaire. Le texte cité reste disponible.' : error.message;
          retry.hidden = false;
        }
      } finally { busy = false; }
    };
    retry.addEventListener('click', load);
    node.addEventListener('toggle', () => { if (node.open) load(); });
    return node;
  }

  function cleanup(root) {
    [...views].forEach(node => { if (root.contains(node)) node._disposeDocumentView(); });
  }
  window.addEventListener('pagehide', event => {
    if (!event.persisted) [...views].forEach(node => node._disposeDocumentView());
  });
  return { creer: async (...args) => create(...args), monter: create,
    nettoyer: cleanup, version: '002-authenticated' };
})();
window.A2MEDDocumentView = A2MEDDocumentView;
