const API_BASE = String(document.body.dataset.api || window.A2MED_API_BASE || "")
  .replace(/\/$/, "");
const PROXY_SESSION_KEY = "a2med_proxy_session:" + (API_BASE || window.location.origin);
const apiFetch = (path, init = {}) => {
  const { preserveDocumentView, ...requestInit } = init;
  const headers = new Headers(init.headers || {});
  // Session proxy par en-tête (mobile : cookies tiers cross-site bloqués) ; le cookie
  // continue de marcher en parallèle sur les navigateurs qui l'autorisent.
  const session = sessionStorage.getItem(PROXY_SESSION_KEY);
  if (session) headers.set("X-A2Med-Session", session);
  return fetch(API_BASE + path, { ...requestInit, headers, credentials: "include" })
    .catch((e) => { throw window.A2MEDContract.networkError(API_BASE, e); })
    .then(response => {
      // 401 alors qu'une session était posée = session morte (proxy redémarré,
      // token éphémère) → re-passer par le gate. 401 sans session = normal
      // (le gate est encore visible) : on ne reload pas.
      if (!preserveDocumentView && response.status === 401 && sessionStorage.getItem("a2med_test_unlocked") === "1") {
        sessionStorage.removeItem(PROXY_SESSION_KEY);
        sessionStorage.removeItem("a2med_test_unlocked");
        location.reload();
      }
      return response;
    });
};
window.apiFetch = apiFetch; // shared same-origin/session-aware helper for the embedded guided feature
const gate = document.getElementById("passwordGate");
const passwordForm = document.getElementById("passwordForm");
const passwordInput = document.getElementById("sitePassword");
const passwordError = document.getElementById("passwordError");
const passwordSend = document.getElementById("passwordSend");
const QUESTION_EN_ATTENTE = "a2med_pending_question";

/* Trois pannes différentes, trois messages différents (mission web-clinician-v3-001) :
   un mauvais mot de passe n'est pas une coupure réseau, et une session expirée n'est pas
   une page cassée. Avant, tout passait par « Mot de passe incorrect ». */
function gateMessage(status, trace) {
  if (status === 0) return ["Le service n'a pas répondu (réseau coupé, service arrêté ou tunnel "
    + "fermé). Ce n'est pas le mot de passe.", "réseau"];
  if (status === 401) return ["Mot de passe incorrect.", "401"];
  if (status === 403) return ["Accès refusé par le service d'authentification.", "403"];
  if (status >= 500) return ["Le service d'authentification est en panne (" + status
    + "). Réessayez dans quelques instants.", String(status)];
  return ["Le service d'authentification a répondu " + status + ".", String(status)];
}

async function unlock() {
  passwordError.hidden = true;
  if (passwordSend) passwordSend.disabled = true;
  let status = 0, payload = {};
  try {
    const response = await fetch(API_BASE + "/__auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password: passwordInput.value })
    });
    status = response.status;
    payload = await response.json().catch(() => ({}));
  } catch {
    status = 0;                                          // fetch a jeté : pas de service joignable
  } finally {
    if (passwordSend) passwordSend.disabled = false;
  }
  if (status !== 200 || !payload || payload.ok === false) {
    const [message, detail] = gateMessage(status, payload.trace_id);
    passwordError.textContent = message;
    passwordError.hidden = false;
    passwordInput.select();
    passwordInput.focus();
    return;
  }
  if (payload.session) sessionStorage.setItem(PROXY_SESSION_KEY, payload.session);
  sessionStorage.setItem("a2med_test_unlocked", "1");
  gate.remove();
  demarrerApresAuthentification();                       // santé + contrat, maintenant qu'on est autorisé
}

if (sessionStorage.getItem("a2med_test_unlocked") === "1") gate.remove();
if (passwordForm) passwordForm.addEventListener("submit", event => { event.preventDefault(); unlock(); });
/* Le focus et l'état d'attente de la pastille sont posés à la fin du fichier (avec le reste de
   l'initialisation) : ici, `$` et le DOM de la page ne sont pas encore tous définis. */

/* A²-Med UI V1 — aucun framework, aucun CDN, aucune donnée envoyée ailleurs que la
   question elle-même. Le front ne fabrique jamais de contenu médical : il affiche les
   affirmations et les extraits renvoyés par le produit, échappés. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* Tout est échappé AVANT insertion ; la seule mise en forme reconnue est le gras
   déjà présent dans le texte du modèle (**gras**), converti après échappement. */
const rich = (s) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

const HIST = 'a2med_ui_v1_history';

/* Route de streaming. `false` = approche B : plus aucun token n’est affiché, la page
   revient à la requête unique /api/ask (le flux reste utilisable côté serveur). */
const USE_STREAM = true;

/* Une seule carte, plusieurs états (contrat de CONTRACTS.md). Le texte en rédaction vit DANS
   `#answerCard` : la carte ne disparaît plus, elle change d'état. `done` reste le seul à
   écrire la réponse valide. */
const VUES = ['idle', 'search', 'drafting', 'checking', 'result', 'abstention', 'error'];
const ETATS = {
  search: 'Recherche dans les recommandations…',
  drafting: 'Rédaction en cours — non vérifiée',
  checking: 'Vérification des citations…',
};
const STREAM_NOTE = 'Rédaction de la réponse en cours… <span id="elapsed"></span>';
const PREFS = 'a2med_ui_v1_prefs';
const MODEL_DEFAULT_REVISION = 'shono27b-20261008';
const PROVISIONAL = 'prepublication_recommendation';   // même valeur que tools/a2med_web.py
const MAXQ_DEFAULT = 500;
const BUSY_MSG = 'Une réponse est déjà en cours. Attendez sa fin avant d’envoyer '
  + 'une nouvelle question.';
const STATUS = {
  ANSWER: ['Réponse', 'Réponse fondée sur les sources locales'],
  CONDITIONAL_ANSWER: ['Réponse conditionnelle', 'Réponse partielle ou à conditions — lire les limites'],
  ABSTENTION: ['Abstention', 'Le système ne répond pas avec les preuves locales'],
  INCONNU: ['?', 'Statut non reconnu par l’interface'],
};
let busy = false, current = null, tickTimer = null, t0 = 0, maxQ = MAXQ_DEFAULT;
let modelOptions = {};
let repliNote = '';                                          // « reporté sur … », écrit en clair
let modelLabels = {};                       // cle -> libelle humain, pour la ligne de reglage
let streamStats = null;
let healthTimer = null, healthTries = 0, contratCharge = false;
let apercu = null, trameEnAttente = null, dernierBalayage = 0, lecteurEnBas = true;
let prefsMode = null;            // modèle préféré, tant que /api/capabilities n'est pas arrivé

