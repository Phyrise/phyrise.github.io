/* A²-Med — plateforme d'évaluation (/eval) et laboratoire de retrieval.
   Zone de mesure : aucun usage clinique. Aucun framework, aucun CDN, aucune dépendance.
   Règles tenues ici :
     * tout ce qui vient du serveur ou d'un fichier importé est ÉCHAPPÉ avant insertion ;
     * jamais de raisonnement interne du modèle : seulement la réponse validée, les sources
       du registre et la trace de retrieval (qui n'est pas du raisonnement modèle) ;
     * le scoring s'enregistre à chaque action (POST immédiat, debounce court sur la note) et
       se reprend après fermeture : la source de vérité est le serveur, pas cette page ;
     * les identités des panneaux comparés restent masquées tant que le scoring n'est pas fait. */
"use strict";

const API_BASE = String(document.body.dataset.api || window.A2MED_API_BASE || "").replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rich = (s) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
const fmt = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "—");
const LS = { labels: "a2med_eval_labels_v1", last: "a2med_eval_last_session_v1",
             free: "a2med_free_session_v1", freeBench: "a2med_free_last_question_v1",
             ux: "a2med_eval_ux_v1" };
const STATUS_LABELS = {
  ANSWER: ["Réponse", "fondée sur les sources locales"],
  CONDITIONAL_ANSWER: ["Réponse conditionnelle", "partielle ou à conditions — lire les limites"],
  ABSTENTION: ["ABSTENTION", "le système ne répond pas avec les preuves locales"],
  SOURCES_ONLY: ["Recherche documentaire", "aucune réponse générée"],
  INCONNU: ["statut non reconnu", "rien n'affiché faute de statut lisible"],
};
// Libellés français des codes d'erreur (les CODES restent la clé stable des agrégats).

const STATE = {
  health: null, benchmarks: [], benchmarksByName: {}, generators: [], taxonomy: [],
  session: null, progress: {}, runs: {}, panels: {}, questions: [], view: [], index: -1,
  current: null, busy: false,
};

async function api(path, options = {}) {
  // Session proxy par en-tête (mobile : cookies tiers cross-site bloqués) ; le cookie
  // continue de marcher en parallèle sur les navigateurs qui l'autorisent.
  const session = sessionStorage.getItem("a2med_proxy_session");
  const headers = options.body ? { "Content-Type": "application/json" } : {};
  if (session) headers["X-A2Med-Session"] = session;
  let response;
  try {
    response = await fetch(API_BASE + path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "include",
    });
  } catch (e) {                      // tunnel éteint, DNS mort, base mal publiée : nommé, pas brut
    throw window.A2MEDContract.networkError(API_BASE, e);
  }
  if (response.status === 401) {
    // La page eval n'a pas de gate : 401 (visite froide ou session morte)
    // → retour à la page principale où le gate redemande le mot de passe.
    sessionStorage.removeItem("a2med_proxy_session");
    location.href = "./";
  }
  const text = await response.text();
  // Une erreur backend reste exploitable : « API 401 — session expirée », « API 503 — générateur
  // indisponible », « JSON invalide — HTTP 502, reçu text/html ». Jamais un message fourre-tout.
  if (!response.ok) throw window.A2MEDContract.httpError(response, text, STATE && STATE.lastTrace);
  let data = null;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw window.A2MEDContract.httpError(response, text, STATE && STATE.lastTrace); }
  if (data && data.trace_id) STATE.lastTrace = data.trace_id;   // la prochaine erreur le citera
  return data;
}

function notice(id, message, kind) {
  const box = $(id);
  if (!box) return;
  box.hidden = !message;
  box.textContent = message || "";
  box.dataset.kind = kind || "info";
}

function say(message) { $("live").textContent = message || ""; }

/* Les deux niveaux de lecture (mission clinician-ux §2) : « medecin » = question, reponse,
   sources, decision ; « lab » = tout le reste. Un seul mecanisme : body[data-ux] + la classe
   .lab-only. Rien n'est supprime du DOM — les elements techniques sont seulement masques. */
function setUx(mode) {
  STATE.ux = mode;
  document.body.dataset.ux = mode;
  const b = $("uxToggle");
  if (b) b.textContent = mode === "lab" ? "◂ Retour au mode médecin" : "Ouvrir le Lab ▸";
  localStorage.setItem(LS.ux, mode);
}

// Le meme appel /api/ask couvre retrieval puis generation : la page ne peut pas connaitre la
// phase, elle ne fait qu'une supposition honnete sur les latences mesurees de cette machine.
function stage(boxId, text) {
  const box = $(boxId);
  if (box) { box.hidden = !text; box.textContent = text || ""; }
}
function stageFlow(boxId) {
  stage(boxId, "Recherche des passages…");
  return window.setTimeout(() => stage(boxId, "Génération de la réponse (10-20 s)…"), 2500);
}
function stageEnd(boxId, timer) {
  window.clearTimeout(timer);
  stage(boxId, "");
}

function setBusy(busy, label) {
  STATE.busy = busy;
  document.body.classList.toggle("busy", !!busy);
  document.querySelectorAll("button.btn").forEach((b) => { b.disabled = busy; });
  if (label) say(label);
}

/* ------------------------------------------------------------------ santé + en-tête */
async function loadHealth() {
  try {
    STATE.health = await api("/api/health");
  } catch (e) {
    STATE.health = { state: "indisponible", error: String(e.message) };
  }
  const h = STATE.health;
  const pill = $("health");
  const states = { pret: ["ok", "service local prêt"], demarrage: ["wait", "moteur en démarrage (~15 s)"],
                   indisponible: ["off", "moteur arrêté — aucune question possible"] };
  const [state, text] = states[h.state] || ["off", "état inconnu"];
  pill.dataset.state = state;
  $("healthText").textContent = text;
  return h;
}

