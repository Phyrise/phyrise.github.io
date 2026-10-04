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

  function requestError(status, kind) {
    const auth = status === 401 || status === 403;
    const message = auth
      ? 'Accès expiré ou refusé. Reconnectez-vous pour ouvrir le document ; le texte cité reste disponible.'
      : status === 404 || status === 410
        ? 'Document original non disponible pour cette référence. Le texte cité reste disponible.'
        : status === 400 || status === 415 || status === 422
          ? 'Ce document original ne peut pas être ouvert. Le texte cité reste disponible.'
          : status === 409
            ? 'La page précise de cette référence ne peut pas être confirmée.'
            : (kind === 'pdf' ? 'PDF complet' : 'Page originale') + ' temporairement indisponible (' + status + ').';
    const error = new Error(message);
    error.status = status;
    error.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    return error;
  }

  async function checked(fetcher, path, accept, kind) {
    const response = await fetcher(path, { headers: { Accept: accept } });
    if (!response.ok) throw requestError(response.status, kind);
    return response;
  }

  // Only a confirmed, explicitly one-based physical page may select a PDF page.
  function physicalPage(status) {
    const page = status && status.page_physique_1based;
    return Number.isInteger(page) && page > 0 && Number.isInteger(status.nb_pages)
      && page <= status.nb_pages ? page : null;
  }

  function caption(status) {
    const physical = physicalPage(status);
    const slide = status.slide_1based;
    const pptx = status.source_type === 'pptx' && Number.isInteger(slide) && slide > 0;
    return (pptx ? 'Diapositive ' + slide + ' · page PDF ' : 'Page PDF ')
      + physical + ' / ' + status.nb_pages;
  }

  function printedCaption(status) {
    const printed = status.page_du_document;
    return printed !== null && printed !== undefined && printed !== ''
      ? 'Numéro imprimé : ' + printed : 'Numéro imprimé non identifié';
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
    const hasPage = page !== undefined && page !== null && page !== '';
    const fetcher = options.apiFetch;
    const urls = new Set();
    const unlocated = 'Page précise non localisée — PDF complet disponible';
    let disposed = false, loaded = false, busy = false, dismiss, version;
    let pdfInfo, pageStatus, pdfButton, authBlocked = false, authMessage;
    node._disposeDocumentView = () => {
      disposed = true;
      if (dismiss) dismiss();
      urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); views.delete(node);
    };
    views.add(node);
    if (!doc) {
      state.textContent = 'Document original non disponible : document non transmis.';
      return node;
    }
    if (typeof fetcher !== 'function') {
      state.textContent = 'Page originale non disponible : connexion au service non configurée.';
      return node;
    }
    const path = kind => '/api/document/' + kind + '?doc=' + encodeURIComponent(doc)
      + (kind === 'status' || kind === 'page' ? '&page=' + encodeURIComponent(page) : '')
      + (version && (kind === 'pdf' || kind === 'page') ? '&v=' + encodeURIComponent(version) : '');
    const retry = button('Réessayer', 'doc-bouton'); retry.hidden = true;
    content.append(retry);
    const explain = error => error instanceof TypeError
      ? 'Impossible de joindre le service documentaire. Le texte cité reste disponible.' : error.message;
    const retryable = error => error instanceof TypeError || error.retryable === true;
    const blockAuth = error => {
      if (error.status === 401 || error.status === 403) {
        authBlocked = true; authMessage = error.message;
        if (pdfButton) pdfButton.disabled = true;
      }
    };
    const addPdfButton = () => {
      if (pdfButton) return;
      pdfButton = button('Ouvrir le PDF complet', 'doc-bouton');
      let permanentFailure = false, downloadLink;
      pdfButton.addEventListener('click', async () => {
        if (disposed || authBlocked || pdfButton.disabled) return;
        // Open the tab within the gesture, before the authenticated request completes.
        const tab = window.open('about:blank', '_blank');
        if (tab) { tab.opener = null; tab.document.title = 'Chargement du document…'; }
        pdfButton.disabled = true;
        try {
          const response = await checked(fetcher, path('pdf'), 'application/pdf', 'pdf');
          const blob = await response.blob();
          if (disposed || authBlocked) { if (tab) tab.close(); return; }
          const url = URL.createObjectURL(blob); urls.add(url);
          const physical = physicalPage(pageStatus);
          const target = url + (physical !== null ? '#page=' + physical : '');
          if (tab && !tab.closed) tab.location.replace(target);
          else {
            if (!downloadLink) {
              downloadLink = el('a', 'doc-bouton', 'Ouvrir le PDF téléchargé');
              downloadLink.target = '_blank'; downloadLink.rel = 'noopener';
              content.append(downloadLink);
            }
            downloadLink.href = target;
            state.textContent = (pageStatus ? caption(pageStatus) : unlocated)
              + ' · Le navigateur a bloqué le nouvel onglet : utilisez le lien ci-dessous.';
          }
        } catch (error) {
          if (tab) tab.close();
          if (!disposed) {
            blockAuth(error); permanentFailure = !retryable(error);
            state.textContent = authBlocked ? authMessage : explain(error);
          }
        } finally { pdfButton.disabled = disposed || authBlocked || permanentFailure; }
      });
      content.append(pdfButton);
      if (options.expert) content.append(el('p', 'doc-aide', 'Le document apporte du contexte ; le verdict porte sur les passages cités.'));
    };
    const load = async () => {
      if (disposed || loaded || busy || authBlocked) return;
      busy = true; retry.hidden = true; state.textContent = 'Chargement de la page originale…';
      try {
        if (!pdfInfo) {
          let info;
          if (hasPage) {
            try {
              const response = await checked(fetcher, path('status'), 'application/json', 'status');
              info = await response.json();
              if (physicalPage(info) !== null) pageStatus = info;
            } catch (error) {
              if (error.status !== 409) throw error;
            }
          }
          if (disposed || authBlocked) return;
          if (!info) {
            const response = await checked(fetcher, path('info'), 'application/json', 'info');
            info = await response.json();
          }
          if (disposed) return;
          if (info.pdf !== true || !Number.isInteger(info.nb_pages) || info.nb_pages < 1
              || typeof info.empreinte_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(info.empreinte_sha256)) {
            throw new Error('Document original non disponible : le PDF ne peut pas être confirmé.');
          }
          pdfInfo = info; version = info.empreinte_sha256;
          // Complete-document access is ready before the optional page image request.
          addPdfButton();
        }
        if (!pageStatus) {
          state.textContent = unlocated; loaded = true; return;
        }
        state.textContent = caption(pageStatus) + ' · Chargement de l’aperçu…';
        const response = await checked(fetcher, path('page'), 'image/png', 'page');
        const blob = await response.blob();
        if (disposed || authBlocked) return;
        const src = URL.createObjectURL(blob); urls.add(src);
        const label = caption(pageStatus);
        state.textContent = label;
        const preview = button('', 'doc-agrandir');
        preview.setAttribute('aria-label', 'Agrandir : ' + label);
        const img = el('img', 'doc-image'); img.src = src; img.alt = label + ' · ' + doc;
        preview.append(img);
        preview.addEventListener('click', () => { dismiss = enlarge(src, label, preview); });
        const hint = el('p', 'doc-aide', 'Page complète. Touchez la page pour agrandir, puis utilisez + et − ou le zoom de votre navigateur.');
        const printed = el('p', 'doc-legende', printedCaption(pageStatus));
        img.addEventListener('error', () => {
          if (disposed) return;
          preview.remove(); hint.remove(); printed.remove();
          URL.revokeObjectURL(src); urls.delete(src);
          state.textContent = authBlocked ? authMessage
            : label + ' · Aperçu indisponible. Le PDF complet reste disponible.';
        });
        content.append(preview, printed, hint);
        loaded = true;
      } catch (error) {
        if (!disposed) {
          blockAuth(error);
          state.textContent = authBlocked ? authMessage : !pdfInfo ? explain(error)
            : caption(pageStatus) + ' · Aperçu indisponible. Le PDF complet reste disponible.';
          retry.hidden = !retryable(error) || authBlocked;
          loaded = retry.hidden;
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
    nettoyer: cleanup, version: '003-document-catalog' };
})();
window.A2MEDDocumentView = A2MEDDocumentView;