/* sessionStorage/localStorage peuvent refuser d'écrire (navigation privée, cookies bloqués) :
   une page médicale ne doit pas casser pour un réglage non sauvegardé. */
const SEC = {
  get(scope, cle, defaut) {
    try { const v = (scope === 'local' ? localStorage : sessionStorage).getItem(cle);
          return v === null ? defaut : JSON.parse(v); }
    catch { return defaut; }
  },
  set(scope, cle, valeur) {
    try { (scope === 'local' ? localStorage : sessionStorage).setItem(cle, JSON.stringify(valeur)); }
    catch { /* plein ou refusé : on s'en passe */ }
  },
  del(scope, cle) {
    try { (scope === 'local' ? localStorage : sessionStorage).removeItem(cle); } catch { }
  },
};

/* ------------------------------------------------------------ santé du service */
function setPill(state, text, title) {
  const p = $('health');
  p.dataset.state = state;
  $('healthText').textContent = text;
  p.title = title || '';
  $('healthRefresh').hidden = state !== 'indisponible';
}

async function checkHealth() {
  if (busy) return;                                      // le daemon sérialise : ne sonde pas
  try {
    const r = await apiFetch('/api/health');
    const h = await r.json();
    if (!r.ok) throw new Error(String(r.status));    maxQ = (h.limits && h.limits.question_chars) || MAXQ_DEFAULT;
    modelOptions = h.model_options || {};
    $("modelPicker").hidden = Object.keys(modelOptions).length < 2;
    $('q').maxLength = maxQ;
    countChars();
    const gen = h.generator || {}, gpu = h.gpu0 || {};
    const detail = [`gpu0 ${gpu.mem_used_mib ?? '?'} MiB`, `${h.n_pool ?? '?'} passages retenus`,
      `génératrice ${gen.ok ? 'ok' : 'indisponible'}`,
      h.corpus_fingerprint ? `empreinte ${String(h.corpus_fingerprint).slice(0, 8)}` : '']
      .filter(Boolean).join(' · ');
    /* Millésime : l'empreinte du corpus réellement chargé, pas une date écrite en dur dans
       la page (une page publiée en mars afficherait encore « août 2026 »). */
    $('fingerprint').textContent = h.corpus_fingerprint
      ? `Corpus SPILF · empreinte ${String(h.corpus_fingerprint).slice(0, 12)}`
      : 'Corpus SPILF · empreinte non communiquée';
    if (h.state === 'demarrage') {
      setPill('demarrage', 'Initialisation des modèles…', 'Le moteur se démarre une fois '
        + 'par séance (environ 15 s : corpus et index résidents, worker GPU distant).');
      pollHealth();
      return;
    }
    if (h.state !== 'pret' || !h.daemon || !h.daemon.alive) {
      setPill('indisponible', 'Service indisponible', gen.error
        ? `génératrice : ${gen.error}` : 'Le service local de calcul ne répond pas.');
      return;
    }
    if (h.daemon.worker_down) {
      setPill('degrade', 'Moteur de recherche à relancer', detail);
      return;
    }
    setPill('pret', 'Service prêt', detail);   // même mot que /eval ; « Sparka » est un nom de machine,
                                               // il n'a rien à faire sur une page publique
  } catch {
    setPill('indisponible', 'Service indisponible',
      'La page n’a pas pu joindre le service de calcul.');   // ni port ni hôte sur un écran public
  }
}

function pollHealth() {                                   // léger, seulement pendant boot
  clearTimeout(healthTimer);
  if (healthTries++ > 40) return;
  healthTimer = setTimeout(checkHealth, 4000);
}

