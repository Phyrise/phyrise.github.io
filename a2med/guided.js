/* Guidé — prototype d'expérience (mission guided-clarification-001).
   Le front ne sait rendre QUE quatre types de contrôle fermés. Aucun HTML, aucun texte
   libre, aucune valeur non contrôlée ne vient du modèle : tout passe par textContent. */
const API = String(document.body.dataset.api || window.A2MED_API_BASE || "").replace(/\/$/, "");
const TYPES = ["yes_no_unknown", "threshold_choice", "numeric", "enum"];
const $ = (id) => document.getElementById(id);

async function post(path, body) {
  const headers = { "Content-Type": "application/json" };
  // La frontière publique est un proxy qui accepte la session par cookie (desktop) OU par
  // en-tête (mobile : les cookies tierces sont bloqués) — même contrat que la page Expert.
  const session = sessionStorage.getItem("a2med_proxy_session");
  if (session) headers["X-A2Med-Session"] = session;
  const r = await fetch(API + path, {
    method: "POST", headers, credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) {                        // le gate est ici, pas un écran mort sans motif
    sessionStorage.removeItem("a2med_proxy_session");
    const e = new Error("Mot de passe requis pour le laboratoire."); e.code = "auth"; throw e;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `service ${r.status}`);
  return j;
}

function montrerGate(msg) {
  $("gAuth").classList.remove("g-hidden");
  $("gAuthErr").textContent = msg || "";
  $("gMdp").focus();
}

async function authentifier(mot) {
  let r;
  try {
    r = await fetch(API + "/__auth", { method: "POST",
      headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ password: mot }) });
  } catch { return "Service injoignable — le tunnel du laboratoire est peut-être éteint."; }
  if (!r.ok) return "Mot de passe refusé.";
  const d = await r.json().catch(() => null);
  if (d && d.session) sessionStorage.setItem("a2med_proxy_session", d.session);
  $("gAuth").classList.add("g-hidden");
  return null;
}

$("gAuth").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pb = await authentifier($("gMdp").value);
  $("gAuthErr").textContent = pb || "";
  if (!pb) santé();
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
    const d = el("details", "g-src");
    const sum = el("summary", null,
      `${s.document} — p. ${s.page}  [${s.ref}]`);
    d.append(sum, el("p", "g-quote", s.excerpt));
    box.append(d);
  });
  hote.append(box);
}

function renderAnswer(hote, out) {
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
  renderSources(hote, out.sources);
}

/* Le passage qui rend la question décisionnelle : citation brute du registre récupéré. */
function preuvePourquoi(sources, evidence) {
  const d = el("details", "g-why");
  d.append(el("summary", null, "Pourquoi ?"));
  const wrap = el("div");
  (evidence || []).forEach((alias) => {
    const n = parseInt(String(alias).replace(/\D/g, ""), 10);
    const s = (sources || []).find((x) => x.retrieval_rank === n);
    wrap.append(el("p", "g-fine", s ? `Source de cette question : ${s.document}, p. ${s.page}`
                                    : `Source de cette question : ${alias}`));
    if (s) wrap.append(el("p", "g-quote", s.excerpt));
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
  const { answers, manquants } = lireReponses();
  if (manquants.length) {
    $("gProg").textContent = `Une réponse manque pour ${manquants.length} précision(s) — `
      + `« Inconnu » est une réponse.`;
    return;
  }
  bouton.disabled = true;
  $("gProg").textContent = "Analyse en cours…";
  try {
    const out = await post("/api/guided/turn2", { trace_id: TRACE, answers, mode });
    $("gBloc").textContent = out.bloc || "";
    badge($("gBadge2"), out.status);
    renderAnswer($("gBody2"), out);
    $("gFinal").classList.remove("g-hidden");
    $("gProg").textContent = `Mode ${mode} — retrieval ${out.timings.retrieval_s} s, `
      + `génération ${out.timings.generation_s} s.`;
    // jsdom (le selfcheck) n'implémente pas le défilement : on ne le simule pas ici.
    const cible = $("gFinal");
    if (typeof cible.scrollIntoView === "function") cible.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e.code === "auth") { montrerGate(e.message); return; }
    $("gProg").textContent = String(e.message || e);
  } finally {
    bouton.disabled = false;
  }
}

$("gForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = $("gq").value.trim();
  if (!q) return;
  $("gGo").disabled = true;
  $("gClar").classList.add("g-hidden");
  $("gFinal").classList.add("g-hidden");
  $("gOut").classList.add("g-hidden");
  $("gProg").textContent = "Recherche dans le corpus…";
  try {
    const out = await post("/api/guided/ask", { question: q });
    $("gProg").textContent = out.guided_refuse
      ? "Questions non retenues par le contrôle de forme — réponse standard."
      : `Retrieval ${out.timings.retrieval_s} s · analyse ${out.timings.generation_s} s.`;
    badge($("gBadge"), out.status);
    $("gOut").classList.remove("g-hidden");
    if (out.status === "CLARIFICATION" && (out.clarifications || []).length) {
      $("gBody").textContent = "";
      $("gBody").append(el("p", "g-fine",
        "Les passages décrivent plusieurs conduites selon une information absente de la question."));
      afficherClarifications(out);
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
    $("gGo").disabled = false;
  }
});
$("gq").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("gForm").requestSubmit(); }
});
$("gGo2").addEventListener("click", (ev) => { ev.preventDefault(); tour2("A", $("gGo2")); });
$("gModeB").addEventListener("click", () => tour2("B", $("gModeB")));

/* Mode laboratoire : `?q=<question>&tire=1|2` pré-remplit et enchaîne tout seul, pour
   qu'une capture d'écran (ou un opérateur) retrouve le même état sans cliquer. Sans ces
   paramètres, la page se comporte exactement comme avant. `tire=2` choisit le premier
   choix de chaque question — c'est un brouillon de démonstration, pas une réponse clinique. */
async function auto() {
  const u = new URL(window.location.href);
  const q = u.searchParams.get("q");
  const tire = u.searchParams.get("tire");
  if (!q) return;
  $("gq").value = q;
  await $("gForm").requestSubmit();
  if (!$("gAuth").classList.contains("g-hidden")) return;   // gate ouvert : rien à jouer
  if (!tire || $("gClar").classList.contains("g-hidden")) return;
  $("gFields").querySelectorAll("fieldset.g-field").forEach((f) => {
    const c = f.querySelector("input[type=radio]");
    if (c) c.checked = true;
  });
  await tour2("A", $("gGo2"));
}

async function santé() {
  // Le front Guidé sonde SON chemin : une instance de laboratoire qui n'est pas
  // propriétaire du démon rendrait « service indisponible » sur la santé du produit.
  try {
    const session = sessionStorage.getItem("a2med_proxy_session");
    const r = await fetch(API + "/api/guided/health", { credentials: "include",
      headers: session ? { "X-A2Med-Session": session } : {} });
    if (r.status === 401) { montrerGate("Mot de passe requis pour le laboratoire."); return; }
    const h = await r.json().catch(() => ({}));
    $("healthText").textContent = h.ok ? "laboratoire prêt"
      : "daemon du laboratoire indisponible";
  } catch {
    $("healthText").textContent = "service injoignable";
  }
}

santé();

auto().catch(() => {});
