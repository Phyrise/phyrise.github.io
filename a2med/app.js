const API_BASE = String(window.A2MED_API_BASE || "").replace(/\/$/, "");
const apiFetch = (path, init = {}) => {
  const headers = new Headers(init.headers || {});
  // Session proxy par en-tête (mobile : cookies tiers cross-site bloqués) ; le cookie
  // continue de marcher en parallèle sur les navigateurs qui l'autorisent.
  const session = sessionStorage.getItem("a2med_proxy_session");
  if (session) headers.set("X-A2Med-Session", session);
  return fetch(API_BASE + path, { ...init, headers, credentials: "include" })
    .then(response => {
      // 401 alors qu'une session était posée = session morte (proxy redémarré,
      // token éphémère) → re-passer par le gate. 401 sans session = normal
      // (le gate est encore visible) : on ne reload pas.
      if (response.status === 401 && sessionStorage.getItem("a2med_test_unlocked") === "1") {
        sessionStorage.removeItem("a2med_proxy_session");
        sessionStorage.removeItem("a2med_test_unlocked");
        location.reload();
      }
      return response;
    });
};
const gate = document.getElementById("passwordGate");
const passwordForm = document.getElementById("passwordForm");
const passwordInput = document.getElementById("sitePassword");
const passwordError = document.getElementById("passwordError");
async function unlock() {
  passwordError.hidden = true;
  try {
    const response = await fetch(API_BASE + "/__auth", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      credentials: "include",
      body: JSON.stringify({password: passwordInput.value})
    });
    if (!response.ok) throw new Error("bad password");
    const payload = await response.json().catch(() => ({}));
    if (payload.session) sessionStorage.setItem("a2med_proxy_session", payload.session);
    sessionStorage.setItem("a2med_test_unlocked", "1");
    gate.remove();
  } catch {
    passwordError.hidden = false;
    passwordInput.select();
  }
}
if (sessionStorage.getItem("a2med_test_unlocked") === "1") gate.remove();
passwordForm.addEventListener("submit", event => { event.preventDefault(); unlock(); });
if (gate.isConnected) passwordInput.focus();

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
/* Le brouillon n’est JAMAIS une réponse : il est étiqueté, tenu à l’écart de la carte
   validée, et effacé quand la validation conclut à l’abstention ou échoue. */
const DRAFT = {
  redaction: ['Brouillon du générateur — rédaction en cours, AUCUNE vérification faite',
    'Texte brut, tel que le générateur l’écrit, avant le contrôle des citations et avant le '
    + 'statut final. Ne pas s’en appuyer dessus. La réponse médicale est la carte validée '
    + 'affichée à la fin.'],
  remplace: ['Brouillon terminé — remplacé par la réponse validée ci-dessous',
    'Le texte ci-dessous est le brouillon brut ; seules les affirmations de la carte validée '
    + 'ont passé le contrôle des citations.'],
  ecarte: ['Brouillon ÉCARTÉ par la validation — à ne pas lire comme réponse',
    'Le contrôle a conclu à une abstention (ou a échoué) : rien de ce brouillon ne vaut '
    + 'réponse, il n’est donc pas conservé à l’écran.'],
};
const STREAM_NOTE = 'Rédaction de la réponse en cours… <span id="elapsed"></span>';
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
let streamStats = null, resultWas = null;
let healthTimer = null, healthTries = 0;

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
    if (!r.ok) throw new Error(String(r.status));
    maxQ = (h.limits && h.limits.question_chars) || MAXQ_DEFAULT;
    modelOptions = h.model_options || {};
    $("modelPicker").hidden = Object.keys(modelOptions).length < 2;
    $('q').maxLength = maxQ;
    countChars();
    const gen = h.generator || {}, gpu = h.gpu0 || {};
    const detail = [`gpu0 ${gpu.mem_used_mib ?? '?'} MiB`, `${h.n_pool ?? '?'} passages retenus`,
      `génératrice ${gen.ok ? 'ok' : 'indisponible'}`,
      h.corpus_fingerprint ? `empreinte ${String(h.corpus_fingerprint).slice(0, 8)}` : '']
      .filter(Boolean).join(' · ');
    $('fingerprint').textContent = h.corpus_fingerprint
      ? `Corpus SPILF · août 2026 · ${String(h.corpus_fingerprint).slice(0, 12)}`
      : 'Corpus SPILF · août 2026';
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
    setPill('pret', 'Serveur Sparka', detail);
  } catch {
    setPill('indisponible', 'Service indisponible',
      'La page n’a pas pu joindre le service local (port 8050).');
  }
}

function pollHealth() {                                   // léger, seulement pendant boot
  clearTimeout(healthTimer);
  if (healthTries++ > 40) return;
  healthTimer = setTimeout(checkHealth, 4000);
}