/* ------------------------------------------------------------ rendu réponse */
function chips(refs, rendues) {
  /* Une puce [S1] est un accès à la preuve, pas un décor : c'est un bouton, tactile d'abord,
     qui descend à la source correspondante. Jamais un lien href inventé vers un document. */
  if (!refs || !refs.length) return '';
  const dispo = [...new Set(refs.filter((r) => !rendues || rendues.has(r)))];
  /* Une référence annoncée par le moteur mais absente des preuves réellement rendues n'est
     pas un lien : elle devient un marqueur. Un bouton qui ne mène nulle part serait une
     promesse de preuve que le système ne tient pas. */
  const absentes = [...new Set(refs.filter((r) => rendues && !rendues.has(r)))];
  return `<span class="refs">${dispo.map((r) => `<button type="button" class="ref-chip" data-ref="${esc(r)}"`
      + ` aria-label="Afficher la source ${esc(r)} dans les preuves citées">${esc(r)}</button>`)
      .join('')}${absentes.map((r) => `<span class="unresolved" title="référence annoncée par le `
      + `moteur, absente des sources rendues">${esc(r)} : preuve non rendue</span>`).join('')}</span>`;
}

function liCitations() {
  document.querySelectorAll('#answer [data-ref]').forEach((el) => {
    el.onclick = () => versSource(el.dataset.ref);
  });
}

/* « Voir la source » : ancre réelle dans la liste des preuves, extrait ouvert, cible
   brièvement surlée. Si la citation n'a pas été résolue, la source n'est pas là : le dire
   vaut mieux qu'un clic muet. */
function versSource(ref) {
  const cible = document.getElementById('src-' + ref);
  if (!cible) {
    notice(`La source ${ref} n’est pas dans la liste des preuves : sa citation n’a pas été résolue.`,
      'citation non résolue');
    return false;
  }
  const det = cible.querySelector('details');
  if (det) det.open = true;
  try { history.replaceState(null, '', '#src-' + ref); } catch { /* pas d'historique en file:// */ }
  cible.scrollIntoView({ behavior: 'smooth', block: 'start' });
  cible.classList.add('is-jump');
  setTimeout(() => cible.classList.remove('is-jump'), 1600);
  say(`Source ${ref} affichée plus bas.`);
  return true;
}

/* Autorités et statut de source : lus du registre (payload), jamais du modèle. Sans source_meta
   (corpus v6.1) societies est vide -> libellé actuel « corpus SPILF », aucun bandeau. */
function corpusLabel(data) {
  const auth = [...new Set((data.sources || []).flatMap((s) => s.societies || []))];
  return auth.length ? `d’après corpus ${auth.join(' · ')}` : 'd’après corpus SPILF';
}

function renderProvisional(data) {
  const banner = $('provisionalBanner');
  const prov = (data.sources || []).filter((s) => s.source_status === 'prepublication_recommendation');
  banner.hidden = !prov.length;
  if (!prov.length) return;
  const who = [...new Set(prov.flatMap((s) => s.societies || []))].join(' / ');
  const where = [...new Set(prov.map((s) => s.event).filter(Boolean))].join(', ');
  const detail = who ? ` — ${who}${where ? ` (${where})` : ''} : support présenté en congrès, ` : ' : ';
  banner.innerHTML = '<strong>Inclut une recommandation pré-publication / en cours de finalisation</strong>'
    + `<span class="fine">${esc(detail)}pas encore la version finale publiée en rubrique officielle. `
      + 'À ne pas citer comme une recommandation définitive.</span>';
}

function sourceCount(data) {
  const n = ((data && data.sources) || []).length;
  return n ? ` · ${n} source${n > 1 ? 's' : ''}` : '';
}

function renderAnswer(data) {
  const total = data.timings && Number.isFinite(data.timings.t_total_s)
    ? ` · ${data.timings.t_total_s.toFixed(1)} s` : '';
  if (data.source_only) {
    $('answerCard').dataset.status = 'SOURCES_ONLY';
    $('statusCode').textContent = 'SOURCES';
    $('statusMeaning').textContent = data.guided ? '' : corpusLabel(data);
    $('answerTime').textContent = `Recherche${total}${sourceCount(data)}`;
    renderProvisional(data);
    $('answer').innerHTML = '<p>Les passages ci-dessous sont les cinq résultats du retrieval. '
      + 'Aucune synthèse n’a été générée.</p>'
      + '<button type="button" class="btn primary" id="synthBtn">Synthétiser ces sources</button>';
    $('limits').hidden = true;
    $('copyAllBtn').hidden = true;
    return;
  }
  const code = STATUS[data.status] ? data.status : 'INCONNU';
  const [label, meaning] = STATUS[code];
  $('answerCard').dataset.status = code;
  $('statusCode').textContent = label;
  $('statusMeaning').textContent = data.guided ? '' : corpusLabel(data);
  $('answerTime').textContent = `Réponse${total}${sourceCount(data)}`;
  /* Le modèle QUI A PARLÉ, lu dans la décharge du résultat (`technique.gen_model`), jamais
     déduit du sélecteur : si ce nom ne correspond pas à la sélection, la divergence est
     visible sans ouvrir les options avancées. */
  const ligne = $('answerModel');
  if (ligne) {
    const servi = (data.technique || {}).gen_model;
    ligne.hidden = !servi || !!data.guided;
    ligne.textContent = servi ? `modèle servi : ${servi}` : '';
    ligne.title = 'Nom signalé par le moteur dans la décharge du résultat';
  }
  renderProvisional(data);

  const claims = data.answer || [];
  if (code === 'ABSTENTION' || !claims.length) {
    // Une abstention n'est jamais une erreur, et n'est jamais une fausse réponse :
    // aucun claim n'est listé, même si le moteur en a produit.
    $('answer').innerHTML = `<p class="abstain-reason">${esc(data.reason ||
      'Les passages récupérés ne permettent pas une réponse sûre avec le corpus local.')}</p>`;
  } else {
    const rendues = new Set((data.sources || []).map((x) => x.ref));
    $('answer').innerHTML = `<ol class="claims">${claims.map((c) => `<li>${rich(c.text)}${chips(c.refs, rendues)}${
      c.citation_valid === false ? '<span class="unresolved">citation non résolue</span>' : ''
    }</li>`).join('')}</ol>`;
    liCitations();
  }

  const lim = data.limitations || [];
  $('limits').hidden = !lim.length;
  $('limits').innerHTML = lim.length
    ? `<h3 class="section-title">${code === 'ABSTENTION'
      ? 'Ce qui manque' : 'Limites et conditions'}</h3><ul>${
      lim.map((l) => `<li>${rich(l)}</li>`).join('')}</ul>` : '';

  // Une abstention n'a pas de « réponse » ni de sources : les actions suivent l'état réel.
  const src = data.sources || [];
  $('copyAllBtn').hidden = code === 'ABSTENTION' || !src.length;
}

/* Titre lisible du document : le nom de fichier sans extension, espaces à la place des
   tirets. Aucun mot ajouté, aucune référence bibliographique inventée ; le nom exact
   reste visible en bas de carte. */
function humanDoc(name) {
  return String(name || '').replace(/\.(pptx|pdf|docx?|odp|key)$/i, '')
    .replace(/^\d{4}[-_]+/, '').replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
}

function sourceYear(name) {
  const m = String(name || '').match(/^(19|20)\d{2}/);
  return m ? m[0] : '';
}

/* Étiquettes de preuve : uniquement des champs lus du registre, transmis par l'API
   (`source_status`, `source_authority`, `societies`, `event`, `official_final_version`,
   `registry_status`). Ni date devinée dans le nom de fichier, ni pourcentage de confiance.
   Ce que l'API ne transmet pas (date de version, DOI, URL du document) n'est pas affiché —
   voir HANDOFF : l'exposer demanderait d'élargir la payload, hors périmètre science figée. */
function sourceBadges(s) {
  const lu = (v) => (v === undefined || v === null || v === '' ? '' : String(v));
  const etat = { published: 'document publié', withdrawn: 'RETIRÉ DU CORPUS' };
  const statut = lu(s.source_status);
  const puce = (cls, texte, titre) => `<span class="badge badge-${cls}"${titre
    ? ` title="${esc(titre)}"` : ''}>${esc(texte)}</span>`;
  const out = [];
  if (statut === PROVISIONAL) {
    out.push(puce('prov', `prépublication${s.event ? ` · ${s.event}` : ''}`,
      'support présenté en congrès, pas encore la version finale officielle'));
  } else {
    out.push(puce('doc', etat[statut] || statut, 'statut lu du registre canonique'));
  }
  if (s.official_final_version === false) {
    out.push(puce('warn', 'pas la version finale', 'official_final_version = false (registre)'));
  }
  const societes = (s.societies && s.societies.length ? s.societies : [s.source_authority])
    .filter(Boolean);
  if (societes.length) out.push(puce('auth', societes.join(' · '), 'autorité de la source'));
  if (lu(s.registry_status)) out.push(puce('reg', `registre : ${s.registry_status}`,
    'état de la transcription dans le registre'));
  return out;
}

function sourceType(name) {
  const m = String(name || '').match(/\.(pptx|pdf|docx?|odp|key)$/i);
  return m ? m[1].toUpperCase().replace('PPTX', 'PPT') : 'Document';
}

/* Preuve à trois niveaux (§7-§10 de la mission).
   1. PREUVE RETENUE = vue mise en page, produite par le formatter déterministe, jamais par un
      LLM ; c'est la vue par défaut parce qu'elle se lit, mais ce n'est pas la vérité :
   2. TEXTE BRUT = la chaîne exacte transmise par l'API, dans un <pre>, sans aucun traitement ;
   3. CONTEXTE = les champs réellement transmis (document, page, fin de page, registre) et la
      liste des autres passages du même document déjà présents dans la réponse.
   Rien n'est complété : ce que l'API ne transmet pas est écrit « non transmis ». Notamment la
   SECTION du document et l'URL canonique du fichier ne sont pas dans la payload — les inventer
   serait une fabrication, et un lien construit depuis le nom de fichier mènerait ailleurs. */
const LIM_VUE = 1200;                       // au-delà, la suite est dépliable, jamais cachée

function preuveHtml(s, ex, src) {
  const brut = String(s.text !== undefined && s.text !== null && s.text !== '' ? s.text : ex);
  const vue = A2MEDEvidenceView.formater(brut, { page: s.page });
  let html = A2MEDEvidenceView.vers_html(vue).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const tropLong = vue.net.length > LIM_VUE;
  const ref = esc(s.ref);
  const autres = (src || []).filter((o) => o !== s && o.document === s.document)
    .map((o) => `${o.ref}${o.page !== undefined && o.page !== null ? ` p. ${esc(o.page)}` : ''}`);
  const champs = [
    ['Document', `${humanDoc(s.document)} · ${esc(s.document)}`],
    ['Page/diapositive', s.page === undefined || s.page === null || s.page === ''
      ? 'non transmise' : `page ${esc(s.page)}${s.page_end !== undefined && s.page_end !== null
        && s.page_end !== s.page ? ` → ${esc(s.page_end)}` : ''} du fichier`],
    ['Registre', s.source_id ? `${esc(s.source_id)}${s.registry_status ? ` · ${esc(s.registry_status)}` : ''}`
      : 'non transmis'],
    ['Section du document', 'non transmise par l’API'],
    ['Autre passage de ce document dans la réponse', autres.length ? autres.join(' · ') : 'aucun'],
  ];
  return `<div class="src-preuve" data-preuve="${ref}">
    <details class="preuve-texte"><summary>Texte du passage</summary>
    <div class="preuve-vue${tropLong ? ' est-pliee' : ''}">${html}</div>
    ${tropLong ? `<p class="preuve-plus"><button type="button" class="bouton-preuve"
      data-action="derouler" data-src="${ref}" aria-expanded="false">Tout afficher
      (${vue.net.length - LIM_VUE} caractères de plus)</button></p>` : ''}
    <p class="preuve-actions">
      <button type="button" class="bouton-preuve" data-action="brut" data-src="${ref}"
        aria-expanded="false">Afficher le texte brut</button>
      <button type="button" class="bouton-preuve" data-action="contexte" data-src="${ref}"
        aria-expanded="false">Contexte de la source</button>
    </p>
    <div class="preuve-brut" hidden>${A2MEDEvidenceView.brut_html(brut)}
      <p class="fine">Texte exact transmis par l’API, aucun traitement. La mise en page n’est
        qu’une vue : c’est ici la vérité à comparer.</p></div>
    <div class="preuve-contexte" hidden><dl class="contexte">
      ${champs.map(([c, v]) => `<dt>${c}</dt><dd>${v}</dd>`).join('')}
      </dl>
      <p class="fine">La page indiquée est celle du fichier extrait ; la page imprimée du document
        peut être décalée (couverture, sommaire). La vue « document original » ci-dessus ne vient
        pas d'une URL transmise par l'API — le serveur retrouve le fichier dans son corpus et la
        correspondance est vérifiée texte par texte ; si elle ne l'est pas, il le dit.</p></div>
    </details>
    <div class="doc-emplacement" data-doc="${esc(s.document)}"
         data-page="${esc(s.page === undefined || s.page === null ? '' : s.page)}"></div>
  </div>`;
}

/* Bascules des trois niveaux. Un seul délégataire pour les deux modes : les cartes sont
   recréées à chaque réponse, un handler par bouton serait perdu au re-rendu. */
function installerBasculesPreuve(racine) {
  racine.addEventListener('click', (ev) => {
    const bouton = ev.target.closest('button[data-action]');
    if (!bouton) return;
    const carte = bouton.closest('[data-preuve]');
    if (!carte) return;
    const action = bouton.dataset.action;
    if (action === 'derouler') {
      const vue = carte.querySelector('.preuve-vue');
      vue.classList.remove('est-pliee');
      bouton.closest('.preuve-plus').hidden = true;
      return;
    }
    const cible = carte.querySelector(action === 'brut' ? '.preuve-brut' : '.preuve-contexte');
    const ouvre = cible.hidden;
    cible.hidden = !ouvre;
    bouton.setAttribute('aria-expanded', ouvre ? 'true' : 'false');
    bouton.textContent = ouvre
      ? (action === 'brut' ? 'Masquer le texte brut' : 'Masquer le contexte')
      : (action === 'brut' ? 'Afficher le texte brut' : 'Contexte de la source');
    if (ouvre) cible.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

installerBasculesPreuve($('sources'));

function renderSources(data) {
  const src = data.sources || [];
  $('sourcesNote').hidden = !data.source_only || !src.length;
  const times = data.timings || {};
  const measured = [];
  if (data.reuse_context) measured.push('Passages conservés');
  else if (Number.isFinite(times.retrieval_s)) measured.push(`Recherche : ${times.retrieval_s.toFixed(2)} s`);
  if (!data.source_only && Number.isFinite(times.generation_s)) measured.push(`Rédaction : ${times.generation_s.toFixed(1)} s`);
  $('resultTiming').textContent = measured.join(' · ');
  $('resultTiming').hidden = !measured.length;
  $('sourcesPanel').hidden = !src.length;
  $('sourcesTitle').textContent = data.source_only
    ? `Passages retrouvés — sans synthèse (${src.length})`
    : `Sources citées (${src.length})`;
  if (window.A2MEDDocumentView) window.A2MEDDocumentView.nettoyer($('sources'));
  $('sources').innerHTML = src.map((s, index) => {
    const ex = String(s.excerpt ?? '');
    const annee = sourceYear(s.document);
    return `<article class="source" id="src-${esc(s.ref)}">
      <h3 class="src-title"><span class="ref">${esc(s.ref)}</span> ${esc(humanDoc(s.document))}</h3>
      <p class="src-meta"><span>${esc(s.document)}</span>
        <span>Repère du registre ${esc(s.page === undefined || s.page === null || s.page === ''
          ? 'non renseignée' : s.page)}</span>
        ${annee ? `<span>année du fichier : ${esc(annee)}</span>` : ''}
        <span>${esc(sourceType(s.document))}</span>
        ${data.source_only ? `<span>Rang ${index + 1}/${src.length}</span>` : ''}</p>
      <p class="src-meta src-meta-detail">${sourceBadges(s).join('')}</p>
      ${preuveHtml(s, ex, src)}      <details class="source-tech"><summary>Identifiant technique</summary>
        <p class="fine mono">${esc(s.passage_id)}${data.source_only && Number.isFinite(s.rerank_score)
          ? ` · score ${esc(s.rerank_score.toFixed(3))}` : ''}</p></details>
      </article>`;
  }).join('');
  installerVuesDocument($('sources'));
}

/* Vue « document original » : le module est asynchrone et dépend du serveur, donc il se monte
   APRÈS le rendu HTML des cartes, en remplacement de l'emplacement vide posé par `preuveHtml`.
   Installé là et non au chargement : les cartes sont recréées à chaque réponse. */
function installerVuesDocument(racine) {
  const V = window.A2MEDDocumentView;
  const emplacements = [...racine.querySelectorAll('.doc-emplacement')];
  if (!emplacements.length) return;
  if (!V) {
    // même règle que le front expert : pas de vue improvisée quand le module manque, on la nomme
    emplacements.forEach((e) => {
      const p = document.createElement('p');
      p.className = 'fine';
      p.textContent = 'Vue « document original » indisponible : module non chargé.';
      e.append(p);
    });
    return;
  }
  emplacements.forEach((e) => {
    V.creer(API_BASE, { document: e.dataset.doc, page: e.dataset.page }, {
      compact: true,
      apiFetch: (path, init) => apiFetch(path, { ...init, preserveDocumentView: true })
    })
      .then((bloc) => {
        if (e.isConnected) e.replaceWith(bloc);
        else bloc._disposeDocumentView();
      })
      .catch(() => {});
  });
}

function renderTech(data) {
  const t = data.timings || {}, q = data.technique || {}, s = (q.sampling || {});
  const row = (k, v) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
  const st = data.guided ? (data.stream_stats || null) : streamStats;
  const stream = st ? [
    row('premier token (côté moteur)', `${st.ttft_s ?? '?'} s`),
    row('rédaction en flux (moteur)', `${st.gen_stream_s ?? '?'} s`),
    row('tronçons reçus par le moteur', st.chunks),
    row('caractères assemblés par le moteur', st.content_chars),
  ] : [];
  $('tech').innerHTML = `<table><tbody>${[
    row('statut affiché', data.status),
    row('statut proposé par le modèle', data.status_requested),
    row('durée totale', `${t.t_total_s ?? '?'} s`),
    row('récupération des passages', `${t.retrieval_s ?? '?'} s`),
    row('rédaction de la réponse', `${t.generation_s ?? '?'} s`),
    row('passages remis au générateur', q.context_depth),
    row('affirmations / sources citées', `${q.n_claims ?? '?'} / ${q.n_sources ?? '?'}`),
    row('corpus (passages / pool après filtre)', `${q.n_passages ?? '?'} / ${q.n_pool ?? '?'}`),
    row('citations toutes résolues', q.claims_all_valid ? 'oui' : 'non'),
    row('génératrice', `${q.gen_model} · temp ${s.temperature} · max_tokens ${s.max_tokens}`
      + ` · thinking ${s.enable_thinking ? 'on' : 'off'}`),
    row('documents obsolètes exclus', (q.obsolete_excluded_stems || []).join(', ') || 'aucun'),
    row('hash du prompt de génération', q.generation_prompt_sha256 || '?'),
    ...stream,
  ].join('')}</tbody></table>`;
}

function render(data) {
  $("answerCard").dataset.guided = String(!!data.guided);
  $("answerCard").dataset.preview = "result";
  const carte = $('answerCard');
  const topAvant = carte.isConnected ? carte.getBoundingClientRect().top : null;
  const suivait = lecteurEnBas;
  current = data;
  $('error').hidden = true;
  $('result').hidden = false;
  renderAnswer(data);
  renderSources(data);
  renderTech(data);
  setView(data.source_only ? 'result' : (data.status === 'ABSTENTION' ? 'abstention' : 'result'));
  if (data.source_only && $('synthBtn')) $('synthBtn').onclick = synthesizeSources;
  // Le lecteur ne doit pas voir sa ligne sauter quand le brouillon devient la réponse : on
  // réajuste le défilement de la seule différence de hauteur, et seulement s'il ne suivait pas.
  if (!suivait && topAvant !== null) {
    const ecart = carte.getBoundingClientRect().top - topAvant;
    if (Math.abs(ecart) > 8) window.scrollBy(0, ecart);
  }
}

/* ------------------------------------------------------------ erreurs (français, sobre) */
function notice(message, detail) {
  const n = $('error');
  n.hidden = false;
  n.textContent = message;
  if (detail) {
    const d = document.createElement('span');
    d.className = 'notice-detail';
    d.textContent = detail;
    n.appendChild(d);
  }
}

/* Une seule région vivante pour la progression et le résultat : ce que l'écran devient,
   un lecteur d'écran le lit. Les pannes ne passent PAS ici : `#error` a déjà
   `role="alert"`, qui annonce — annoncer deux fois la même phrase serait du bruit. */