function sessionHead() {
  const s = STATE.session, head = $("sessionHead");  if (!s) { head.hidden = true; $("footSession").textContent = "aucune session chargée"; return; }
  const h = STATE.health || {};
  head.hidden = false;
  const fp = h.corpus_fingerprint || "";
  const mismatch = s.corpus_fingerprint_at_creation && fp &&
    s.corpus_fingerprint_at_creation !== fp;
  $("fingerprintWarn").hidden = !mismatch;
  $("fingerprintWarn").innerHTML = mismatch
    ? `<strong>Fingerprint du corpus différent.</strong> La session a été créée sur
       <code>${esc(String(s.corpus_fingerprint_at_creation).slice(0, 12))}…</code> ; le service
       sert <code>${esc(String(fp).slice(0, 12))}…</code>. Les runs ne sont plus comparables :
       vérifiez <code>A2MED_REGISTRY_DIR</code> avant de scorer.`
    : "";
  head.innerHTML = [
    ["session", esc(s.label || s.name)],
    ["jeu", `${esc(s.benchmark)} · ${esc(String(s.benchmark_sha256 || "").slice(0, 16))}…`],
    ["mode", esc(s.mode)],
    ["HEAD git", `<code>${esc(h.git_head || s.git_head_at_creation || "—")}</code>`],
    ["fingerprint corpus", `<code>${esc(String(fp).slice(0, 16) || "—")}…</code>`],
    ["retrieval", `<code>${esc(s.retrieval_config_id || "—")}</code>`],
    ["recherche de la session", esc(`${s.retrieval_profile || "hybrid"} · ${s.context_k || 5} passages`)],
    ["générateur", esc(($("runModel").selectedOptions[0] || {}).textContent || "—")],
    ["horodatage", esc(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC")],
  ].map(([k, v]) => `<p class="kv"><span>${k}</span>${v}</p>`).join("");
  $("footSession").innerHTML = `${esc(s.name)} · jeu ${esc(String(s.benchmark_sha256 || "").slice(0, 12))}…`
    + ` · HEAD <code>${esc(h.git_head || "—")}</code> · corpus <code>${esc(String(fp).slice(0, 12))}…</code>`
    + ` · ${esc(s.retrieval_config_id || "")}`;
  $("sessionRename").disabled = $("sessionReset").disabled = false;
  const cfg = $("sessionConfig");
  if (cfg) cfg.textContent = `${s.retrieval_profile || "hybrid"} · ${s.context_k || 5} passages`
    + (s.eval_kind === "free" ? " · questions libres" : " · benchmark");
  renderRunConfig();
}

/* Le couple mode + modele d'une session se choisit a sa creation et ne bouge plus (mission
   clinician-ux §12) : la page l'affiche en clair, non modifiable. Une session heritee (avant
   cette regle, sans `generator_key`) garde ses selecteurs actifs — on ne durcit pas le passe. */
function renderRunConfig() {
  const s = STATE.session || {}, frozen = !!s.generator_key;
  const mode = $("runMode"), model = $("runModel");
  if (mode && s.mode) mode.value = s.mode;
  if (model && s.generator_key) model.value = s.generator_key;
  if (mode) mode.disabled = frozen;
  if (model) model.disabled = frozen;
  const gen = (STATE.generators.find((g) => g.key === (s.generator_key || (model || {}).value)) || {});
  const pill = $("runFrozenConfig");
  if (pill) {
    const choisi = frozen ? (gen.label || s.generator_key) : ((model || {}).value ? (gen.label || model.value) : "modèle à choisir dans Lab");
    pill.textContent = `${window.A2MEDContract.modeLabel((s.mode || (mode || {}).value || "courte"))}`
      + ` · ${choisi}` + (frozen ? " · figé à la création de la session" : "")
      + (STATE.genNote ? ` — ${STATE.genNote}` : "");
    pill.hidden = !s.name;
  }
  const box = $("freeFrozenConfig");
  if (box) {
    const fgen = (STATE.generators.find((g) => g.key === $("freeModel").value) || {});
    box.textContent = `${window.A2MEDContract.modeLabel($("freeMode").value)}`
      + ` · ${fgen.label || $("freeModel").value || "modèle par défaut"}`
      + (STATE.genNote ? ` — ${STATE.genNote}` : "");
  }
}

/* ------------------------------------------------------------------ jeux */
async function loadBenchmarks() {
  const data = await api("/api/eval/benchmarks");
  STATE.benchmarks = data.benchmarks || [];
  STATE.benchmarksByName = {};
  const select = $("benchSelect");
  select.innerHTML = "";
  const combined = document.createElement("option");
  combined.value = "__combine__";
  combined.textContent = "combiné 60Q + 15 V62 (vue)";
  select.appendChild(combined);
  for (const b of STATE.benchmarks) {
    STATE.benchmarksByName[b.name] = b;
    const opt = document.createElement("option");
    opt.value = b.name;
    opt.textContent = b.error ? `${b.name} (illisible : ${b.error})`
      : `${b.name} — ${b.n_questions} questions`;
    select.appendChild(opt);
  }
  select.value = localStorage.getItem("a2med_eval_bench") || "__combine__";
  if (!select.value) select.value = "__combine__";
  onBenchmarkChange();
}

function selectedQuestions() {
  const name = $("benchSelect").value;
  if (name === "__combine__") {
    const seen = {}, out = [];
    for (const b of STATE.benchmarks) {
      for (const q of (b.questions || [])) {
        if (seen[q.id]) continue;
        seen[q.id] = 1;
        out.push({ ...q, benchmark: b.name });
      }
    }
    return out;
  }
  const b = STATE.benchmarksByName[name];
  return (b && b.questions || []).map((q) => ({ ...q, benchmark: name }));
}

function onBenchmarkChange() {
  const name = $("benchSelect").value;
  localStorage.setItem("a2med_eval_bench", name);
  const qs = selectedQuestions();
  STATE.questions = qs;
  const sha = name === "__combine__"
    ? STATE.benchmarks.map((b) => `${b.name}@${String(b.sha256).slice(0, 8)}`).join(" + ")
    : (STATE.benchmarksByName[name] || {}).sha256 || "—";
  // 16 caractères + ellipse : le SHA complet ne sert ici qu'à identifier le jeu
  // (le verrou est par SHA complet côté session), une chaîne mono de 64 caractères
  // cassait la mise en page à 360–430 px.
  $("benchSha").textContent = `SHA : ${String(sha).slice(0, 16)}…`;
  $("benchCount").textContent = `${qs.length} questions`;
  if (STATE.session && STATE.session.benchmark !== name) {
    notice("sessionNotice", `La session est figée sur le jeu « ${STATE.session.benchmark} » `
      + `(SHA verrouillé). Créez une autre session pour scorer un autre jeu.`, "warn");
  }
  renderQuestionList();
}

/* ------------------------------------------------------------------ sessions */
async function loadSessions() {
  const data = await api("/api/eval/sessions");
  const select = $("sessionSelect");
  const previous = select.value;
  select.innerHTML = '<option value="">— choisir —</option>';
  for (const s of data.sessions) {
    const opt = document.createElement("option");
    opt.value = s.name;
    const p = s.progress || {};
    opt.textContent = `${s.label || s.name} (${p.n_items_scored || 0}/${p.n_items_done || 0} notés)`
      + ` · ${s.benchmark}`;
    select.appendChild(opt);
  }
  select.value = previous || localStorage.getItem(LS.last) || "";
}

async function createSession() {
  const name = $("newSessionName").value.trim();
  if (!name) return notice("sessionNotice", "Donnez un nom de session (lettres, chiffres, . _ -).", "error");
  const benchmark = $("benchSelect").value;
  if (benchmark === "__combine__") {
    return notice("sessionNotice", "Le combiné est une vue de consultation : une session se fige "
      + "sur UN fichier (SHA verrouillé). Choisissez 60q-historique ou v62-cible-15.", "warn");
  }
  const b = STATE.benchmarksByName[benchmark];
  if (!b) return notice("sessionNotice", "Jeu introuvable.", "error");
  try {
    STATE.session = await api("/api/eval/session", { method: "POST", body: {
      name, benchmark, benchmark_sha256: b.sha256, mode: $("newSessionMode").value, label: name,
      generator_key: $("newSessionModel").value || null,
      // Le benchmark gelé se joue TOUJOURS sur la recherche de production (hybride · 5),
      // figée à la création : les profils expérimentaux ne peuvent plus entrer dans une
      // session de benchmark par inadvertance (mission real-world §0/§3).
      retrieval_profile: "hybrid", context_k: 5 } });
    $("newSessionName").value = "";
    localStorage.setItem(LS.last, name);
    notice("sessionNotice", "", "info");
    await loadSessions();
    $("sessionSelect").value = name;
    await resumeSession(name);
  } catch (e) { notice("sessionNotice", e.message, "error"); }
}

async function resumeSession(name) {
  name = name || $("sessionSelect").value;
  if (!name) return notice("sessionNotice", "Choisissez une session à reprendre.", "warn");
  try {
    const data = await api(`/api/eval/session/${encodeURIComponent(name)}`);
    STATE.session = data.session;
    STATE.progress = data.progress.items || {};
    STATE.runs = {}; STATE.panels = {};
    for (const r of data.runs || []) STATE.runs[r.benchmark_id] = r;
    for (const p of data.panels || []) STATE.panels[`${p.benchmark_id}|${p.panel_key}`] = p;
    STATE.taxonomy = data.taxonomy || STATE.taxonomy;
    localStorage.setItem(LS.last, name);
    if (!data.benchmark_ok) {
      notice("sessionNotice", "Le fichier du jeu ne correspond plus au SHA verrouillé à la création : "
        + "les écritures sont bloquées par le serveur.", "error");
    } else notice("sessionNotice", "", "info");
    const select = $("benchSelect");
    if (STATE.benchmarksByName[data.session.benchmark]) select.value = data.session.benchmark;
    renderCodes();
    renderQuestionList();
    sessionHead();
    say(`Session ${name} reprise : ${data.progress.n_items_scored || 0} questions notées.`);
  } catch (e) { notice("sessionNotice", e.message, "error"); }
}

async function renameSession() {
  if (!STATE.session) return;
  const name = window.prompt("Nouveau nom de session", STATE.session.name);
  if (!name) return;
  try {
    await api(`/api/eval/session/${encodeURIComponent(STATE.session.name)}/rename`,
      { method: "POST", body: { name } });
    await loadSessions();
    $("sessionSelect").value = name;
    await resumeSession(name);
  } catch (e) { notice("sessionNotice", e.message, "error"); }
}

async function resetSession() {
  if (!STATE.session) return;
  if (!window.confirm("Effacer toutes les réponses (verdicts, notes, runs) de cette session ? "
    + "La configuration reste. Action irréversible.")) return;
  try {
    await api(`/api/eval/session/${encodeURIComponent(STATE.session.name)}/reset`, { method: "POST", body: {} });
    await resumeSession(STATE.session.name);
  } catch (e) { notice("sessionNotice", e.message, "error"); }
}

/* ------------------------------------------------------------------ liste + filtres */
function verdictOf(id) { return (STATE.progress[id] || {}).verdict || null; }
function doneOf(id) { return !!(STATE.progress[id] || {}).done; }
function codesOf(id) {
  const row = STATE.runs[id];
  return (row && row.codes) || [];
}

function renderQuestionList() {
  const filter = $("filterState").value, code = $("filterCode").value;
  STATE.view = STATE.questions.filter((q) => {
    if (filter === "todo" && doneOf(q.id)) return false;
    if (filter === "done" && !doneOf(q.id)) return false;
    if (code && !codesOf(q.id).includes(code)) return false;
    return true;
  });
  const select = $("questionSelect");
  select.innerHTML = "";
  for (const q of STATE.view) {
    const opt = document.createElement("option");
    opt.value = q.id;
    const mark = verdictOf(q.id) ? "✓" : doneOf(q.id) ? "·" : " ";
    opt.textContent = `${mark} ${q.id} — ${q.question.slice(0, 90)}`;
    select.appendChild(opt);
  }
  const done = STATE.questions.filter((q) => doneOf(q.id)).length;
  const scored = STATE.questions.filter((q) => verdictOf(q.id)).length;
  $("progressCount").textContent = `${scored}/${STATE.questions.length} notées · ${done} avec run`
    + ` · vue ${STATE.view.length}`;
  const codes = new Set();
  Object.values(STATE.runs).forEach((r) => (r.codes || []).forEach((c) => codes.add(c)));
  const filterCode = $("filterCode");
  const keep = filterCode.value;
  filterCode.innerHTML = '<option value="">sans filtre de motif</option>'
    + [...codes].sort().map((c) => `<option value="${esc(c)}">`
      + `${esc(window.A2MEDContract.taxLabel(c))}</option>`).join("");
  filterCode.value = codes.has(keep) ? keep : "";
  if (STATE.current) select.value = STATE.current.id;
}

function selectQuestion(id) {
  const q = STATE.questions.find((x) => x.id === id);
  if (!q) return;
  STATE.current = q;
  $("questionText").textContent = q.question;
  $("questionMeta").innerHTML = [
    `ID <code>${esc(q.id)}</code>`,
    q.category ? `catégorie ${esc(q.category)}` : null,
    q.difficulty ? `difficulté ${esc(q.difficulty)}` : null,
    q.provenance ? `provenance ${esc(q.provenance)}` : null,
  ].filter(Boolean).join(" · ");
  $("scoring").hidden = !STATE.session;
  loadScoreForm();
  const run = STATE.runs[q.id];
  if (run) renderRunResult(runOutFromRow(run), { restored: true });
  say(`${q.id} — ${q.question}`);
}

function move(delta) {
  if (!STATE.view.length) return;
  const ids = STATE.view.map((q) => q.id);
  let i = STATE.current ? ids.indexOf(STATE.current.id) : -1;
  i = Math.max(0, Math.min(ids.length - 1, i + delta));
  $("questionSelect").value = ids[i];
  selectQuestion(ids[i]);
}

/* ------------------------------------------------------------------ run produit */
async function runQuestion() {
  if (!STATE.current) return notice("runNotice", "Sélectionnez une question du jeu.", "warn");
  if (!STATE.session) return notice("runNotice", "Créez ou reprenez une session avant de lancer un run.", "warn");
  const s = STATE.session || {};
  //Jamais de mode vide sur le fil : sans session, le benchmark se joue en « standard ».
  const mode = $("runMode").value || s.mode || "standard";
  const body = { question: STATE.current.question, mode,
                 eval_kind: "benchmark",
                 retrieval_profile: s.retrieval_profile || "hybrid",
                 context_k: s.context_k || 5 };
  const model = $("runModel").value;
  if (model) body.model = model;
  setBusy(true, "calcul en cours");
  notice("runNotice", "", "info");
  $("runCard").hidden = true;
  try {
    const out = await api("/api/ask", { method: "POST", body });
    renderRunResult(out);
    if (STATE.session) await saveRun(out);
  } catch (e) {
    notice("runNotice", e.message + (e.body && e.body.detail ? ` — ${e.body.detail}` : ""), "error");
  } finally { setBusy(false); }
}

function answerHtml(answer) {
  if (!answer || !answer.length) return "";
  return `<ol class="claims">` + answer.map((a) => `<li>${rich(a.text)}`
    + ` <span class="refs">${(a.refs || []).map((r) => `<span class="ref">${esc(r)}</span>`).join("")}</span>`
    + (a.citation_valid ? "" : ' <span class="badge bad">citation non validée</span>') + `</li>`).join("")
    + `</ol>`;
}

function sourcesHtml(sources, note) {
  if (!sources || !sources.length) return "";
  // Une source = une ligne, depliable (mission clinician-ux §8) : doc, page, statut, et le texte
  // du registre seulement quand on ouvre. Replie = rien ne coute, aucun appel.
  return `<details class="sources"><summary>${sources.length} source${sources.length > 1 ? "s" : ""}`
    + ` <span class="fine">${esc(note || "")}</span></summary>` + sources.map((s) => {
      const prov = s.source_status === "prepublication_recommendation";
      return `<details class="source-row"><summary><strong>${esc(s.ref || "")}</strong>`
        + ` ${esc(s.document || "")} <span class="mono">p. ${esc(s.page ?? "—")}</span>`
        + ` <span class="badge ${prov ? "warn" : "ok"}">${prov ? "pré-publication" : "publié final"}</span>`
        + `</summary><p class="excerpt">${rich(s.excerpt)}</p>`
        + `<p class="fine">${esc((s.societies || [s.source_authority]).join("/"))}</p>`
        + `<p class="fine mono">${esc(s.passage_id || "")}`
        + `${s.rerank_score != null ? ` · rerank ${fmt(s.rerank_score, 4)}` : ""}</p></details>`;
    }).join("") + `</details>`;
}

function techHtml(out) {
  const t = out.technique || {}, ti = out.timings || {};
  const rows = [
    ["statut", esc(out.status || (out.source_only ? "SOURCES_ONLY" : "—"))],
    ["statut demandé par le modèle", esc(out.status_requested || "—")],
    ["n_claims", t.n_claims], ["toutes citations valides", String(t.claims_all_valid)],
    ["passages dans le contexte", (t.top5_pids || []).length],
    ["trace", `<code>${esc(out.trace_id || "—")}</code>`],
    ["passage_ids du contexte", `<code>${esc((t.top5_pids || []).join(" "))}</code>`],
    ["passages corpus / pool actif", `${t.n_passages ?? "—"} / ${t.n_pool ?? "—"}`],
    ["modalités citant un passage hors contexte",
     (out.answer || []).filter((a) => a.citation_valid && !(a.refs || []).length).length],
    ["latence retrieval", fmt(ti.retrieval_s) + " s"],
    ["latence génération", fmt(ti.generation_s) + " s"],
    ["total ressenti", fmt(ti.t_total_s) + " s"],
    ["modèle", esc(t.gen_model || "—")],
    ["générateur", esc(t.gen_url || "—")],
    ["échantillonnage", `<code>${esc(JSON.stringify(t.sampling || {}))}</code>`],
    ["SHA prompt de génération", `<code>${esc(String(t.generation_prompt_sha256 || "").slice(0, 16))}…</code>`],
    ["worker GPU", t.worker && t.worker.down ? "INDISPONIBLE" : "ok"],
  ];
  const passages = (out.sources || []).length
    ? "" : `<p class="fine">Aucun passage source n'est exposé par cette réponse : le mode sources
            n'a pas été utilisé et les sources citées sont affichées ci-dessus.</p>`;
  return `<table class="kv-table"><tbody>` + rows.map(([k, v]) =>
    `<tr><th>${k}</th><td>${v ?? "—"}</td></tr>`).join("") + `</tbody></table>` + passages;
}

/* Panneau d'inspection scientifique. Il est sous la reponse, replie, et ne declenche AUCUN appel
   (mission clinician-ux §8/§13) : tout est lu de la decharge deja recue du run. Ce n'est pas une
   chaine de pensee : le pipeline tourne thinking OFF, il n'en produit pas. */
function inspectionHtml(out) {
  const lin = out.lineage || {}, raw = out.raw_generator_output || [], val = out.validated_output || [];
  const n = (v) => (v === null || v === undefined || v === "" ? "—" : esc(String(v)));
  const fused = (lin.fused_top50 || []).map((r) => `<tr>
      <td class="mono">${esc(r.pid)}</td><td>${n(r.bm25_rank)}</td><td>${n(r.dense_rank)}</td>
      <td>${n(r.rrf_rank)}</td><td>${n(r.rerank_rank)}</td>
      <td>${esc(r.doc || "")}</td><td>${n(r.page)}</td></tr>`).join("");
  const final = (lin.final || []).map((r) => `<tr>
      <td><strong>${esc(r.alias || "")}</strong></td><td class="mono">${esc(r.pid || "")}</td>
      <td>${esc(r.doc || "")}</td><td>${n(r.page)}</td><td>${esc(r.status || "—")}</td>
      <td>${n(r.rerank_score)}</td><td>${n(r.chars)}</td></tr>`).join("");
  const json = (v) => `<pre class="inspect-json">${esc(JSON.stringify(v, null, 1))}</pre>`;
  return `<details class="inspect">
    <summary>Inspection scientifique — retrieval, sortie brute du modèle, sortie validée</summary>
    <p class="fine">Lecture de la décharge de ce run (<code>trace_id</code>
      <code>${esc(out.trace_id || "—")}</code>) : aucun appel supplémentaire, aucun recalcul.
      Le pipeline ne produit pas de raisonnement interne (thinking OFF) : ce qui suit est la sortie
      observable du modèle et le résultat de la validation par le registre.</p>
    <h4>Retrieval — ${lin.n_fused ?? "—"} fusionnés (BM25 ${lin.n_bm25_candidates ?? "—"} ·
        dense ${lin.n_dense_candidates ?? "—"}), rangs dans les 50 fusionnés</h4>
    <div class="inspect-scroll"><table class="kv-table compact"><thead><tr>
      <th>passage</th><th>BM25</th><th>dense</th><th>RRF</th><th>rerank</th>
      <th>document</th><th>page</th></tr></thead><tbody>${fused}</tbody></table></div>
    <h4>Contexte final remis au générateur (E1–E5)</h4>
    <table class="kv-table compact"><thead><tr><th>alias</th><th>passage_id</th><th>document</th>
      <th>page</th><th>statut registre</th><th>score rerank</th><th>caractères</th></tr></thead>
      <tbody>${final}</tbody></table>
    <h4>Sortie structurée brute du générateur (${raw.length} item(s))</h4>
    <p class="fine">Lue du run tel que l'a enregistré le pipeline gelé : items de la politique
      d'auto-contrôle quand elle est active, sinon claims avec leurs alias d'évidence tels qu'ils
      ont été écrits — avant déduplication et avant arbitrage du registre. Jamais un
      raisonnement interne (<code>enable_thinking: false</code> : le pipeline n'en produit pas).</p>
    ${raw.length ? json(raw) : '<p class="fine">Aucun item brut (mode sources : aucune génération).</p>'}
    <h4>Sortie après validation par le registre (${val.length} affirmation(s))</h4>
    ${val.length ? json(val) : '<p class="fine">Aucune affirmation validée rendue.</p>'}
  </details>`;
}

function renderRunResult(out, meta = {}) {
  const card = $("runCard");
  card.hidden = false;
  const sourceOnly = !!out.source_only;
  const status = sourceOnly ? "SOURCES_ONLY" : out.status || "INCONNU";
  const [code, meaning] = STATUS_LABELS[status] || STATUS_LABELS.INCONNU;
  $("runStatus").textContent = code;
  $("runMeaning").textContent = meaning;
  $("runMetaLine").textContent = answerMeta(out, meta);
  card.dataset.status = status;
  const banner = $("runProvisional");
  banner.hidden = !out.has_provisional_source;
  banner.textContent = "Au moins une source citée est une recommandation en cours de publication : "
    + "à manier avec précaution (statut lu du registre, jamais du modèle).";
  $("runAnswer").innerHTML = sourceOnly
    ? `<p class="lead sources-label"><strong>Recherche documentaire — aucune réponse générée.</strong>
       Les passages ci-dessous sont les plus pertinents du corpus ; aucun texte médical n'a été
       rédigé, aucun n'est validé.</p>`
    : (status === "ABSTENTION"
      ? `<p class="lead abstain"><strong>ABSTENTION.</strong> ${rich(out.reason || "")}</p>`
      : answerHtml(out.answer)
        + ((out.limitations || []).length
          ? `<ul class="limits">${out.limitations.map((l) => `<li>${rich(l)}</li>`).join("")}</ul>` : ""));
  $("runSources").innerHTML = sourcesHtml(out.sources,
    sourceOnly ? "classés par pertinence, sans génération" : "citées par la réponse");
  $("runInspect").innerHTML = inspectionHtml(out);
  $("runTech").innerHTML = techHtml(out);
  STATE.lastRun = out;
  if (meta.record !== false) {
    STATE.progress[STATE.current && STATE.current.id] = {
      ...STATE.progress[STATE.current.id], done: true,
    };
    renderQuestionList();
  }
}

/* Reprendre une question doit restituer la REPONSE et ses sources, pas seulement le verdict :
   la ligne de session porte la réponse rendue, le statut, les sources du registre (doc, page,
   texte) et les latences. Sans cette lecture, un rechargement laissait l'écran vide et le
   praticien relançait un calcul pour retrouver ce qu'il avait déjà noté.
   Les champs d'inspection (lignée, brut, validé) sont relus eux aussi : la relance d'un appel
   de calcul n'est jamais nécessaire pour retrouver une évaluation. */
function runOutFromRow(row) {
  let sources = [];
  try { sources = JSON.parse(row.sources_cited || "[]"); } catch { sources = []; }
  let claims = [];
  try { claims = row.claims_cited || []; } catch { claims = []; }
  const status = row.run_status === "SOURCES_ONLY" ? null : row.run_status;
  return { question: row.question, status, source_only: row.run_status === "SOURCES_ONLY",
           mode: row.mode, answer: claims, sources, limitations: [], reason: "",
           has_provisional_source: !!row.has_provisional_source, timings: row.timings || {},
           trace_id: row.trace_id, lineage: row.lineage || null,
           raw_generator_output: row.raw_generator_output || null,
           validated_output: row.validated_output || null,
           technique: { n_claims: row.n_claims, top5_pids: row.top5_passage_ids,
             gen_model: row.generator_label, retrieval_profile: row.retrieval_profile,
             context_k: row.context_k, generation_prompt_sha256: row.generation_prompt_sha256 } };
}

/* Une ligne de metadonnees, pas un bloc technique : « Réponse · 2,3 s · 1 source ».
   trace_id, modele, SHA, latences detaillees restent sous « Détails techniques » / Lab. */
function answerMeta(out, meta = {}) {
  const n = (out.sources || []).length;
  return `${out.source_only ? "Recherche documentaire" : (out.status === "ABSTENTION" ? "Abstention" : "Réponse")}`
    + ` · ${fmt((out.timings || {}).t_total_s)} s · ${n} source${n > 1 ? "s" : ""}`
    + (meta.restored ? " · réponse retrouvée" : "");
}

/* Les trois champs d'inspection viennent de la reponse de /api/ask : les renvoyer au moment de
   l'enregistrement coute zero (aucun appel de calcul) et rend l'audit relisible plus tard. */
function inspectFields(out) {
  return { raw_generator_output: out.raw_generator_output || null,
           validated_output: out.validated_output || null,
           lineage: out.lineage || null };
}

function runRow(out) {
  const answer = out.answer || [];
  return {
    benchmark_id: (STATE.current || {}).id, question: out.question,
    trace_id: out.trace_id, ...inspectFields(out),
    benchmark_sha256: (STATE.session || {}).benchmark_sha256,
    run_id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    corpus_fingerprint: (STATE.health || {}).corpus_fingerprint,
    generator_label: ($("runModel").selectedOptions[0] || {}).textContent || "flash (défaut)",
    // cle machine du modele : c'est elle que la session figee compare (le label, lui, est humain)
    generator_key: $("runModel").value || null,
    mode: out.mode || $("runMode").value, run_status: out.status || (out.source_only ? "SOURCES_ONLY" : null),
    response: answer.length ? answer.map((a) => `• ${a.text}`).join("\n")
      : (out.source_only ? "[SOURCES_ONLY — aucune réponse générée]" : out.reason || ""),
    answer_chars: answer.length ? answer.reduce((n, a) => n + a.text.length, 0) : (out.source_only ? 0 : (out.reason || "").length),
    n_claims: (out.technique || {}).n_claims,
    claims_cited: answer.map((a) => ({ text: a.text, refs: a.refs, citation_valid: a.citation_valid })),
    top5_passage_ids: (out.technique || {}).top5_pids || [],
    top_context_pids: (out.technique || {}).top_context_pids || [],
    retrieval_profile: (out.technique || {}).retrieval_profile,
    context_k: (out.technique || {}).context_k,
    source_statuses: (out.sources || []).map((s) => ({ ref: s.ref, passage_id: s.passage_id,
                                                      source_status: s.source_status,
                                                      authority: s.source_authority })),
    // provenance complète de la réponse évaluée (document, page, texte du registre) : une
    // réponse notée doit rester inspectable après rechargement et dans l'export, sans relancer.
    sources_cited: JSON.stringify((out.sources || []).map((s) => ({
      ref: s.ref, passage_id: s.passage_id, document: s.document, page: s.page,
      source_status: s.source_status, source_authority: s.source_authority,
      excerpt: String(s.excerpt || "").slice(0, 600) }))),
    has_provisional_source: !!out.has_provisional_source,
    timings: { retrieval_s: (out.timings || {}).retrieval_s, generation_s: (out.timings || {}).generation_s,
               t_total_s: (out.timings || {}).t_total_s },
    generation_prompt_sha256: (out.technique || {}).generation_prompt_sha256,
  };
}

async function saveRun(out) {
  try {
    const res = await api(`/api/eval/session/${encodeURIComponent(STATE.session.name)}/run`,
      { method: "POST", body: runRow(out) });
    STATE.progress = res.progress.items || STATE.progress;
    STATE.runs[(STATE.current || {}).id] = { ...runRow(out), codes: [], verdict: null };
    renderQuestionList();
    $("scoreSaved").textContent = "run enregistré";
  } catch (e) { notice("runNotice", "Run non enregistré : " + e.message, "error"); }
}

/* ------------------------------------------------------------------ scoring */
function renderFreeModes() {   // valeurs = wire du contrat, texte = label + intention
  const sel = $("freeMode"); if (!sel) return;
  const keep = sel.value || "courte";      // defaut medecin : reponse courte (clinician-ux §5)
  const modes = window.A2MEDContract.caps().modes || [];
  if (modes.length) sel.innerHTML = modes.map((m) =>
    `<option value="${esc(m.wire)}">${esc(m.label)} — ${esc(m.hint || "")}</option>`).join("");
  sel.value = keep;
  if (!sel.value) sel.value = "courte";
  // Le benchmark garde son defaut historique (« standard ») : une session creee aujourd'hui doit
  // rester comparable avec celles deja scorees. Seules les questions libres sont en courte.
  const sessionMode = $("newSessionMode");
  if (sessionMode && modes.length && !sessionMode.options.length) {
    sessionMode.innerHTML = modes.map((m) => `<option value="${esc(m.wire)}">${esc(m.label)}</option>`).join("");
  }
  if (sessionMode && sessionMode.options.length && !sessionMode.value) sessionMode.value = "standard";
  // Le selecteur de mode du benchmark était laissé VIDE : `$("runMode").value` valait "", le
  // service retombait sur « standard » en silence et un run demandé en « courte » était enregistré
  // en « standard » — avec le gel de session (clinician-ux), il était même refusé (409).
  const runMode = $("runMode");
  if (runMode && modes.length && !runMode.options.length) {
    runMode.innerHTML = modes.map((m) => `<option value="${esc(m.wire)}">${esc(m.label)}</option>`).join("");
  }
  if (runMode && runMode.options.length && !runMode.value) runMode.value = "standard";
}

function renderCodes() {
  const list = $("codeList");
  if (!list.dataset.built) {
    list.innerHTML = (STATE.taxonomy.length ? STATE.taxonomy : []).map((code) =>
      `<label class="check"><input type="checkbox" value="${esc(code)}">`
      + `<span>${esc(window.A2MEDContract.taxLabel(code))} <code class="taxcode">${esc(window.A2MEDContract.taxUi(code))}</code></span></label>`
    ).join("");
    list.dataset.built = "1";
  }
  renderSimpleCodes("simpleCodes", "codeList");
  renderSimpleCodes("freeSimpleCodes", "freeCodes");
}

/* Les motifs medecins ne sont PAS une deuxieme taxonomie : chacun cochera une case DEJA existante
   de la liste des 17 codes. Le contrat n'est donc pas decore — meme etat, memes cles stables a
   l'export et aux agregats. La liste complete reste sous « Classification détaillée » (§7). */
function renderSimpleCodes(boxId, listId) {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = window.A2MEDContract.taxonomySimple().map((m) =>
    `<button type="button" class="chip" role="checkbox" aria-checked="false" data-code="${esc(m.code)}">`
    + `${esc(m.label)}</button>`).join("");
  syncChips(listId, boxId);
}

function syncChips(listId, boxId) {
  const checked = new Set([...document.querySelectorAll(`#${listId} input:checked`)].map((b) => b.value));
  document.querySelectorAll(`#${boxId} .chip`).forEach((c) =>
    c.setAttribute("aria-checked", String(checked.has(c.dataset.code))));
}

function toggleChip(listId, boxId, chip) {
  const box = document.querySelector(`#${listId} input[value="${chip.dataset.code}"]`);
  if (!box) return;                        // un motif sans code dans le contrat n'ecrit rien
  box.checked = !box.checked;
  syncChips(listId, boxId);
}

function loadScoreForm() {
  renderCodes();
  const row = STATE.runs[(STATE.current || {}).id] || {};
  document.querySelectorAll("#codeList input").forEach((box) => {
    box.checked = (row.codes || []).includes(box.value);
  });
  syncChips("codeList", "simpleCodes");
  $("noteBox").value = row.note || "";
  document.querySelectorAll(".verdicts button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.verdict === (row.verdict || null)));
  });
  $("scoreSaved").textContent = row.scored_at ? `enregistré ${row.scored_at}` : "";
}

let saveTimer = null;
async function postScore(patch) {
  if (!STATE.session) return notice("runNotice", "Aucune session : rien n'est enregistré.", "warn");
  if (!STATE.current) return;
  const body = { benchmark_id: STATE.current.id, ...patch };
  try {
    const res = await api(`/api/eval/session/${encodeURIComponent(STATE.session.name)}/score`,
      { method: "POST", body });
    STATE.progress = res.progress.items || STATE.progress;
    STATE.runs[STATE.current.id] = { ...(STATE.runs[STATE.current.id] || {}),
                                      benchmark_id: STATE.current.id, ...patch };
    $("scoreSaved").textContent = `enregistré ${new Date().toLocaleTimeString()}`;
    renderQuestionList();
  } catch (e) {
    $("scoreSaved").textContent = "ÉCHEC d'enregistrement : " + e.message;
    notice("runNotice", "Score non enregistré : " + e.message, "error");
  }
}

function setVerdict(verdict) {
  if (!STATE.current) return notice("runNotice", "Sélectionnez une question.", "warn");
  document.querySelectorAll("#scoring .verdicts button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.verdict === verdict)));
  $("codesField").hidden = !["partial", "incorrect"].includes(verdict);
  // ENREGISTREMENT IMMÉDIAT (promesse tenue par la page : « à chaque action ») : un verdict
  // posé au clavier puis une navigation fléchée ne doit jamais perdre la décision.
  postScore({ verdict, codes: currentCodes(), note: $("noteBox").value });
}

function currentCodes() {
  return [...document.querySelectorAll("#codeList input:checked")].map((b) => b.value);
}

function saveCodes() {
  postScore({ verdict: (STATE.runs[(STATE.current || {}).id] || {}).verdict || null,
              codes: currentCodes(), note: $("noteBox").value });
}

function saveNoteDebounced() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => postScore({
    verdict: (STATE.runs[(STATE.current || {}).id] || {}).verdict || null,
    codes: currentCodes(), note: $("noteBox").value }), 500);
}

