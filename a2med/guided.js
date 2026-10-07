/* Guidé — prototype d'expérience (mission guided-clarification-001).
   Le front ne sait rendre QUE quatre types de contrôle fermés. Aucun HTML, aucun texte
   libre, aucune valeur non contrôlée ne vient du modèle : tout passe par textContent. */
const API = String(document.body.dataset.api || window.A2MED_API_BASE || "").replace(/\/$/, "");
const TYPES = ["yes_no_unknown", "threshold_choice", "numeric", "enum"];
const $ = (id) => document.getElementById(id);
// A laboratory proxy has its own session; never overwrite Consultation/Expert.
const SESSION_KEY = "a2med_guided_session:" + (API || window.location.origin);
let READY = false, BUSY = false;
const sessionRead = () => { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } };
const sessionWrite = value => { try {
  if (value) sessionStorage.setItem(SESSION_KEY, value); else sessionStorage.removeItem(SESSION_KEY);
} catch { /* The proxy cookie can still work. */ } };
function controls() {
  ["gGo", "gGo2", "gModeB"].forEach(id => { $(id).disabled = !READY || BUSY; });
  $("gq").disabled = BUSY;
  $("gReset").disabled = BUSY;
  $("gFields").querySelectorAll("fieldset").forEach(field => { field.disabled = BUSY; });
  $("gForm").setAttribute("aria-busy", String(BUSY));
  $("gClar").setAttribute("aria-busy", String(BUSY));
}
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const session = sessionRead();
  if (session) headers["X-A2Med-Session"] = session;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path.includes("/api/guided/ask")
    || path.includes("/api/guided/turn2") ? 180000 : 20000);
  try { return await fetch(API + path, { ...options, headers, credentials: "include", signal: controller.signal }); }
  catch (error) {
    throw new Error(error.name === "AbortError" ? "Le service ne répond pas dans le délai prévu. Réessayez."
      : "Impossible de joindre le mode Guidé. Réessayez la connexion au service.");
  } finally { clearTimeout(timer); }
}

async function post(path, body) {
  const headers = { "Content-Type": "application/json" };
  // La frontière publique est un proxy qui accepte la session par cookie (desktop) OU par
  // en-tête (mobile : les cookies tierces sont bloqués) — même contrat que la page Expert.
  const r = await apiFetch(path, {
    method: "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 || r.status === 403) {
    sessionWrite(null);
    const e = new Error("Accès requis pour le mode Guidé."); e.code = "auth"; throw e;
  }
  const j = await r.json().catch(() => { throw new Error("Le service a renvoyé une réponse illisible. Réessayez la connexion."); });
  if (!r.ok) {
    const message = j.code === "session_inconnue" ? "La session a expiré. Lancez une nouvelle question."
      : r.status === 409 ? "Une question est déjà en cours. Attendez sa réponse avant de continuer."
      : j.error || `Le service a refusé la demande (${r.status}).`;
    throw new Error(message);
  }
  return j;
}

function montrerGate(msg) {
  READY = false; controls();
  $("healthText").textContent = "Accès requis";
  $("gAuth").classList.remove("g-hidden");
  $("gAuthErr").textContent = msg || "";
  $("gMdp").focus();
}

async function authentifier(mot) {
  let r;
  try {
    r = await apiFetch("/__auth", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: mot }) });
  } catch { return "Service injoignable — le tunnel du laboratoire est peut-être éteint."; }
  if (!r.ok) return "Mot de passe refusé.";
  const d = await r.json().catch(() => null);
  if (d && d.session) sessionWrite(d.session);
  $("gMdp").value = "";
  $("gAuth").classList.add("g-hidden");
  return null;
}

$("gAuth").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if ($("gAuthGo").disabled) return;
  $("gAuthGo").disabled = true;
  try {
    const pb = await authentifier($("gMdp").value);
    $("gAuthErr").textContent = pb || "";
    if (!pb) { await santé(); if (READY) $("gq").focus(); }
  } finally { $("gAuthGo").disabled = false; }
});

const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = String(txt);
  return e;
};