function say(msg) { $('srStatus').textContent = msg; }

/* ------------------------------------------------------------ progression */
function setStep(active) {
  [...$('steps').children].forEach((li, i) => {
    li.classList.toggle('active', i === active);
    li.classList.toggle('past', i < active);
    if (i === active) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function selectedModel() {
  // A sole available model can hide the picker without changing the sent generator.
  const v = document.querySelector('input[name="model"]:checked')?.value || null;
  return v === "flash" ? null : v;
}

function updateMode() {
  const mode = selectedMode();
  $('modeHint').textContent = '';
  updatePresetLine();
  $('askBtn').textContent = mode === 'sources' ? 'Rechercher les sources' : 'Obtenir une réponse';
}

function lockModes(value) {
  document.querySelectorAll('input[name="mode"]').forEach(el => { el.disabled = value; });
}

function tick() {
  const elapsed = $('elapsed');
  if (elapsed) elapsed.textContent = `${Math.round((Date.now() - t0) / 1000)} s écoulées`;
}

function startProgress(mode = selectedMode(), reuse = false) {
  t0 = Date.now();
  $('progress').dataset.guided = 'false';
  $('progress').hidden = false;
  $('progressLead').textContent = mode === 'sources' ? 'Recherche des sources en cours' : reuse ? 'Synthèse des sources conservées' : 'Calcul de la réponse en cours';
  [...$('steps').children].forEach((li, i) => {
    li.hidden = (mode === 'sources' && i >= 2) || (reuse && i < 2);
  });
  $('progressNote').innerHTML = 'En attente du moteur. <span id="elapsed"></span>';
  setStep(-1);
  tick();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 300);
}

function stopProgress() {
  clearInterval(tickTimer);
  $('progress').hidden = true;
}

/* ------------------------------------------------------------ états de la carte unique */
function setPillAttente() {
  setPill('attente', 'État non vérifié',
    'Connectez-vous pour que la page puisse interroger le service de calcul.');
}

function setView(vue) {
  const carte = $('answerCard');
  carte.dataset.view = VUES.includes(vue) ? vue : 'idle';
  const enCours = vue === 'search' || vue === 'drafting' || vue === 'checking';
  $('result').dataset.loading = String(enCours);
  $('drafting').hidden = !enCours;
  if (enCours) $('draftFlag').textContent = ETATS[vue];
  if (!enCours) videApercu();
  // Une réponse provisoire ne se copie pas : le bouton n'est pas grisé, il n'est pas là.
  const copie = $('copyAllBtn');
  if (copie) copie.hidden = vue !== 'result' || !current || !!current.source_only
    || current.status === 'ABSTENTION';
}

function videApercu() {
  if ($('draftList')) $('draftList').innerHTML = '';
  if ($('draftMore')) $('draftMore').hidden = true;
}

function effaceCarte() {
  $('answer').innerHTML = '';
  $('limits').innerHTML = '';
  $('limits').hidden = true;
  $('provisionalBanner').hidden = true;
  $('sourcesPanel').hidden = true;                 // des sources de la question d'avant
}                                                    // laisseraient croire à une preuve en cours

function rendApercu() {
  trameEnAttente = null;
  const liste = $('draftList');
  if (!liste) return;
  liste.innerHTML = apercuTextes.map((t) => `<li>${rich(t)}</li>`).join('');
  if (lecteurEnBas) {                              // suivre en bas, jamais tirer le lecteur
    const y = Math.max(window.scrollY + (document.body.scrollHeight - window.innerHeight), 0);
    window.scrollTo(0, y);
  }
}

function programmeRendu() {
  if (trameEnAttente !== null) return;             // regroupé : une passe par image
  trameEnAttente = requestAnimationFrame(rendApercu);
}

let apercuTextes = [];

function debutApercu() {
  if (window.A2MEDStreamView) apercu = window.A2MEDStreamView.creer();
  apercuTextes = [];
  suitLeBas();                                            // position RÉELLE : on ne part pas du haut
  videApercu();
}

function apercuDelta(texte) {
  if (!apercu) return;                             // pas de décodeur : rien de brut n'est montré
  const r = apercu.delta(texte);
  if (r.debordement && $('draftMore')) {
    $('draftMore').textContent = 'Affichage limité pendant la rédaction — le texte complet '
      + 'complet n’est pas montré ; la réponse finale s’affiche après vérification.';
    $('draftMore').hidden = false;
  }
  if (r.en_attente) return;                        // fragment non interprétable : on attend
  apercuTextes = apercuTextes.concat(r.textes);
  programmeRendu();
}

/* ------------------------------------------------------------ flux SSE /api/ask/stream */
async function readSse(res, onEvent) {
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event:[ \t]*(.+)$/m.exec(frame);
      const data = /^data:[ \t]*(.+)$/m.exec(frame);
      if (ev && onEvent(ev[1], data ? JSON.parse(data[1]) : {})) return;
    }
  }
}