/* ------------------------------------------------------------------ comparaison de générateurs */
function renderGenerators() {
  const live = STATE.generators.filter((g) => g.available);
  const pref = ((live.find((g) => g.key === "qwen9b" && g.model_served !== false)
    || live.find((g) => g.key === "flash") || live[0] || {}).key) || "";
  // Pas de repli silencieux (clinician-ux §5) : si le modele par defaut est sonde hors service,
  // la page le dit au lieu de faire semblant de jouer sur le 9B.
  const neuf = STATE.generators.find((g) => g.key === "qwen9b");
  STATE.genNote = (neuf && !neuf.available && pref && pref !== "qwen9b")
    ? `modèle par défaut indisponible (${neuf.error || "sonde en échec"}) — sélection reportée sur `
      + `${(STATE.generators.find((g) => g.key === pref) || {}).label || pref}` : "";
  const box = $("cmpGenerators");
  box.innerHTML = STATE.generators.map((g) => `<label class="check gen${g.available ? "" : " off"}">
      <input type="checkbox" value="${esc(g.key)}" ${g.key === pref ? "checked" : ""}
        ${g.available ? "" : "disabled"}>
      <span>${esc(g.label)}</span>
      <small>${g.available ? `modèle ${esc(g.model || "?")} · sonde ${fmt(g.t_probe_s, 2)}s`
        : `INDISPONIBLE (${esc(g.error || "sonde en échec")})`}</small>
    </label>`).join("");
  const options = STATE.generators.map((g) =>
    `<option value="${esc(g.key)}" ${g.key === pref ? "selected" : ""}
      ${g.available ? "" : "disabled"}>${esc(g.label)}${g.available ? "" : " (indisponible)"}</option>`
  ).join("");
  // memes candidats, meme contrat ; `newSessionModel` = le choix qui sera fige a la creation
  for (const id of ["runModel", "freeModel", "newSessionModel"]) {
    const select = $(id);
    if (select && !select.options.length) select.innerHTML = options;
  }
  renderRunConfig();
}