/* ------------------------------------------------------------ rendu réponse */
function chips(refs) {
  return (refs && refs.length)
    ? `<span class="refs">${refs.map((r) => `<span class="ref-chip">${esc(r)}</span>`).join('')}</span>`
    : '';
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

function renderAnswer(data) {
  const total = data.timings && Number.isFinite(data.timings.t_total_s)
    ? ` · ${data.timings.t_total_s.toFixed(1)} s` : '';
  if (data.source_only) {
    $('answerCard').dataset.status = 'SOURCES_ONLY';
    $('statusCode').textContent = 'SOURCES';
    $('statusMeaning').textContent = corpusLabel(data);
    $('answerTime').textContent = `Recherche${total}`;
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
  $('statusMeaning').textContent = corpusLabel(data);
  $('answerTime').textContent = `Réponse${total}`;
  renderProvisional(data);

  const claims = data.answer || [];
  if (code === 'ABSTENTION' || !claims.length) {
    // Une abstention n'est jamais une erreur, et n'est jamais une fausse réponse :
    // aucun claim n'est listé, même si le moteur en a produit.
    $('answer').innerHTML = `<p class="abstain-reason">${esc(data.reason ||
      'Les passages récupérés ne permettent pas une réponse sûre avec le corpus local.')}</p>`;
  } else {
    $('answer').innerHTML = `<ol class="claims">${claims.map((c) => `<li>${rich(c.text)}${chips(c.refs)}${
      c.citation_valid === false ? '<span class="unresolved">citation non résolue</span>' : ''
    }</li>`).join('')}</ol>`;
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

function sourceType(name) {
  const m = String(name || '').match(/\.(pptx|pdf|docx?|odp|key)$/i);
  return m ? m[1].toUpperCase().replace('PPTX', 'PPT') : 'Document';
}

function renderSources(data) {
  const src = data.sources || [];
  $('sourcesNote').hidden = !data.source_only || !src.length;
  const times = data.timings || {};
  const measured = [];
  if (Number.isFinite(times.retrieval_s)) measured.push(`Recherche : ${times.retrieval_s.toFixed(2)} s`);
  if (!data.source_only && Number.isFinite(times.generation_s)) measured.push(`Rédaction : ${times.generation_s.toFixed(1)} s`);
  $('resultTiming').textContent = measured.join(' · ');
  $('resultTiming').hidden = !measured.length;
  $('sourcesPanel').hidden = !src.length;
  $('sourcesTitle').textContent = data.source_only
    ? `Passages retrouvés — sans synthèse (${src.length})`
    : `Sources citées (${src.length})`;
  $('sources').innerHTML = src.map((s, index) => {
    const ex = String(s.excerpt ?? '');
    const prov = s.source_status === 'prepublication_recommendation'
      ? `<span class="badge-prov">Provisoire${s.event ? ` (${esc(s.event)})` : ''}</span>` : '';
    const auth = (s.societies && s.societies.length ? s.societies : [s.source_authority || 'SPILF'])
      .map((a) => `<span>${esc(a)}</span>`).join('');
    return `<article class="source${prov ? ' is-provisional' : ''}">
      <h3 class="src-title"><span class="ref">${esc(s.ref)}</span> ${esc(humanDoc(s.document))}</h3>
      <p class="src-meta">${prov}${auth}<span>${esc(sourceYear(s.document))}</span>
        <span>${esc(sourceType(s.document))}</span><span>Page/diapositive ${esc(s.page)}</span>
        ${data.source_only ? `<span>Rang ${index + 1}/${src.length}</span>` : ''}</p>
      <p class="excerpt">${rich(ex)}</p>
      <details class="source-tech"><summary>Identifiant technique</summary>
        <p class="fine mono">${esc(s.passage_id)}${data.source_only && Number.isFinite(s.rerank_score)
          ? ` · score ${esc(s.rerank_score.toFixed(3))}` : ''}</p></details>
      </article>`;
  }).join('');
}

function renderTech(data) {
  const t = data.timings || {}, q = data.technique || {}, s = (q.sampling || {});
  const row = (k, v) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
  const st = streamStats;
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
  current = data;
  $('error').hidden = true;
  $('result').hidden = false;
  renderAnswer(data);
  renderSources(data);
  renderTech(data);
  if (data.source_only && $('synthBtn')) $('synthBtn').onclick = synthesizeSources;
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
  return document.querySelector('input[name="model"]:checked')?.value || null;
}

function updateMode() {
  const mode = selectedMode();
  $('modeHint').textContent = '';
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

/* ------------------------------------------------------------ brouillon (non vérifié) */
function setDraftState(state) {
  const d = $('draft');
  d.dataset.state = state;
  d.open = state === 'redaction';
  $('draftLabel').textContent = DRAFT[state][0];
  $('draftWarn').textContent = DRAFT[state][1];
  if (state === 'ecarte') $('draftText').textContent = '';   // une abstention ne se lit pas
}

function draftDelta(text) {
  if (!USE_STREAM) return;
  if ($('draft').hidden) {                       // un brouillon ne doit pas voisiner une réponse
    resultWas = $('result').hidden;              // valide : on la remmettra telle quelle
    $('result').hidden = true;
    setDraftState('redaction');
  }
  $('draft').hidden = false;
  const pre = $('draftText');
  pre.textContent += text;                                   // textContent : rien d’injectable
  pre.scrollTop = pre.scrollHeight;
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
    let data = {};
    try { data = await r.json(); } catch { /* réponse vide */ }
    if (r.status === 404) return { routeAbsente: true };
    return { erreur: data.error || `Le service a répondu ${r.status} sans message.`,
      detail: data.detail || (data.code ? `code ${data.code}` : '') };
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
      draftDelta(data.text);
    } else if (ev === 'validation') {
      if (data.stage === 'generation_terminee') setStep(3);  // le contrôle, pour de vrai
      else streamStats = data.stream_stats || null;          // TTFT mesuré côté moteur
    } else if (ev === 'done') {
      out = data;
      return true; // validated result is complete; do not wait for SSE close
    } else if (ev === 'error') {
      erreur = { message: data.error, detail: data.detail || (data.code ? `code ${data.code}` : '') };
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
  let data = {};
  try { data = await r.json(); } catch { /* réponse vide : on garde le message générique */ }
  if (!r.ok) {
    return { erreur: data.error || `Le service a répondu ${r.status} sans message.`,
      detail: data.detail || (data.code ? `code ${data.code}` : '') };
  }
  return { ok: true, data };
}

/* Une panne = un seul chemin d'affichage, le même quel que soit l'envoyeur (flux, route
   JSON, réseau coupé) : message français, brouillon écarté, réponse précédente rendue. */
function showFailure(message, detail) {
  notice(message, detail || '');
  setDraftState('ecarte');                                 // rien de brut ne reste visible
  $('draft').hidden = true;
  if (resultWas !== null) $('result').hidden = resultWas;   // la réponse d'avant revient
  checkHealth();
}

/* ------------------------------------------------------------ question */
function finishDraft() {
  $('draftText').textContent = '';
  $('draft').hidden = true;
}

async function synthesizeSources() {
  if (busy || !current || !current.source_token) return;
  const question = current.question, token = current.source_token;
  busy = true;
  lockModes(true);
  $('askBtn').disabled = true;
  lockModes(true);
  $('error').hidden = true;
  finishDraft();
  streamStats = null;
  resultWas = null;
  startProgress('standard', true);
  say('Synthèse des passages conservés en cours.');
  try {
    let res = USE_STREAM ? await askStream(question, 'standard', token) : await askClassic(question, 'standard', token);
    if (res.routeAbsente) res = await askClassic(question, 'standard', token);
    if (res.erreur) showFailure(res.erreur, res.detail);
    else {
      finishDraft();
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
  $('draft').hidden = true;                                  // la réponse déjà affichée
  $('draftText').textContent = '';
  streamStats = null;
  resultWas = null;
  startProgress();
  say('Question envoyée. Recherche dans les recommandations, puis sélection des sources, '
    + 'puis rédaction.');
  try {
    let res = USE_STREAM ? await askStream(q) : await askClassic(q);
    if (res.routeAbsente) res = await askClassic(q);          // serveur sans /api/ask/stream
    if (res.erreur) showFailure(res.erreur, res.detail);
    else {
      const code = STATUS[res.data.status] ? res.data.status : 'INCONNU';
      finishDraft();
      render(res.data);
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

document.querySelectorAll('input[name="mode"]').forEach(el => el.addEventListener('change', updateMode));
updateMode();

$('askForm').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
$('q').addEventListener('input', countChars);
$('q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.metaKey || e.ctrlKey || e.altKey) { e.preventDefault(); ask(); return; }
  if (e.shiftKey) return;                                 // saut de ligne voulu
  const v = e.target.value;
  if (!v.includes('\n') && v.trim()) { e.preventDefault(); ask(); }
});
document.querySelectorAll('.chip').forEach((c) => {
  c.onclick = () => { $('q').value = c.dataset.q; $('q').focus(); countChars(); };
});
$('copyAllBtn').onclick = (e) => copy(answerText(true), e.currentTarget);
$('clearHistory').onclick = () => { try { localStorage.removeItem(HIST); } catch { /* ignore */ }
  renderHist(); };
$('healthRefresh').onclick = () => { healthTries = 0; checkHealth(); };

renderHist();
countChars();
checkHealth();