function badge(node, status) {
  const labels = { ANSWER: "Réponse", CONDITIONAL_ANSWER: "Réponse conditionnelle",
                   CLARIFICATION: "Précisions nécessaires", ABSTENTION: "Sans réponse sûre" };
  node.textContent = labels[status] || status;
  node.className = "g-status g-status-" + status;
}

/* Sources : citations lues du registre (doc + page + extrait brut, aucun nettoyage modèle). */
function renderSources(hote, sources) {
  if (!sources || !sources.length) return;
  const box = el("div");
  box.append(el("p", "g-fine", "Sources"));
  sources.forEach((s) => {
    const d = el("section", "g-src");
    d.append(el("p", null, `${s.ref} · ${s.document} · repère du registre ${s.page}`));
    if (window.A2MEDDocumentView) d.append(window.A2MEDDocumentView.monter(API,
      { document: s.document, page: s.page }, { apiFetch }));
    const text = el("details", "g-source-text");
    text.append(el("summary", null, "Texte extrait de la preuve"), el("p", "g-quote", s.excerpt));
    d.append(text);
    box.append(d);
  });
  hote.append(box);
}

function renderAnswer(hote, out) {
  if (window.A2MEDDocumentView) window.A2MEDDocumentView.nettoyer(hote);
  hote.textContent = "";
  (out.claims || []).forEach((c) => {
    const p = el("p", "g-claim", c.claim);
    (c.refs || []).forEach((r) => p.append(el("sup", "g-ref", r)));
    hote.append(p);
  });
  if ((out.limitations || []).length) {
    hote.append(el("p", "g-fine", "Limites et conditions"));
    const ul = el("ul", "g-list");
    out.limitations.forEach((l) => ul.append(el("li", null, l)));
    hote.append(ul);
  }
  if (out.status === "ABSTENTION" && out.reason) hote.append(el("p", "g-fine", out.reason));
  const refs = new Set((out.claims || []).flatMap(c => c.refs || []));
  renderSources(hote, (out.sources || []).filter(s => refs.has(s.ref)));
}

/* Le passage qui rend la question décisionnelle : citation brute du registre récupéré. */
function preuvePourquoi(sources, evidence) {
  const d = el("details", "g-why");
  d.append(el("summary", null, "Pourquoi ?"));
  const wrap = el("div");
  (evidence || []).forEach((alias) => {
    const n = parseInt(String(alias).replace(/\D/g, ""), 10);
    const s = (sources || []).find((x) => x.retrieval_rank === n);
    wrap.append(el("p", "g-fine", s ? `Source de cette question : ${s.document}, repère ${s.page}`
                                    : `Source de cette question : ${alias}`));
    if (s) renderSources(wrap, [s]);
  });
  d.append(wrap);
  return d;
}