function labelsFor(key, n) {
  const stored = JSON.parse(localStorage.getItem(LS.labels) || "{}");
  if (!stored[key] || stored[key].length !== n) {
    const letters = "ABCDEFGH".split("").slice(0, n);
    for (let i = letters.length - 1; i > 0; i -= 1) {        // tirage au sort, étiquettes A/B/C/D
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    stored[key] = letters;
    localStorage.setItem(LS.labels, JSON.stringify(stored));
  }
  return stored[key];
}

function chosenGenerators() {
  return [...document.querySelectorAll("#cmpGenerators input:checked")].map((b) => b.value);
}

async function generateInto(article, key, label, question, retrieval, qid, blind) {
  const body = article.querySelector(".body"), status = article.querySelector(".status");
  const gen = STATE.generators.find((g) => g.key === key) || {};
  try {
    if (!retrieval.source_token) throw new Error("jeton de retrieval absent (reproduction gelée)");
    const out = await api("/api/eval/generate", { method: "POST", body: {
      question, source_token: retrieval.source_token, generator: key,
      mode: $("cmpMode").value, ...retrievalOptions(),
      expected_prompt_sha256: (retrieval.technique || {}).generation_prompt_sha256 || null } });
    status.textContent = out.status || "—";
    const chars = (out.answer || []).reduce((n, a) => n + a.text.length, 0);
    const sha = (out.technique || {}).generation_prompt_sha256 || "";
    if (sha) { STATE.cmpExpectedSha = STATE.cmpExpectedSha || sha; STATE.cmpShas[label] = sha; }
    const same = sha && sha === STATE.cmpExpectedSha ? true : null;
    renderCmpSha();
    body.innerHTML = answerHtml(out.answer)
      + ((out.limitations || []).length
        ? `<ul class="limits">${out.limitations.map((l) => `<li>${rich(l)}</li>`).join("")}</ul>` : "")
      + (out.status === "ABSTENTION" ? `<p class="lead abstain">${rich(out.reason || "")}</p>` : "")
      + `<p class="fine mono">${chars} car. · génération ${fmt((out.timings || {}).generation_s)} s · `
      + `total ${fmt((out.timings || {}).t_total_s)} s · prompt ${esc(sha.slice(0, 10))}… `
      + (same === false ? '<span class="badge bad">prompt DIFFÉRENT — comparaison invalide</span>'
        : same === true ? '<span class="badge ok">prompt identique</span>' : "") + `</p>`
      + sourcesHtml(out.sources, "contexte figé");
    savePanel(qid, label, key, {
      run_status: out.status, response: (out.answer || []).map((a) => `• ${a.text}`).join("\n"),
      answer_chars: chars, mode: out.mode,
      // preuve persistée : tous les panneaux de cette comparaison partagent BIEN le même retrieval
      source_token: retrieval.source_token, ...inspectFields(out),
      timings: { retrieval_s: (retrieval.timings || {}).retrieval_s,
                 generation_s: (out.timings || {}).generation_s, t_total_s: (out.timings || {}).t_total_s },
      generation_prompt_sha256: sha,
      top5_passage_ids: (out.technique || {}).top5_pids || [],
      top_context_pids: (out.technique || {}).top_context_pids || [],
      retrieval_profile: (out.technique || {}).retrieval_profile,
      context_k: (out.technique || {}).context_k,
      n_claims: (out.technique || {}).n_claims,
    }, blind);
  } catch (e) {
    status.textContent = "indisponible";
    body.innerHTML = `<p class="danger">Panneau indisponible : ${esc(e.message)}`
      + `<br><span class="fine">${esc((e.body && e.body.code) || "")} — les autres panneaux ne sont pas affectés.</span></p>`;
  }
}

function renderCmpSha() {
  const pairs = Object.entries(STATE.cmpShas || {});
  if (!pairs.length || !$("cmpFrozen")) return;
  const uniq = [...new Set(pairs.map(([, s]) => s))];
  $("cmpFrozen").textContent = `${STATE.cmpFrozenBase} · prompt de génération ${
    uniq.length === 1 ? "identique" : "DIFFÉRENT"} sur ${pairs.length} panneau(s) : `
    + uniq.map((s) => esc(s.slice(0, 10))).join(" ≠ ");
}

async function savePanel(qid, label, generatorKey, patch, blind) {
  if (!STATE.session) return;
  const panelKey = `cmp-${label}`;
  const body = { benchmark_id: qid, panel_key: panelKey, label,
                 // The label remains blind in the UI, but the server-side session/export must
                 // retain the recoverable label→generator mapping before revelation.
                 generator_key: generatorKey, ...patch };
  try {
    if (patch.response !== undefined || patch.run_status !== undefined) {
      await api(`/api/eval/session/${encodeURIComponent(STATE.session.name)}/run`,
        { method: "POST", body: { ...body, question: ($("cmpFree").value.trim()
          || (STATE.current && STATE.current.question) || ""),
          benchmark_sha256: (STATE.session || {}).benchmark_sha256,
          generator_label: blind ? "masqué (comparaison aveugle)"
            : (STATE.generators.find((g) => g.key === generatorKey) || {}).label } });
    }
    const res = await api(`/api/eval/session/${encodeURIComponent(STATE.session.name)}/score`,
      { method: "POST", body });
    STATE.progress = res.progress.items || STATE.progress;
  } catch (e) { /* un panneau qui n'enregistre pas ne doit pas casser les autres */ }
}

function maybeReveal() {
  const cards = [...document.querySelectorAll(".cmp-card")];
  const allScored = cards.length > 0 && cards.every((c) =>
    c.querySelector('.verdicts button[aria-pressed="true"]'));
  if (allScored && $("cmpBlind").checked) {
    const box = $("cmpPanels");
    if (!$("#revealBox")) {
      const div = document.createElement("div");
      div.className = "panel reveal-box"; div.id = "revealBox";
      div.innerHTML = '<button type="button" class="btn primary" id="revealBtn">Révéler les identités</button>'
        + '<p class="fine">Révélation après scoring : le mapping est écrit dans l’export.</p>';
      box.parentElement.appendChild(div);
      $("revealBtn").addEventListener("click", revealIdentities);
    }
  }
}

async function revealIdentities() {
  document.querySelectorAll(".cmp-card .cmp-id").forEach((el) => { el.hidden = false; });
  const mapping = STATE.cmpMapping || {};
  for (const [label, key] of Object.entries(mapping)) {
    await savePanel(STATE.cmpQuestionId, label, key, { revealed: true, generator_key: key }, false);
  }
  notice("cmpNotice", "Identités révélées et consignées dans l'export.", "info");
}

/* ------------------------------------------------------------------ modes de réponse */
async function runModes() {
  const question = ($("modeFree").value.trim() || (STATE.current && STATE.current.question) || "").trim();
  if (!question) return notice("modeNotice", "Aucune question.", "warn");
  if (!STATE.session) return notice("modeNotice", "Créez ou reprenez une session.", "warn");
  notice("modeNotice", "", "info");
  const box = $("modePanels");
  box.innerHTML = "";
  const qid = (STATE.current || {}).id || "libre";
  for (const mode of ["sources", "courte", "standard"]) {
    const article = document.createElement("article");
    article.className = "panel mode-card";
    article.dataset.mode = mode;
    article.innerHTML = `<header><strong>mode ${esc(mode)}</strong>
        <span class="status mono">…</span><span class="lat mono"></span></header>
      <div class="body"><p class="fine">en cours…</p></div>
      <div class="yesno">
        <span>réponse suffisamment complète ?</span>
        ${["oui", "non", "na"].map((v) => `<label class="check"><input type="radio" name="complete-${mode}" value="${v}">${v}</label>`).join("")}
      </div>
      <div class="yesno">
        <span>indûment verbeuse ?</span>
        ${["oui", "non", "na"].map((v) => `<label class="check"><input type="radio" name="verbose-${mode}" value="${v}">${v}</label>`).join("")}
      </div>
      <p class="fine saved"></p>`;
    box.appendChild(article);
    article.querySelectorAll("input[type=radio]").forEach((r) => r.addEventListener("change", () => {
      savePanel(qid, `mode-${mode}`, null, {
        complete: (article.querySelector(`input[name=complete-${mode}]:checked`) || {}).value || null,
        verbose: (article.querySelector(`input[name=verbose-${mode}]:checked`) || {}).value || null,
      });
      article.querySelector(".saved").textContent = "enregistré";
    }));
    setBusy(true, `mode ${mode}`);
    try {
      const body = { question, mode, ...retrievalOptions() };
      if ($("runModel").value) body.model = $("runModel").value;
      const out = await api("/api/ask", { method: "POST", body });
      renderModePanel(article, out);
      await savePanel(qid, `mode-${mode}`, null, {
        run_status: out.status || (out.source_only ? "SOURCES_ONLY" : null),
        mode, response: (out.answer || []).map((a) => `• ${a.text}`).join("\n")
          || (out.source_only ? "[SOURCES_ONLY]" : out.reason || ""),
        answer_chars: (out.answer || []).reduce((n, a) => n + a.text.length, 0),
        timings: { retrieval_s: (out.timings || {}).retrieval_s,
                   generation_s: (out.timings || {}).generation_s, t_total_s: (out.timings || {}).t_total_s },
        top5_passage_ids: (out.technique || {}).top5_pids || [],
        n_claims: (out.technique || {}).n_claims,
        generator_label: ($("runModel").selectedOptions[0] || {}).textContent || "flash (défaut)",
      });
    } catch (e) {
      article.querySelector(".status").textContent = "erreur";
      article.querySelector(".body").innerHTML = `<p class="danger">${esc(e.message)}</p>`;
    } finally { setBusy(false); }
  }
}

function renderModePanel(article, out) {
  const chars = (out.answer || []).reduce((n, a) => n + a.text.length, 0);
  article.querySelector(".status").textContent = out.status || (out.source_only ? "SOURCES_ONLY" : "—");
  article.querySelector(".lat").textContent =
    `total ${fmt((out.timings || {}).t_total_s)} s · génération ${fmt((out.timings || {}).generation_s)} s`;
  article.querySelector(".body").innerHTML = (out.source_only
    ? `<p class="lead sources-label"><strong>Recherche documentaire — aucune réponse générée.</strong></p>`
      + sourcesHtml(out.sources, "sans génération")
    : (out.status === "ABSTENTION" ? `<p class="lead abstain">${rich(out.reason || "")}</p>`
      : answerHtml(out.answer))) + `<p class="fine mono">${chars} caractères</p>`;
}

/* ------------------------------------------------------------------ Lab retrieval */
const lineageLine = (row) => {
  const part = (name, rank) => (rank == null ? `${name} —` : `${name} #${rank}`);
  return [part("BM25", row.bm25_rank), part("Dense", row.dense_rank), part("RRF", row.rrf_rank),
    part("Rerank", row.rerank_rank)].join(" · ");
};

function labTable(rows, columns) {
  return `<div class="table-wrap"><table><thead><tr>`
    + columns.map((c) => `<th>${esc(c[0])}</th>`).join("") + `</tr></thead><tbody>`
    + rows.map((r, i) => `<tr>` + columns.map((c) => `<td>${c[1](r, i)}</td>`).join("") + `</tr>`).join("")
    + `</tbody></table></div>`;
}

async function runLab() {
  const question = $("labQuestion").value.trim() || (STATE.current && STATE.current.question) || "";
  if (!question) return notice("labNotice", "Aucune question à tracer.", "warn");
  notice("labNotice", "", "info");
  setBusy(true, "trace retrieval en cours");
  try {
    const out = await api("/api/eval/lab", { method: "POST", body: { question, ...retrievalOptions() } });
    renderLab(out);
  } catch (e) {
    notice("labNotice", "Trace en échec : " + e.message, "error");
  } finally { setBusy(false); }
}

function renderLab(out) {
  STATE.lastLab = out;
  const run = out.lab_run || {};
  $("labMeta").textContent = `run de diagnostic : statut ${run.status || "—"} · `
    + `total ${fmt(run.t_total_s)} s · appels générateur ${run.n_generator_calls ?? "—"} · `
    + `pool ${run.n_pool ?? "—"} passages · corpus ${run.n_passages ?? "—"}`
    + ` · vue diagnostique, le hybrid de production reste seul chemin clinique`;
  $("labFinal").hidden = false;
  $("labFinalTable").innerHTML = labTable(out.top5 || [], [
    ["E#", (r) => esc(r.final_label)],
    ["rang final", (r) => r.final_rank],
    ["document", (r) => esc(r.doc)], ["page", (r) => esc(r.page ?? "—")],
    ["statut registre", (r) => esc(r.status ?? "—")],
    ["passage_id", (r) => `<code>${esc(r.pid)}</code>`],
    ["extrait", (r) => `<span class="excerpt">${esc(String(r.text || "").slice(0, 220))}</span>`],
  ]);
  const excluded = (out.fused || []).filter((r) => !r.rerank_rank || r.rerank_rank > 5);
  const onlyExcluded = $("labExcluded").checked;
  const fused = (onlyExcluded ? excluded : (out.fused || [])).slice(0, 50);
  $("labLineage").hidden = !(out.fused || []).length;
  $("labLineageTable").innerHTML = labTable(fused, [
    ["RRF", (r) => r.rrf_rank],
    ["lignée", (r) => `<span class="mono">${esc(lineageLine(r))}</span>`],
    ["→ final", (r) => (r.rerank_rank && r.rerank_rank <= 5 ? `<strong>E${r.rerank_rank}</strong>`
      : (r.rerank_rank ? `hors top-5 (rerank #${r.rerank_rank})` : "hors top-5"))],
    ["document", (r) => esc(r.doc)], ["page", (r) => esc(r.page ?? "—")],
    ["rerank", (r) => fmt(r.rerank_score, 4)],
    ["passage_id", (r) => `<code>${esc(r.pid)}</code>`],
  ]) + `<p class="fine">${excluded.length} des 50 fusionnés ne passent pas le rerank jusqu'au top-5.</p>`;
  $("labOrders").hidden = !out.stage1_top10;
  const orderTable = (rows, title) => `<h3>${esc(title)}</h3>` + labTable(rows || [], [
    ["#", (_r, i) => i + 1], ["document", (r) => esc(r.doc)], ["page", (r) => esc(r.page ?? "—")],
    ["passage_id", (r) => `<code>${esc(r.pid)}</code>`],
  ]);
  $("labOrdersTables").innerHTML = ["bm25_only", "dense_only", "hybrid"].map((k) =>
    orderTable(out.stage1_top10[k], { bm25_only: "BM25 seul (top-10 du pool)",
      dense_only: "BGE-M3 dense seul (top-10)", hybrid: "Hybride RRF (top-10, production)" }[k]))
    .join("") + `<p class="fine">Ces trois listes sont diagnostiques : la production ne voit que
      l'hybride reranké en top-5.</p>`;
}

/* ------------------------------------------------------------------ import */
async function importBenchmark() {
  const name = $("importName").value.trim();
  const file = $("importFile").files[0];
  if (!name || !file) return notice("sessionNotice", "Donnez un nom de fichier et choisissez-le.", "warn");
  const content = await file.text();
  try {
    const out = await api("/api/eval/import", { method: "POST",
      body: { name, content, overwrite: $("importOverwrite").checked } });
    notice("sessionNotice", `Importé : ${out.name} (${out.n_questions} questions) · SHA `
      + `${String(out.sha256).slice(0, 16)}…`
      + (out.warnings.length ? ` · avertissements : ${out.warnings.join(" ; ")}` : ""), "info");
    await loadBenchmarks();
    $("benchSelect").value = out.name;
    onBenchmarkChange();
  } catch (e) { notice("sessionNotice", "Import refusé : " + e.message, "error"); }
}

/* ------------------------------------------------------------------ raccourcis + câblage */
document.addEventListener("keydown", (event) => {
  const tag = (event.target.tagName || "").toLowerCase();
  const typing = tag === "textarea" || (tag === "input" && ["text", "search"].includes(event.target.type));
  if (event.key === "Escape") { event.target.blur && event.target.blur(); return; }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const panel = document.querySelector(`.tab-panel[data-panel="${STATE.tab}"]`);
  if (panel && !panel.hidden) {
    if (event.key === "ArrowRight") { move(1); event.preventDefault(); }
    else if (event.key === "ArrowLeft") { move(-1); event.preventDefault(); }
    else if (["1", "2", "3", "4"].includes(event.key) && STATE.tab === "run") {
      setVerdict(Object.values(window.A2MEDContract.verdictKeys())[Number(event.key) - 1]);
      event.preventDefault();
    } else if (event.key === "e") { $("noteBox").focus(); event.preventDefault(); }
  }
  if (STATE.tab === "free" && ["1", "2", "3", "4"].includes(event.key)) {
    setFreeVerdict(Object.values(window.A2MEDContract.verdictKeys())[Number(event.key) - 1]);
    event.preventDefault();
  }
  if (STATE.tab === "free" && !typing && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    moveFree(event.key === "ArrowRight" ? 1 : -1); event.preventDefault();
  }
});

const LAB_TABS = ["compare", "modes", "lab", "admin"];

function showTab(tab) {
  if (!["run", "free"].concat(LAB_TABS).includes(tab)) tab = "run";
  STATE.tab = tab;
  // Un onglet de Lab implique le mode Lab (sinon ses panneaux seraient masques par le CSS) ;
  // revenir a Benchmark/Questions libres replie le Lab et rend l'ecran clinique.
  const lab = LAB_TABS.includes(tab);
  $("labBox").open = lab;
  setUx(lab ? "lab" : "medecin");
  if (lab) STATE.labTab = tab;
  document.body.dataset.tab = tab;        // la page sait quel écran est actif (cf. CSS [data-tab])
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  if (tab === "lab" && !$("labQuestion").value && STATE.current) {
    $("labQuestion").value = STATE.current.question;
  }
  const params = new URLSearchParams(location.search);
  params.set("tab", tab);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

async function boot() {
  STATE.tab = (new URLSearchParams(location.search).get("tab")) || "run";
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("sessionCreate").addEventListener("click", createSession);
  $("uxToggle").addEventListener("click", () => {
    if (document.body.dataset.ux === "lab") showTab("run");
    else { $("labBox").open = true; showTab(STATE.labTab || "admin"); }
  });
  $("changeConfig").addEventListener("click", () => {
    $("sessionBar").open = true;
    $("newSessionName").focus();
    say("Configuration : le mode et le modele seront figes pour toute la session.");
  });
  $("simpleCodes").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    toggleChip("codeList", "simpleCodes", chip);
    saveCodes();
  });
  $("freeSimpleCodes").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    toggleChip("freeCodes", "freeSimpleCodes", chip);
    postFreeScore({});
  });
  $("freeMode").addEventListener("change", renderRunConfig);
  $("freeModel").addEventListener("change", renderRunConfig);
  setUx(document.body.dataset.tab && LAB_TABS.includes(document.body.dataset.tab)
    ? "lab" : (localStorage.getItem(LS.ux) || "medecin"));
  $("sessionResume").addEventListener("click", () => resumeSession());
  $("sessionRename").addEventListener("click", renameSession);
  $("sessionReset").addEventListener("click", resetSession);
  $("benchSelect").addEventListener("change", onBenchmarkChange);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", importBenchmark);
  $("questionSelect").addEventListener("change", (e) => selectQuestion(e.target.value));
  $("filterState").addEventListener("change", renderQuestionList);
  $("filterCode").addEventListener("change", renderQuestionList);
  $("runBtn").addEventListener("click", runQuestion);
  $("labFromRun").addEventListener("click", () => {
    if (STATE.current) $("labQuestion").value = STATE.current.question;
    showTab("lab"); runLab();
  });
  document.querySelectorAll(".verdicts button").forEach((b) =>
    b.addEventListener("click", () => setVerdict(b.dataset.verdict)));
  $("codeList").addEventListener("change", saveCodes);
  $("noteBox").addEventListener("input", saveNoteDebounced);
  $("noteBox").addEventListener("blur", saveNoteDebounced);
  $("prevBtn").addEventListener("click", () => move(-1));
  $("nextBtn").addEventListener("click", () => move(1));
  $("cmpRun").addEventListener("click", () => runCompare(false));
  $("cmpRegen").addEventListener("click", () => runCompare(true));
  $("modeRun").addEventListener("click", runModes);
  $("labRun").addEventListener("click", runLab);
  $("labExcluded").addEventListener("change", () => STATE.lastLab && renderLab(STATE.lastLab));
  showTab(STATE.tab);
  const baseProblem = window.A2MEDContract.apiBaseProblem(API_BASE);
  if (baseProblem) notice("sessionNotice", baseProblem, "error");
  await loadHealth();
  // Le contrat (modes, verdicts, taxonomie, modèles) ne décore que le reste : s'il est muet,
  // les jeux et les sessions doivent quand même charger. Une liste vide à l'écran a déjà été
  // vécue comme « la plateforme est morte » alors que le service répondait (18/09).
  let contratMuet = null;
  try {
    const caps = window.A2MEDContract.apply(await api("/api/capabilities"));
    STATE.generators = caps.generators || [];
    STATE.taxonomy = (caps.taxonomy || []).map((t) => t.code);
  } catch (e) {
    contratMuet = e.message;
    STATE.generators = [];
  }
  renderFreeModes();          // d'abord : les selecteurs de mode portent le defaut medecin
  renderGenerators();         // ensuite : modeles sondes + eventuel repli de selection
  renderCodes();
  renderRunConfig();
  if (contratMuet) {
    notice("sessionNotice", "Contrat du service illisible : " + contratMuet, "error");
    // `sessionNotice` est dans un <details> replie : un contrat illisible doit etre visible sans
    // ouvrir la configuration, sinon le front tourne sur son FALLBACK en silence.
    const ht = document.getElementById("healthText");
    if (ht) ht.textContent = "contrat du service illisible — " + contratMuet;
    const dot = document.getElementById("healthDot") || document.querySelector("#health .dot");
    if (dot) dot.classList.add("bad");
  }
  try {
    await loadBenchmarks();
    await loadSessions();
    const last = localStorage.getItem(LS.last);
    if (last) await resumeSession(last);
    else { renderCodes(); sessionHead(); }
  } catch (e) { notice("sessionNotice", e.message, "error"); }
  sessionHead();
  say("Plateforme d'évaluation prête.");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