async function askStream(q, mode = selectedMode(), sourceToken = null) {
  /* Renvoie {ok, data} | {erreur} | {route_absente} pour que ask() garde UNE seule
     sortie de rendu et puisse retomber sur /api/ask si le flux n'existe pas. */
  const r = await apiFetch('/api/ask/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: q, mode, ...(selectedModel() ? { model: selectedModel() } : {}), ...(sourceToken ? { source_token: sourceToken } : {}) }) });
  if (!r.ok) {
    let text = '', data = null;
    try { text = await r.text(); data = text ? JSON.parse(text) : {}; } catch { data = null; }
    if (r.status === 404 && data && data.code === 'route') return { routeAbsente: true };
    const err = window.A2MEDContract.httpError(r, text, data && data.trace_id);
    return { erreur: err.message, detail: err.detail || '' };
  }
  $('progress').dataset.real = '1';
  $('progressNote').innerHTML = STREAM_NOTE;
  let out = null, erreur = null;
  streamStats = null;
  await readSse(r, (ev, data) => {
    if (ev === 'stage') {
      const stages = { retrieval: 0, selection: 1, rerank: 1, generation: 2, validation: 3 };
      if (Object.hasOwn(stages, data.name)) setStep(stages[data.name]);
    } else if (ev === 'text_delta') {
      setStep(2);
      if ($('answerCard').dataset.view !== 'drafting') { setView('drafting'); }
      apercuDelta(data.text);                          // texte reconnu seulement, jamais le JSON brut
    } else if (ev === 'validation') {
      if (data.stage === 'generation_terminee') { setStep(3); setView('checking'); }
      else streamStats = data.stream_stats || null;          // TTFT mesuré côté moteur
    } else if (ev === 'done') {
      out = data;
      return true; // validated result is complete; do not wait for SSE close
    } else if (ev === 'error') {
      // panne technique : le texte technique passe avant le texte générique, le code reste affiché
      erreur = { message: data.message_technique || data.error,
                 detail: data.detail || (data.code ? `code ${data.code}` : ''),
                 technical_status: data.technical_status || '' };
      return true;
    }
  });
  if (erreur) return { erreur: erreur.message, detail: erreur.detail };
  if (!out) return { erreur: 'Le flux s’est arrêté avant la fin du calcul. Rien n’est '
    + 'affiché plutôt qu’une réponse non vérifiée.' };
  return { ok: true, data: out };
}

async function askClassic(q, mode = selectedMode(), sourceToken = null) {
  setStep(-1);
  $('progressNote').innerHTML = 'Calcul en cours ; les étapes en direct sont indisponibles. <span id="elapsed"></span>';
  const r = await apiFetch('/api/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: q, mode, ...(selectedModel() ? { model: selectedModel() } : {}), ...(sourceToken ? { source_token: sourceToken } : {}) }) });
  let text = '', data = null;
  try { text = await r.text(); data = text ? JSON.parse(text) : {}; } catch { data = null; }
  if (!r.ok || data === null) {
    // une panne du service reste nommée et actionnable (API 503 — générateur indisponible,
    // JSON invalide — HTTP 502 reçu text/html …), jamais un message vague
    const err = window.A2MEDContract.httpError(r, text, data && data.trace_id);
    return { erreur: err.message, detail: err.detail || '' };
  }
  return { ok: true, data };
}

/* Une panne = un seul chemin d'affichage, le même quel que soit l'envoyeur (flux, route
   JSON, réseau coupé) : message français en clair, code technique conservé, texte provisoire
   retiré de la carte. La réponse d'une AUTRE question n'est jamais ressuscitée : une carte
   vide sous une question récente serait une confusion médicale. */
function showFailure(message, detail) {
  notice(message, detail || '');
  setView('error');                                        // rien de brut ne reste dans la carte
  $('answer').innerHTML = '<p class="abstain-reason">Aucune réponse : la question n’a pas abouti.</p>';
  $('sourcesPanel').hidden = true;
  checkHealth();
}

/* ------------------------------------------------------------ question */
function memoriseReglages() {
  SEC.set('local', PREFS, { mode: selectedMode(), modelDefaultRevision: MODEL_DEFAULT_REVISION, model: (document.querySelector(
    'input[name="model"]:checked') || {}).value || null,
    options: $('optionsBox') ? $('optionsBox').open : false });
}

async function synthesizeSources() {
  if (busy || !current || !current.source_token) return;
  const question = current.question, token = current.source_token;
  busy = true;
  lockModes(true);
  $('askBtn').disabled = true;
  $('error').hidden = true;
  streamStats = null;
  effaceCarte(); debutApercu(); setView('search');
  startProgress('standard', true);
  say('Synthèse des passages conservés en cours.');
  try {
    let res = USE_STREAM ? await askStream(question, 'standard', token) : await askClassic(question, 'standard', token);
    if (res.routeAbsente) res = await askClassic(question, 'standard', token);
    if (res.erreur) showFailure(res.erreur, res.detail);
    else {
      render(res.data);
      say('Réponse prête. ' + (STATUS[res.data.status] || STATUS.INCONNU)[1]);
    }
  } catch {
    showFailure('Le service local ne répond pas : la synthèse n’a pas pu être produite.');
  } finally {
    stopProgress();
    $('askBtn').disabled = false;
    lockModes(false);
    busy = false;
  }
}

async function ask() {
  if (busy) { notice(BUSY_MSG); return; }
  const q = $('q').value.trim();
  if (!q) { notice('Écrivez une question avant d’envoyer.'); $('q').focus(); return; }
  if (q.length > maxQ) {
    notice(`Question trop longue : ${q.length} caractères, maximum ${maxQ}. `
      + 'Retranchissez le contexte superflu.');
    return;
  }
  busy = true;
  $('askBtn').disabled = true;
  lockModes(true);
  $('error').hidden = true;                                  // un échec ne doit pas effacer
  SEC.set('session', QUESTION_EN_ATTENTE, q);                 // survit à un rechargement (session expirée)
  memoriseReglages();
  streamStats = null;
  effaceCarte(); debutApercu();
  $('result').hidden = false; setView('search');              // la carte ne disparaît plus
  startProgress();
  say('Question envoyée. Recherche dans les recommandations, puis sélection des sources, '
    + 'puis rédaction.');
  try {
    let res = USE_STREAM ? await askStream(q) : await askClassic(q);
    if (res.routeAbsente) res = await askClassic(q);          // serveur sans /api/ask/stream
    if (res.erreur) showFailure(res.erreur, res.detail);
    else {
      const code = STATUS[res.data.status] ? res.data.status : 'INCONNU';
      render(res.data);
      SEC.del('session', QUESTION_EN_ATTENTE);
      say(`Résultat prêt. ${res.data.source_only ? 'Passages retrouvés sans synthèse.' :
        STATUS[code][1]} ` +
        `${(res.data.sources || []).length} source(s) citée(s).`);
      remember(q, res.data.status);
    }
  } catch {
    showFailure('Le service local ne répond pas : la question n’a pas pu être transmise. '
      + 'Si le moteur démarrait, réessayez dans quelques secondes.');
  } finally {
    stopProgress();
    $('askBtn').disabled = false;
    lockModes(false);
    busy = false;
  }
}

/* ------------------------------------------------------------ presse-papier */
function answerText(withSources) {
  if (!current) return '';
  const lines = [`Question : ${current.question}`, `Statut : ${current.status}`, ''];
  (current.answer || []).forEach((c) => lines.push(`• ${c.text} [${(c.refs || []).join(', ')}]`));
  if (current.status === 'ABSTENTION' && current.reason) lines.push(`Raison : ${current.reason}`);
  (current.limitations || []).forEach((l) => lines.push(`- Limite : ${l}`));
  if (withSources) {
    lines.push('', 'Sources :');
    (current.sources || []).forEach((s) => lines.push(
      `${s.ref} ${s.document}, page ou diapositive ${s.page} (${s.passage_id})`));
  }
  return lines.join('\n');
}

async function copy(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');            // HTTP plain : pas de clipboard API
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btn) {
    const label = btn.textContent;
    btn.textContent = 'Copié';
    btn.classList.add('flash');
    setTimeout(() => { btn.textContent = label; btn.classList.remove('flash'); }, 1500);
  }
}

/* ------------------------------------------------------------ historique local */
function readHist() {
  try { return JSON.parse(localStorage.getItem(HIST) || '[]'); } catch { return []; }
}

function remember(question, status) {
  const list = readHist().filter((h) => h.question !== question);
  list.unshift({ question, status, ts: Date.now() });
  try { localStorage.setItem(HIST, JSON.stringify(list.slice(0, 8))); } catch { /* plein */ }
  renderHist();
}

function renderHist() {
  const list = readHist();
  $('history').hidden = !list.length;
  $('historyList').innerHTML = list.map((h, i) => `<li><button type="button" class="hist"
    data-i="${i}" data-status="${esc(h.status)}">${esc(h.question)}<span class="hist-when">${
    esc(new Date(h.ts).toLocaleString('fr-FR'))}</span></button></li>`).join('');
  document.querySelectorAll('.hist').forEach((b) => {
    b.onclick = () => { $('q').value = list[+b.dataset.i].question; $('q').focus(); countChars(); };
  });
}

/* ------------------------------------------------------------ saisie */
function countChars() {
  const n = $('q').value.length;
  $('qCount').textContent = `${n} / ${maxQ}`;
  $('qCount').classList.toggle('near', n > maxQ - 60);
}

document.querySelectorAll('input[name="mode"]').forEach(el => el.addEventListener('change', () => { updateMode(); memoriseReglages(); }));
updateMode();

$('askForm').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
$('q').addEventListener('input', countChars);

/* Téléphone : Entrée doit faire un saut de ligne, l'envoi est le bouton. Et pendant une
   composition clavier (accents, clavier predictif), AUCUNE touche n'envoie la question. */
const TACTILE = ((navigator.maxTouchPoints || 0) > 0) && !window.matchMedia('(pointer:fine)').matches;
let enComposition = false;
$('q').addEventListener('compositionstart', () => { enComposition = true; });
$('q').addEventListener('compositionend', () => { enComposition = false; });
$('q').setAttribute('enterkeyhint', TACTILE ? 'enter' : 'send');
$('q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || enComposition || e.isComposing) return;
  if (e.metaKey || e.ctrlKey || e.altKey) { e.preventDefault(); $('askForm').requestSubmit(); return; }
  if (e.shiftKey) return;                                 // saut de ligne voulu
  if (TACTILE) return;                                    // envoi par le bouton, pas par Entrée
  const v = e.target.value;
  if (!v.includes('\n') && v.trim()) { e.preventDefault(); $('askForm').requestSubmit(); }
});
document.querySelectorAll('.chip').forEach((c) => {
  c.onclick = () => { $('q').value = c.dataset.q; $('q').focus(); countChars(); };
});
$('copyAllBtn').onclick = (e) => copy(answerText(true), e.currentTarget);
$('clearHistory').onclick = () => { try { localStorage.removeItem(HIST); } catch { /* ignore */ }
  renderHist(); };