/* Un seul vocabulaire de contrôle ; tout le reste est refusé à l'affichage, pas réparé. */
function champClarification(c, i) {
  const ctrl = c.control || {};
  if (!TYPES.includes(ctrl.type)) {
    return el("p", "g-fine", `Question non affichée : type de contrôle non reconnu`);
  }
  const fs = el("fieldset", "g-field");
  const legend = el("legend", null, (c.question || "").trim() || "Précision");
  fs.append(legend);
  const name = `f${i}`;
  if (ctrl.type === "yes_no_unknown") {
    const row = el("div", "g-opts");
    [["non", "Non"], ["oui", "Oui"], ["inconnu", "Inconnu"]].forEach(([v, label]) => {
      const id = `${name}-${v}`;
      const input = el("input");
      Object.assign(input, { type: "radio", name, value: v, id });
      const lab = el("label", null);
      lab.append(input, el("span", null, label));
      row.append(lab);
    });
    fs.append(row);
  } else if (ctrl.type === "threshold_choice" || ctrl.type === "enum") {
    const row = el("div", "g-opts");
    (ctrl.options || []).forEach((o, k) => {
      const valeur = typeof o === "string" ? o : String(o.value ?? "");
      const libelle = typeof o === "string" ? o : String(o.label ?? valeur);
      if (!libelle.trim()) return;
      const id = `${name}-${k}`;
      const input = el("input");
      Object.assign(input, { type: "radio", name, value: valeur, id });
      const lab = el("label", null);
      lab.append(input, el("span", null, libelle));
      row.append(lab);
    });
    fs.append(row);
  } else {
    const row = el("div", "g-num");
    const input = el("input");
    Object.assign(input, { type: "text", inputMode: "decimal", name, id: name,
                           autocomplete: "off", pattern: "[0-9]{1,3}([.,][0-9]{1,2})?",
                           placeholder: "valeur" });
    const lab = el("label", null, c.control.unit || "");
    lab.htmlFor = name;
    const inconnu = el("label", "g-unknown");
    const r = el("input");
    Object.assign(r, { type: "radio", name, value: "inconnu", id: `${name}-inconnu` });
    input.addEventListener("input", () => { r.checked = false; });
    r.addEventListener("change", () => { if (r.checked) input.value = ""; });
    inconnu.append(r, el("span", null, "Inconnu"));
    row.append(input, lab, inconnu);
    fs.append(row);
  }
  fs.append(preuvePourquoi(PREUVES, c.evidence));
  fs.dataset.factor = c.factor || name;
  fs.dataset.type = ctrl.type;
  return fs;
}

let PREUVES = [], TRACE = null;

function afficherClarifications(out) {
  PREUVES = out.sources || [];
  TRACE = out.trace_id;
  const h = $("gFields");
  if (window.A2MEDDocumentView) window.A2MEDDocumentView.nettoyer(h);
  h.textContent = "";
  (out.clarifications || []).slice(0, 3).forEach((c, i) => h.append(champClarification(c, i)));
  $("gClar").classList.remove("g-hidden");
}

function lireReponses() {
  const answers = {}, manquants = [];
  $("gFields").querySelectorAll("fieldset.g-field").forEach((fs) => {
    const name = fs.dataset.factor;
    let valeur = null;
    if (fs.dataset.type === "numeric") {
      const texte = (fs.querySelector("input[type=text]") || {}).value || "";
      const coche = fs.querySelector("input[type=radio]:checked");
      if (coche) valeur = coche.value;
      else if (/^\d{1,3}([.,]\d{1,2})?$/.test(texte.trim())) valeur = texte.trim();
    } else {
      const coche = fs.querySelector("input:checked");
      if (coche) valeur = coche.value;
    }
    if (valeur === null) manquants.push(name);
    else answers[name] = valeur;
  });
  return { answers, manquants };
}

async function tour2(mode, bouton) {
  if (BUSY || !READY || !TRACE) return;
  const { answers, manquants } = lireReponses();
  if (manquants.length) {
    $("gProg").textContent = `Une réponse manque pour ${manquants.length} précision(s) — `
      + `« Inconnu » est une réponse.`;
    return;
  }
  BUSY = true; controls();
  $("gProg").textContent = "Rédaction de la réponse à partir des précisions et des sources…";
  try {
    const out = await post("/api/guided/turn2", { trace_id: TRACE, answers, mode });
    $("gBloc").textContent = out.bloc || "";
    badge($("gBadge2"), out.status);
    renderAnswer($("gBody2"), out);
    $("gFinal").classList.remove("g-hidden");
    $("gClar").classList.add("g-hidden");
    $("gOut").classList.add("g-hidden");
    $("gProg").textContent = `Réponse prête · recherche ${out.timings.retrieval_s} s · rédaction ${out.timings.generation_s} s.`;
    // jsdom (le selfcheck) n'implémente pas le défilement : on ne le simule pas ici.
    const cible = $("gFinal");
    if (typeof cible.scrollIntoView === "function") cible.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e.code === "auth") { montrerGate(e.message); return; }
    $("gProg").textContent = String(e.message || e);
  } finally {
    BUSY = false; controls();
  }
}