// V2.1 UX: benchmark-first controls, frontend-only API option propagation.
function retrievalOptions(){return {retrieval_profile:$("retrievalProfile").value,context_k:Number($("contextK").value)};}
function updateActiveConfig(){const x={hybrid:"hybride équilibré",dense:"sémantique dense",bm25:"lexical BM25"};$("activeConfig").textContent=`${x[$("retrievalProfile").value]} · ${$("contextK").value} passages`;}
function updateHome(){const s=STATE.session;$("continueBtn").hidden=!s;$("sessionSummary").textContent=s?`${s.label||s.name} · ${STATE.questions.length} questions · ${STATE.progress.n_items_scored||0} revues`:"Choisissez ou créez une session dans la configuration pour commencer.";}
async function saveAndNext(){if(!STATE.current)return;const v=(document.querySelector("#scoring .verdicts button[aria-pressed=true]")||{}).dataset?.verdict||null;await postScore({verdict:v,codes:["partial","incorrect"].includes(v)?currentCodes():[],note:$("noteBox").value});move(1);}
async function runCompare(keep){const q=($("cmpFree").value.trim()||(STATE.current&&STATE.current.question)||"").trim(),keys=chosenGenerators();if(!q||!keys.length)return notice("cmpNotice","Choisissez une question et au moins un modèle disponible.","warn");let r=STATE.cmpRetrieval;setBusy(true,"récupération en cours");try{if(!keep||!r){r=await api("/api/eval/retrieval",{method:"POST",body:{question:q,...retrievalOptions()}});STATE.cmpRetrieval=r;}const labels=labelsFor(q,keys.length),map={},box=$("cmpPanels");box.innerHTML="";$("cmpQuestion").textContent=q;STATE.cmpShas={};STATE.cmpExpectedSha=null;STATE.cmpFrozenBase=`top-5 figé · ${$("activeConfig").textContent}`;$("cmpFrozen").textContent=STATE.cmpFrozenBase;const blind=$("cmpBlind").checked,qid=(STATE.current||{}).id||"libre";for(let i=0;i<keys.length;i+=1){const key=keys[i],label=labels[i];map[label]=key;const article=document.createElement("article");article.className="panel cmp-card";article.dataset.label=label;article.innerHTML=`<header><span class="cmp-label">Panneau ${esc(label)}</span><span class="cmp-id" hidden>${esc((STATE.generators.find(g=>g.key===key)||{}).label||key)}</span><span class="status mono">…</span></header><div class="body"><p class="fine">génération ${i+1}/${keys.length} en cours…</p></div>`;box.appendChild(article);notice("cmpNotice",`Génération ${i+1}/${keys.length}…`,"info");await generateInto(article,key,label,q,r,qid,blind);}STATE.cmpMapping=map;STATE.cmpQuestionId=qid;notice("cmpNotice",`Comparaison terminée — ${keys.length} génération(s) séquentielle(s).`,"info");}catch(e){notice("cmpNotice","Retrieval en échec : "+e.message,"error");}finally{setBusy(false);}}
document.addEventListener("DOMContentLoaded",()=>{$("continueBtn").addEventListener("click",()=>{if(STATE.current)$("questionText").scrollIntoView({behavior:"smooth",block:"center"});});$("prevTop").addEventListener("click",()=>move(-1));$("nextTop").addEventListener("click",()=>move(1));$("scoreNext").addEventListener("click",saveAndNext);$("retrievalProfile").addEventListener("change",updateActiveConfig);$("contextK").addEventListener("change",updateActiveConfig);updateActiveConfig();$("openModes").addEventListener("click",()=>showTab("modes"));$("openLab").addEventListener("click",()=>showTab("lab"));});