$('healthRefresh').onclick = () => { healthTries = 0; setPill('demarrage', 'vérification du service…'); checkHealth(); loadContract(); };

window.addEventListener('scroll', () => {
  if ($('answerCard').dataset.view === 'drafting') suitLeBas();
}, { passive: true });

function suitLeBas() {
  lecteurEnBas = (window.innerHeight + window.scrollY)
    >= (document.documentElement.scrollHeight - 80);
}

function appliqueReglages() {
  const p = SEC.get('local', PREFS, null);
  if (!p) return;
  const mode = p.mode && document.querySelector(`input[name="mode"][value="${CSS.escape(p.mode)}"]`);
  if (mode) mode.checked = true;
  // Options starts closed; the main controls stay visible above it.
  prefsMode = p.modelDefaultRevision === MODEL_DEFAULT_REVISION ? (p.model || null) : null;                            // appliqué à l'arrivée de /api/capabilities
  updateMode();
}

/* Les clés de session sont écrites en brut par le gate (proxy) : on les relit en brut. */
function cleSession(nom) {
  try { return sessionStorage.getItem(nom); } catch { return null; }
}

function resteSurVeille() {                 // la page est ouverte, mais pas encore authentifiée
  setPillAttente();
  renderHist();
  countChars();
  restaureQuestionEnAttente();                      // question d'avant la reconnexion, dès le gate
}