$("gForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (BUSY || !READY) return;
  const q = $("gq").value.trim();
  if (!q) return;
  BUSY = true; controls();
  TRACE = null; PREUVES = [];
  [$("gBody"), $("gBody2"), $("gFields")].forEach(node => {
    if (window.A2MEDDocumentView) window.A2MEDDocumentView.nettoyer(node);
    node.textContent = "";
  });
  $("gClar").classList.add("g-hidden");
  $("gFinal").classList.add("g-hidden");
  $("gOut").classList.add("g-hidden");
  $("gProg").textContent = "Recherche des sources et analyse des précisions utiles…";
  try {
    const out = await post("/api/guided/ask", { question: q });
    $("gProg").textContent = out.guided_refuse
      ? "Questions non retenues par le contrôle de forme — réponse standard."
      : `Recherche ${out.timings.retrieval_s} s · analyse ${out.timings.generation_s} s.`;
    badge($("gBadge"), out.status);
    $("gOut").classList.remove("g-hidden");
    if (out.status === "CLARIFICATION" && (out.clarifications || []).length) {
      $("gBody").textContent = "";
      $("gBody").append(el("p", "g-fine",
        "Les passages décrivent plusieurs conduites selon une information absente de la question."));
      afficherClarifications(out);
      $("gClar").scrollIntoView?.({ behavior: "smooth", block: "start" });
    } else {
      // aucune question en attente : on vide le formulaire du tour précédent, sinon un
      // « Continuer » fantôme survivrait caché sous la nouvelle réponse.
      $("gFields").textContent = "";
      $("gClar").classList.add("g-hidden");
      renderAnswer($("gBody"), out);
    }
  } catch (e) {
    if (e.code === "auth") { montrerGate(e.message); return; }
    $("gProg").textContent = String(e.message || e);
  } finally {
    BUSY = false; controls();
  }
});
$("gq").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("gForm").requestSubmit(); }
});
$("gClar").addEventListener("submit", (ev) => { ev.preventDefault(); tour2("A", $("gGo2")); });
$("gModeB").addEventListener("click", () => tour2("B", $("gModeB")));

/* A shared URL can prefill a question, never submit or invent practitioner answers. */
async function auto() {
  const u = new URL(window.location.href);
  const q = u.searchParams.get("q");
  if (!q) return;
  $("gq").value = q;
  // A URL may prefill a question; it must never choose a patient fact or submit it.
}

async function santé() {
  // Le front Guidé sonde SON chemin : une instance de laboratoire qui n'est pas
  // propriétaire du démon rendrait « service indisponible » sur la santé du produit.
  try {
    $("healthText").textContent = "Vérification du service…";
    const r = await apiFetch("/api/guided/health");
    if (r.status === 401 || r.status === 403) { sessionWrite(null); montrerGate("Utilisez le code d’accès au mode Guidé."); return; }
    if (!r.ok) throw new Error("Service indisponible");
    const h = await r.json().catch(() => ({}));
    READY = h.ok === true;
    $("healthText").textContent = READY ? "Guidé prêt" : "Moteur indisponible";
    $("gProg").textContent = READY ? "" : "Le moteur n’est pas disponible. Réessayez la connexion.";
    $("health").classList.toggle("is-ready", READY);
  } catch {
    READY = false; $("healthText").textContent = "Service injoignable";
    $("gProg").textContent = "Le mode Guidé ne répond pas. Réessayez la connexion.";
  } finally {
    controls();
    $("gHealthRetry").hidden = READY || !$("gAuth").classList.contains("g-hidden");
  }
}
$("gHealthRetry").addEventListener("click", santé);

$("gReset").addEventListener("click", () => {
  if (BUSY) return;
  TRACE = null; PREUVES = [];
  ["gOut", "gClar", "gFinal"].forEach(id => $(id).classList.add("g-hidden"));
  ["gBody", "gBody2", "gFields"].forEach(id => {
    if (window.A2MEDDocumentView) window.A2MEDDocumentView.nettoyer($(id));
    $(id).textContent = "";
  });
  $("gq").value = ""; $("gProg").textContent = ""; $("gq").focus();
});

santé();

auto().catch(() => {});
