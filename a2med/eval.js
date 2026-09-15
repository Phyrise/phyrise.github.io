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
const LS = { labels: "a2med_eval_labels_v1", last: "a2med_eval_last_session_v1" };

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
  const response = await fetch(API_BASE + path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "include",
  });
  if (response.status === 401) {
    // La page eval n'a pas de gate : 401 (visite froide ou session morte)
    // → retour à la page principale où le gate redemande le mot de passe.
    sessionStorage.removeItem("a2med_proxy_session");
    location.href = "./";
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: "réponse non JSON du service", code: "serveur" }; }
  if (!response.ok) {
    const err = new Error((data && data.error) || `erreur HTTP ${response.status}`);
    err.code = data && data.code; err.http = response.status; err.body = data;
    throw err;
  }
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
  const s = STATE.session, head = $("sessionHead");
  if (!s) { head.hidden = true; $("footSession").textContent = "aucune session chargée"; return; }
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
    ["générateur", esc(($("runModel").selectedOptions[0] || {}).textContent || "—")],
    ["horodatage", esc(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC")],
  ].map(([k, v]) => `<p class="kv"><span>${k}</span>${v}</p>`).join("");
  $("footSession").innerHTML = `${esc(s.name)} · jeu ${esc(String(s.benchmark_sha256 || "").slice(0, 12))}…`
    + ` · HEAD <code>${esc(h.git_head || "—")}</code> · corpus <code>${esc(String(fp).slice(0, 12))}…</code>`
    + ` · ${esc(s.retrieval_config_id || "")}`;
  $("sessionRename").disabled = $("sessionReset").disabled = false;
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
      name, benchmark, benchmark_sha256: b.sha256, mode: $("newSessionMode").value, label: name } });
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
  filterCode.innerHTML = '<option value="">sans filtre de code</option>'
    + [...codes].sort().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
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
  if (run) renderRunResult(run, { restored: true });
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
  const mode = $("runMode").value;
  const body = { question: STATE.current.question, mode };
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
  return `<details class="sources" open><summary>${sources.length} source${sources.length > 1 ? "s" : ""}`
    + ` <span class="fine">${esc(note || "")}</span></summary>` + sources.map((s) => `
      <article class="source-card">
        <header><strong>${esc(s.ref || "")}</strong> ${esc(s.document || "")}
          <span class="mono">p. ${esc(s.page ?? "—")}</span>
          <span class="badge ${s.source_status === "prepublication_recommendation" ? "warn" : "ok"}">${
            s.source_status === "prepublication_recommendation" ? "pré-publication" : "publié final"}</span>
          <span class="badge neutral">${esc((s.societies || [s.source_authority]).join("/"))}</span>
        </header>
        <p class="excerpt">${rich(s.excerpt)}</p>
        <p class="fine mono">${esc(s.passage_id || "")}${s.rerank_score != null ? ` · rerank ${fmt(s.rerank_score, 4)}` : ""}</p>
      </article>`).join("") + `</details>`;
}