const _v21ResumeSession = resumeSession;
resumeSession = async function(name) { await _v21ResumeSession(name); updateHome(); };
const _v21BenchmarkChange = onBenchmarkChange;
onBenchmarkChange = function() { _v21BenchmarkChange(); updateHome(); };

/* ==================================================================== QUESTIONS LIBRES
   Mission v2-real-world-validation-001 §3 : un praticien pose une question réelle, évalue la
   réponse en quelques secondes. Séparation stricte d'avec le benchmark : une file « free » est
   une session `eval_kind:"free"`, sans jeu ni SHA, où `benchmark_id` = `trace_id` de la requête.
   Ces lignes ne sont jamais comptées avec un jeu gelé (l'agrégation rend deux rapports). */

function freeSessionDefault() { return "free-" + new Date().toISOString().slice(0, 10); }
function freeRadio(name) { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : null; }
function setFreeRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.checked = r.value === value; });
}

async function downloadText(path, filename, mime) {
  const session = sessionStorage.getItem("a2med_proxy_session");
  const r = await fetch(API_BASE + path, { headers: session ? { "X-A2Med-Session": session } : {},
                                           credentials: "include" });
  if (r.status === 401) { sessionStorage.removeItem("a2med_proxy_session"); location.href = "./"; return 0; }
  if (!r.ok) throw new Error(`export en échec (HTTP ${r.status})`);
  const text = await r.text();
  const url = URL.createObjectURL(new Blob([text], { type: mime || "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return text.length;
}

async function ensureFreeSession() {
  const name = ($("freeSessionName").value || "").trim() || freeSessionDefault();
  $("freeSessionName").value = name;
  if ((STATE.freeSession || {}).name === name) return STATE.freeSession;
  try {
    const data = await api(`/api/eval/session/${encodeURIComponent(name)}`);
    STATE.freeSession = data.session;
  } catch (e) {
    if (e.http !== 404) throw e;
    STATE.freeSession = await api("/api/eval/session", { method: "POST",
      body: { name, kind: "free", mode: "standard", label: name } });
  }
  localStorage.setItem(LS.free, name);
  $("freeSessionState").textContent = STATE.freeSession.eval_kind === "free"
    ? "file de questions libres" : "ATTENTION : cette file existe déjà comme benchmark";
  await resumeFree(name, true);
  return STATE.freeSession;
}

async function resumeFree(name, keepCurrent) {
  const data = await api(`/api/eval/session/${encodeURIComponent(name)}`);
  STATE.freeSession = data.session;
  STATE.freeRows = {};
  for (const r of (data.runs || []).filter((r) => r.benchmark_id)) STATE.freeRows[r.benchmark_id] = r;
  STATE.taxonomy = data.taxonomy || STATE.taxonomy;
  renderFreeCodes();
  renderFreeList(keepCurrent);
}

function renderFreeCodes() {
  const box = $("freeCodes");
  if (box.dataset.built === (STATE.taxonomy || []).join(",")) return;
  box.innerHTML = (STATE.taxonomy || []).map((c) => `<label class="check">
      <input type="checkbox" value="${esc(c)}">`
      + `<span>${esc(window.A2MEDContract.taxLabel(c))} <code class="taxcode">${esc(window.A2MEDContract.taxUi(c))}</code></span></label>`).join("");
  box.dataset.built = (STATE.taxonomy || []).join(",");
}

function renderFreeList(keepCurrent) {
  const ids = Object.keys(STATE.freeRows).reverse();          // les plus récentes en tête
  const select = $("freeHistory");
  select.innerHTML = '<option value="">— question —</option>' + ids.map((id) => {
    const r = STATE.freeRows[id];
    return `<option value="${esc(id)}">${esc(r.verdict ? "✓" : (r.run_status ? "·" : " "))} ${
      esc(String(r.question || id).slice(0, 70))}</option>`;
  }).join("");
  const scored = ids.filter((id) => STATE.freeRows[id].verdict).length;
  $("freeCount").textContent = `${scored}/${ids.length} évaluées · file ${$("freeSessionName").value}`;
  if (STATE.freeCurrent && keepCurrent) select.value = STATE.freeCurrent;
}

function freeOutFromRow(row) {
  /* Une évaluation doit rester inspectable après rechargement : la ligne de session porte la
     réponse rendue, le statut, les sources du registre (doc/page/texte) et les latences. */
  let sources = [];
  try { sources = JSON.parse(row.sources_cited || "[]"); } catch { sources = []; }
  let claims = [];
  try { claims = row.claims_cited || []; } catch { claims = []; }
  const status = row.run_status === "SOURCES_ONLY" ? null : row.run_status;
  return { question: row.question, status, source_only: row.run_status === "SOURCES_ONLY",
           mode: row.mode, answer: claims, sources, limitations: [], reason: "",
           has_provisional_source: !!row.has_provisional_source, timings: row.timings || {},
           trace_id: row.trace_id,
           lineage: row.lineage || null, raw_generator_output: row.raw_generator_output || null,
           validated_output: row.validated_output || null,
           technique: { n_claims: row.n_claims, top5_pids: row.top5_passage_ids,
             gen_model: row.generator_label, retrieval_profile: row.retrieval_profile,
             context_k: row.context_k, generation_prompt_sha256: row.generation_prompt_sha256 } };
}

function renderFree(out, meta = {}) {
  const card = $("freeCard");
  card.hidden = false;
  const sourceOnly = !!out.source_only;
  const status = sourceOnly ? "SOURCES_ONLY" : out.status || "INCONNU";
  const [code, meaning] = STATUS_LABELS[status] || STATUS_LABELS.INCONNU;
  $("freeStatus").textContent = code;
  $("freeMeaning").textContent = meaning;
  $("freeMetaLine").textContent = answerMeta(out, meta);
  card.dataset.status = status;
  // trace_id / profil de recherche : technique, donc dans la table « Détails techniques »
  $("freeTrace").textContent = `trace ${out.trace_id || "—"} · mode ${out.mode || "—"} · `
    + `recherche ${(out.technique || {}).retrieval_profile || "hybrid"} · `
    + `${(out.technique || {}).context_k || 5} passages`;
  $("freeInspect").innerHTML = inspectionHtml(out);
  const banner = $("freeProvisional");
  banner.hidden = !out.has_provisional_source;
  banner.textContent = "Au moins une source citée est une recommandation en cours de publication : "
    + "à manier avec précaution (statut lu du registre, jamais du modèle).";
  $("freeAnswer").innerHTML = sourceOnly
    ? `<p class="lead sources-label"><strong>Recherche documentaire — aucune réponse générée.</strong>
       Les passages ci-dessous sont les plus pertinents du corpus ; aucun texte médical n'a été
       rédigé, aucun n'est validé.</p>`
    : (status === "ABSTENTION"
      ? `<p class="lead abstain"><strong>ABSTENTION.</strong> ${rich(out.reason || "")}</p>`
      : answerHtml(out.answer)
        + ((out.limitations || []).length
          ? `<ul class="limits">${out.limitations.map((l) => `<li>${rich(l)}</li>`).join("")}</ul>` : ""));
  $("freeSources").innerHTML = sourcesHtml(out.sources,
    sourceOnly ? "classés par pertinence, sans génération" : "citées par la réponse");
  // `techHtml` porte déjà la trace de la requête : un helper inexistant `tableHtml` cassait ici
  // toute la fin du rendu (le panneau d'évaluation ne se révélait plus). Trouvé par la sonde.
  $("freeTech").innerHTML = techHtml(out);
  $("freeScoring").hidden = false;
}

function freeRow(out, question) {
  const answer = out.answer || [];
  return {
    benchmark_id: out.trace_id || `F${Date.now()}`, question, trace_id: out.trace_id,
    ...inspectFields(out),
    mode: out.mode, run_status: out.status || (out.source_only ? "SOURCES_ONLY" : null),
    response: answer.length ? answer.map((a) => `• ${a.text}`).join("\n")
      : (out.source_only ? "[SOURCES_ONLY — aucune réponse générée]" : out.reason || ""),
    answer_chars: answer.length ? answer.reduce((n, a) => n + a.text.length, 0)
      : (out.source_only ? 0 : (out.reason || "").length),
    n_claims: (out.technique || {}).n_claims,
    claims_cited: answer.map((a) => ({ text: a.text, refs: a.refs, citation_valid: a.citation_valid })),
    top5_passage_ids: (out.technique || {}).top5_pids || [],
    top_context_pids: (out.technique || {}).top_context_pids || [],
    retrieval_profile: (out.technique || {}).retrieval_profile,
    context_k: (out.technique || {}).context_k,
    corpus_fingerprint: (STATE.health || {}).corpus_fingerprint,
    generator_label: ($("freeModel").selectedOptions[0] || {}).textContent || "flash (défaut)",
    generator_key: $("freeModel").value || null,
    source_statuses: (out.sources || []).map((s) => ({ ref: s.ref, passage_id: s.passage_id,
                                                      source_status: s.source_status })),
    sources_cited: JSON.stringify((out.sources || []).map((s) => ({
      ref: s.ref, passage_id: s.passage_id, document: s.document, page: s.page,
      source_status: s.source_status, excerpt: String(s.excerpt || "").slice(0, 600) }))),
    has_provisional_source: !!out.has_provisional_source,
    timings: { retrieval_s: (out.timings || {}).retrieval_s,
               generation_s: (out.timings || {}).generation_s, t_total_s: (out.timings || {}).t_total_s },
    generation_prompt_sha256: (out.technique || {}).generation_prompt_sha256,
    n_generator_calls: (out.technique || {}).n_generator_calls,
  };
}

async function runFree() {
  const question = $("freeQ").value.trim();
  if (!question) return notice("freeNotice", "Écrivez la question avant d'envoyer.", "warn");
  setBusy(true, "question en cours");
  notice("freeNotice", "", "info");
  $("freeCard").hidden = true; $("freeScoring").hidden = true;
  const timer = stageFlow("freeStage");
  try {
    await ensureFreeSession();
    const body = { question, mode: $("freeMode").value, eval_kind: "free" };
    if ($("freeModel").value) body.model = $("freeModel").value;
    const out = await api("/api/ask", { method: "POST", body });
    STATE.freeCurrent = out.trace_id;
    renderFree(out);
    const row = freeRow(out, question);
    const res = await api(`/api/eval/session/${encodeURIComponent(STATE.freeSession.name)}/run`,
      { method: "POST", body: row });
    STATE.freeRows[row.benchmark_id] = { ...row, verdict: null, codes: [], note: "" };
    if (res.row && res.row.verdict) STATE.freeRows[row.benchmark_id].verdict = res.row.verdict;
    renderFreeList(true);
    loadFreeScoreForm();
    $("freeSaved").textContent = "question enregistrée — évaluez-la ci-dessous";
  } catch (e) {
    notice("freeNotice", e.message + (e.body && e.body.detail ? ` — ${e.body.detail}` : ""), "error");
  } finally { stageEnd("freeStage", timer); setBusy(false); }
}

function selectFree(id) {
  const row = STATE.freeRows[id];
  if (!row) return;
  STATE.freeCurrent = id;
  $("freeQ").value = row.question || "";
  renderFree(freeOutFromRow(row), { restored: true });
  loadFreeScoreForm();
}

function moveFree(delta) {
  const ids = Object.keys(STATE.freeRows).reverse();
  if (!ids.length) return;
  let i = STATE.freeCurrent ? ids.indexOf(STATE.freeCurrent) : -1;
  i = Math.max(0, Math.min(ids.length - 1, i + delta));
  $("freeHistory").value = ids[i];
  selectFree(ids[i]);
}

function currentFreeCodes() {
  return [...document.querySelectorAll("#freeCodes input:checked")].map((b) => b.value);
}

function loadFreeScoreForm() {
  const row = STATE.freeRows[STATE.freeCurrent] || {};
  document.querySelectorAll("#freeCodes input").forEach((b) =>
    b.checked = (row.codes || []).includes(b.value));
  syncChips("freeCodes", "freeSimpleCodes");
  document.querySelectorAll("#freeVerdicts button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.verdict === (row.verdict || null))));
  setFreeRadio("freeSourcesUseful", row.sources_useful || null);
  setFreeRadio("freeVerbose", row.verbose || null);
  $("freeNote").value = row.note || "";
  $("freeSaved").textContent = row.scored_at ? `évaluée ${row.scored_at}` : "";
}

async function postFreeScore(patch) {
  if (!STATE.freeSession || !STATE.freeCurrent) {
    return notice("freeNotice", "Posez d'abord la question.", "warn");
  }
  const row = STATE.freeRows[STATE.freeCurrent] || {};
  const body = { benchmark_id: STATE.freeCurrent, trace_id: row.trace_id || STATE.freeCurrent,
                 question: row.question || $("freeQ").value,
                 verdict: row.verdict || null, codes: currentFreeCodes(), note: $("freeNote").value,
                 sources_useful: freeRadio("freeSourcesUseful"), verbose: freeRadio("freeVerbose"),
                 ...patch };
  try {
    await api(`/api/eval/session/${encodeURIComponent(STATE.freeSession.name)}/score`,
      { method: "POST", body });
    Object.assign(STATE.freeRows[STATE.freeCurrent] = row, {
      verdict: body.verdict, codes: body.codes, note: body.note,
      sources_useful: body.sources_useful, verbose: body.verbose });
    $("freeSaved").textContent = `enregistrée ${new Date().toLocaleTimeString()}`;
    renderFreeList(true);
  } catch (e) {
    $("freeSaved").textContent = "ÉCHEC d'enregistrement : " + e.message;
  }
}

function setFreeVerdict(verdict) {
  if (!STATE.freeCurrent) return notice("freeNotice", "Posez d'abord la question.", "warn");
  document.querySelectorAll("#freeVerdicts button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.verdict === verdict)));
  postFreeScore({ verdict });
}

function exportFree(fmtWanted) {
  if (!STATE.freeSession) return notice("freeNotice", "Aucune file de questions libres.", "warn");
  const n = STATE.freeSession.name;
  return downloadText(`/api/eval/export/${encodeURIComponent(n)}?format=${fmtWanted}`,
    `${n}.${fmtWanted}`, fmtWanted === "csv" ? "text/csv" : "application/x-ndjson")
    .then((chars) => notice("freeNotice", `Export ${fmtWanted} téléchargé (${chars} caractères).`, "info"))
    .catch((e) => notice("freeNotice", e.message, "error"));
}

function exportBenchmark(fmtWanted) {
  if (!STATE.session) return notice("runNotice", "Reprenez une session de benchmark.", "warn");
  const n = STATE.session.name;
  return downloadText(`/api/eval/export/${encodeURIComponent(n)}?format=${fmtWanted}`,
    `${n}.${fmtWanted}`, fmtWanted === "csv" ? "text/csv" : "application/x-ndjson")
    .then((chars) => notice("runNotice", `Export ${fmtWanted} téléchargé (${chars} caractères).`, "info"))
    .catch((e) => notice("runNotice", e.message, "error"));
}

function openReport() {
  if (!STATE.session) return notice("runNotice", "Reprenez une session de benchmark.", "warn");
  const n = STATE.session.name;
  return downloadText(`/api/eval/aggregate?sessions=${encodeURIComponent(n)}`, `${n}-rapport.md`,
    "text/markdown")
    .then(() => notice("runNotice", "Rapport téléchargé (deux familles rendues séparément).", "info"))
    .catch((e) => notice("runNotice", e.message, "error"));
}

document.addEventListener("DOMContentLoaded", () => {
  $("freeSessionName").value = localStorage.getItem(LS.free) || freeSessionDefault();
  $("freeAsk").addEventListener("click", runFree);
  $("freePrev").addEventListener("click", () => moveFree(-1));
  $("freeNext").addEventListener("click", () => moveFree(1));
  $("freeHistory").addEventListener("change", (e) => selectFree(e.target.value));
  $("freeSessionName").addEventListener("change", () => {
    STATE.freeSession = null; ensureFreeSession().catch((e) => notice("freeNotice", e.message, "error"));
  });
  $("freeVerdicts").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-verdict]");
    if (b) setFreeVerdict(b.dataset.verdict);
  });
  $("freeCodes").addEventListener("change", () => postFreeScore({}));
  $("freeNote").addEventListener("input", () => {
    window.clearTimeout(window.__freeNoteTimer);
    window.__freeNoteTimer = window.setTimeout(() => postFreeScore({}), 500);
  });
  document.querySelectorAll("input[name=freeSourcesUseful], input[name=freeVerbose]")
    .forEach((r) => r.addEventListener("change", () => postFreeScore({})));
  $("freeSaveNext").addEventListener("click", async () => {
    await postFreeScore({});
    $("freeQ").value = ""; $("freeCard").hidden = true; $("freeScoring").hidden = true;
    STATE.freeCurrent = null; $("freeHistory").value = "";
    $("freeQ").focus();
  });
  $("freeExportJsonl").addEventListener("click", () => exportFree("jsonl"));
  $("freeExportCsv").addEventListener("click", () => exportFree("csv"));
  $("exportJsonl").addEventListener("click", () => exportBenchmark("jsonl"));
  $("exportCsv").addEventListener("click", () => exportBenchmark("csv"));
  $("reportBtn").addEventListener("click", openReport);
  if (localStorage.getItem(LS.free)) {
    ensureFreeSession().catch(() => { /* service éteint : la page reste utilisable */ });
  }
});