function restaureQuestionEnAttente() {
  const q = SEC.get('session', QUESTION_EN_ATTENTE, null);
  if (!q) return;
  $('q').value = q;
  countChars();
  notice('Votre question a été conservée après la reconnexion : rien n’a été envoyé sans vous.',
    'reconnexion');
}

function demarrerApresAuthentification() {
  $('error').hidden = true;                                // les erreurs d'avant-auth ne sont plus vraies
  setPill('demarrage', 'vérification du service…', '');
  restaureQuestionEnAttente();
  loadContract();
  checkHealth();
  if ($('q')) $('q').focus();
}

function initAppli() {
  appliqueReglages();
  renderHist();
  countChars();
  if (cleSession('a2med_test_unlocked') === '1' || !gate.isConnected) {
    loadContract();
    checkHealth();
  } else {
    resteSurVeille();
  }
  if (gate.isConnected) passwordInput.focus();
}
initAppli();

/* Contrat du service : modes, verdicts, et surtout la liste des génératrices QUI RÉPONDENT.
   Le sélecteur de modèle n'est plus écrit dans le HTML : un modèle qui ne répond pas ne peut
   pas être choisi (et aucun repli silencieux n'existe côté front). */
function renderModelOptions(gens, defaultKey = "qwen27b-shono") {
  const box = $('modelOptions');
  if (!box || !gens.length) return;
  modelLabels = {};
  gens.forEach(g => { modelLabels[g.key] = g.label; });
  const live = gens.filter(g => g.available && g.model_served !== false);
  const recommended = live.find(g => g.key === defaultKey)
    || live.find(g => g.key === 'qwen9b') || live.find(g => g.key === 'flash') || live[0];
  const pref = (live.find(g => g.key === prefsMode) || recommended || {}).key || '';
  const short = {flash:'Flash',qwen9b:'9B',qwen4b:'4B',qwen2b:'2B','qwen27b-shono':'27B · Shono'};
  box.innerHTML = gens.map(g => {
    const available = live.some(x => x.key === g.key);
    return `<label class="model-opt${available ? '' : ' off'}" title="${esc(g.label)}">
      <input type="radio" name="model" aria-label="${esc(g.label)}" value="${esc(g.key)}"
        ${g.key === pref ? 'checked' : ''} ${available ? '' : 'disabled'}>
      <span>${esc(short[g.key] || g.label)}</span></label>`;
  }).join('');
  $('modelPicker').hidden = live.length < 2;
  const target = gens.find(g => g.key === 'qwen27b-shono');
  const unavailable = target && !live.some(g => g.key === target.key);
  const name = modelLabels[pref] || 'aucun modèle disponible';
  repliNote = unavailable ? `27B indisponible — ${name} sélectionné` : '';
  const hint = $('modelHint');
  if (hint) { hint.textContent = repliNote; hint.hidden = !repliNote; }
  box.onchange = () => memoriseReglages();
  updatePresetLine();
}
// Ce que l'option repliee est en train de choisir, en clair.
function updatePresetLine() {
  const mode = selectedMode();
  const modeLabel = { standard: 'Réponse détaillée', courte: 'Réponse courte',
                     sources: 'Sources seules' }[mode] || mode;
  const model = selectedModel();
  const label = model ? (modelLabels[model] || model) : 'modèle en titre';
  const line = `${modeLabel} · ${label}${repliNote ? ` — ${repliNote}` : ''}`;
  const el = $('presetLine'); if (el) el.textContent = line;
  const sum = $('optionsSummary'); if (sum) sum.textContent = "Options";
}

async function loadContract() {
  const C = window.A2MEDContract;
  if (!C) return;
  const problem = C.apiBaseProblem(API_BASE);
  if (problem) { notice(problem, 'configuration'); return; }
  try {
    const r = await apiFetch('/api/capabilities');
    const text = await r.text();
    if (!r.ok) throw C.httpError(r, text);
    contratCharge = true;
    const payload = JSON.parse(text);
    renderModelOptions(C.apply(payload).generators || [], payload.default_generator_key);
  } catch (e) {
    // avant authentification, ce n'est pas une panne : la page n'a simplement pas le droit
    // d'interroger le service. Le dire évite la notice rouge mensongère sous le gate.
    if (gate.isConnected) return;
    notice('Contrat du service illisible : ' + e.message);
  }
}
loadContract();