function techHtml(out) {
  const t = out.technique || {}, ti = out.timings || {};
  const rows = [
    ["statut", esc(out.status || (out.source_only ? "SOURCES_ONLY" : "—"))],
    ["statut demandé par le modèle", esc(out.status_requested || "—")],
    ["n_claims", t.n_claims], ["toutes citations valides", String(t.claims_all_valid)],
    ["passages dans le contexte", (t.top5_pids || []).length],
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

function renderRunResult(out, meta = {}) {
  const card = $("runCard");
  card.hidden = false;
  const sourceOnly = !!out.source_only;
  const status = sourceOnly ? "SOURCES_ONLY" : out.status || "INCONNU";
  const labels = {
    ANSWER: ["Réponse", "fondée sur les sources locales"],
    CONDITIONAL_ANSWER: ["Réponse conditionnelle", "partielle ou à conditions — lire les limites"],
    ABSTENTION: ["ABSTENTION", "le système ne répond pas avec les preuves locales"],
    SOURCES_ONLY: ["Recherche documentaire", "aucune réponse générée"],
    INCONNU: ["statut non reconnu", "rien n'affiché faute de statut lisible"],
  };
  const [code, meaning] = labels[status] || labels.INCONNU;
  $("runStatus").textContent = code;
  $("runMeaning").textContent = meaning;
  $("runTime").textContent = fmt((out.timings || {}).t_total_s) + " s"
    + (meta.restored ? " (run retrouvé)" : "");
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
  $("runTech").innerHTML = techHtml(out);
  STATE.lastRun = out;
  if (meta.record !== false) {
    STATE.progress[STATE.current && STATE.current.id] = {
      ...STATE.progress[STATE.current.id], done: true,
    };
    renderQuestionList();
  }
}

function runRow(out) {
  const answer = out.answer || [];
  return {
    benchmark_id: (STATE.current || {}).id, question: out.question,
    benchmark_sha256: (STATE.session || {}).benchmark_sha256,
    run_id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    corpus_fingerprint: (STATE.health || {}).corpus_fingerprint,
    generator_label: ($("runModel").selectedOptions[0] || {}).textContent || "flash (défaut)",
    mode: out.mode || $("runMode").value, run_status: out.status || (out.source_only ? "SOURCES_ONLY" : null),
    response: answer.length ? answer.map((a) => `• ${a.text}`).join("\n")
      : (out.source_only ? "[SOURCES_ONLY — aucune réponse générée]" : out.reason || ""),
    answer_chars: answer.length ? answer.reduce((n, a) => n + a.text.length, 0) : (out.source_only ? 0 : (out.reason || "").length),
    n_claims: (out.technique || {}).n_claims,
    claims_cited: answer.map((a) => ({ text: a.text, refs: a.refs, citation_valid: a.citation_valid })),
    top5_passage_ids: (out.technique || {}).top5_pids || [],
    source_statuses: (out.sources || []).map((s) => ({ ref: s.ref, passage_id: s.passage_id,
                                                      source_status: s.source_status,
                                                      authority: s.source_authority })),
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
function renderCodes() {
  const list = $("codeList");
  if (list.dataset.built) return;
  list.innerHTML = (STATE.taxonomy.length ? STATE.taxonomy : []).map((code) =>
    `<label class="check"><input type="checkbox" value="${esc(code)}"><span>${esc(code)}</span></label>`
  ).join("");
  list.dataset.built = "1";
}

function loadScoreForm() {
  renderCodes();
  const row = STATE.runs[(STATE.current || {}).id] || {};
  document.querySelectorAll("#codeList input").forEach((box) => {
    box.checked = (row.codes || []).includes(box.value);
  });
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
  document.querySelectorAll(".verdicts button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.verdict === verdict)));
  postScore({ verdict, codes: currentCodes(), note: $("noteBox").value });
  window.setTimeout(() => move(1), 250);
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
  const box = $("cmpGenerators");
  box.innerHTML = STATE.generators.map((g, i) => `<label class="check gen${g.available ? "" : " off"}">
      <input type="checkbox" value="${esc(g.key)}" ${i === 0 || (g.available && i < 3) ? "checked" : ""}
        ${g.available ? "" : "disabled"}>
      <span>${esc(g.label)}</span>
      <small>${g.available ? `modèle ${esc(g.model || "?")} · sonde ${fmt(g.t_probe_s, 2)}s`
        : `INDISPONIBLE (${esc(g.error || "sonde en échec")})`}</small>
    </label>`).join("");
  const select = $("runModel");
  if (select && !select.options.length) {
    select.innerHTML = '<option value="">défaut (pipeline)</option>' + STATE.generators.map((g) =>
      `<option value="${esc(g.key)}" ${g.available ? "" : "disabled"}>${esc(g.label)}${
        g.available ? "" : " (indisponible)"}</option>`).join("");
  }
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

async function runCompare(keepRetrieval) {
  const question = ($("cmpFree").value.trim()
    || (STATE.current && STATE.current.question) || "").trim();
  if (!question) return notice("cmpNotice", "Aucune question : sélectionnez-en une ou écrivez-la.", "warn");
  const keys = chosenGenerators();
  if (!keys.length) return notice("cmpNotice", "Cochez au moins un générateur disponible.", "warn");
  notice("cmpNotice", "", "info");
  const tokenBox = $("cmpFrozen");
  let retrieval = STATE.cmpRetrieval;
  setBusy(true, "retrieval en cours");
  if (!keepRetrieval || !retrieval) {
    try {
      retrieval = await api("/api/eval/retrieval", { method: "POST", body: { question } });
      STATE.cmpRetrieval = retrieval;
    } catch (e) {
      setBusy(false);
      return notice("cmpNotice", "Retrieval en échec : " + e.message, "error");
    }
  }
  setBusy(false);
  const labels = labelsFor(question, keys.length);
  const mapping = {};
  const panels = $("cmpPanels");
  panels.innerHTML = "";
  $("cmpQuestion").textContent = question;
  STATE.cmpShas = {};
  STATE.cmpFrozenBase = retrieval.source_token
    ? `top-5 figé · ${((retrieval.technique || {}).top5_pids || []).length} passages · `
      + `retrieval ${fmt((retrieval.timings || {}).retrieval_s)} s · mode sources, appel générateur `
      + `compté à ${retrieval.n_generator_calls ?? "—"} par le daemon`
    : "aucun jeton de retrieval reçu : relancez";
  tokenBox.textContent = STATE.cmpFrozenBase;
  const blind = $("cmpBlind").checked;
  const qid = (STATE.current || {}).id || "libre";
  STATE.cmpExpectedSha = null;               // le SHA du prompt se vérifie panneau par panneau
  keys.forEach((key, i) => {
    const label = labels[i];
    mapping[label] = key;
    const article = document.createElement("article");
    article.className = "panel cmp-card";
    article.dataset.label = label;
    article.innerHTML = `<header><span class="cmp-label">Panneau ${esc(label)}</span>
        <span class="cmp-id" hidden>${esc((STATE.generators.find((g) => g.key === key) || {}).label || key)}</span>
        <span class="status mono">…</span></header>
      <div class="body"><p class="fine">génération en cours…</p></div>
      <div class="verdicts" role="group" aria-label="Décision pour le panneau ${esc(label)}">
        ${["correct", "partial", "incorrect", "cannot_assess"].map((v) =>
          `<button type="button" data-verdict="${v}">${v}</button>`).join("")}
      </div>
      <label class="field-label">note</label>
      <textarea rows="2" class="note"></textarea>
      <p class="fine saved"></p>`;
    panels.appendChild(article);
    article.querySelectorAll(".verdicts button").forEach((b) => b.addEventListener("click", () => {
      article.querySelectorAll(".verdicts button").forEach((x) =>
        x.setAttribute("aria-pressed", String(x === b)));
      savePanel(qid, label, key, { verdict: b.dataset.verdict, note: article.querySelector(".note").value });
      maybeReveal();
    }));
    article.querySelector(".note").addEventListener("change", () => {
      savePanel(qid, label, key, { note: article.querySelector(".note").value });
    });
    generateInto(article, key, label, question, retrieval, qid, blind);
  });
  STATE.cmpMapping = mapping;
  STATE.cmpQuestionId = qid;
}

async function generateInto(article, key, label, question, retrieval, qid, blind) {
  const body = article.querySelector(".body"), status = article.querySelector(".status");
  const gen = STATE.generators.find((g) => g.key === key) || {};
  try {
    if (!retrieval.source_token) throw new Error("jeton de retrieval absent (reproduction gelée)");
    const out = await api("/api/eval/generate", { method: "POST", body: {
      question, source_token: retrieval.source_token, generator: key,
      mode: $("cmpMode").value,
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
      timings: { retrieval_s: (retrieval.timings || {}).retrieval_s,
                 generation_s: (out.timings || {}).generation_s, t_total_s: (out.timings || {}).t_total_s },
      generation_prompt_sha256: sha,
      top5_passage_ids: (out.technique || {}).top5_pids || [],
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
                 generator_key: blind ? null : generatorKey, ...patch };
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
      const body = { question, mode };
      if ($("runModel").value) body.model = $("runModel").value;
      const out = await api("/api/ask", { method: "POST", body });
      renderModePanel(article, out);
      await savePanel(qid, `mode-${mode}`, null, {
        run_status: out.status || (out.source_only ? "SOURCES_ONLY" : null),
        mode, response: (out.answer || []).map((a) => `• ${a.text}`).join("\n")
          || (out.source_only ? "[SOURCES_ONLY]" : out.reason || ""),
        answer_chars: (out.answer || []).reduce((n, a) => n + a.text.length, 0)
          || (out.question || "").length,
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
    const out = await api("/api/eval/lab", { method: "POST", body: { question } });
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
      setVerdict(["correct", "partial", "incorrect", "cannot_assess"][Number(event.key) - 1]);
      event.preventDefault();
    } else if (event.key === "e") { $("noteBox").focus(); event.preventDefault(); }
  }
});

function showTab(tab) {
  if (!["run", "compare", "modes", "lab"].includes(tab)) tab = "run";
  STATE.tab = tab;
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
  await loadHealth();
  try {
    const g = await api("/api/eval/generators");
    STATE.generators = g.generators || [];
    STATE.taxonomy = g.taxonomy || STATE.taxonomy;
    renderGenerators();
    renderCodes();
  } catch (e) { STATE.generators = []; renderGenerators(); }
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
