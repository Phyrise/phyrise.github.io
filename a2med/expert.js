/* Revue expert — une page, une décision (mission expert-feedback-ui-001).
   Aucune dépendance, aucun framework, aucune donnée scientifique calculée ici : le front affiche
   l'item reçu, envoie un verdict, et se tait sur tout le reste.

   Ce que ce fichier ne fait PAS, volontairement :
   - il ne demande jamais une métadonnée cachée (elle n'a pas de route) ;
   - il n'affiche ni verdict U1/U2, ni gold modèle, ni catégorie, ni score, ni nom de modèle ;
   - il ne stocke pas de secret : la session du proxy reste en sessionStorage, comme partout ailleurs. */
(function () {
  "use strict";
  const API_BASE = String(document.body.dataset.api || window.A2MED_API_BASE || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const C = window.A2MEDContract;
  const problem = C && C.apiBaseProblem ? C.apiBaseProblem(API_BASE) : null;

  const E = {
    expert: localStorage.getItem("a2med_expert_id") || "",
    campagne: null, session: null, item: null, index: 0,
    minute: 0, ouverteAvantVerdict: false, reponseOuverte: false,
    enCours: false,
  };

  // ------------------------------------------------------------------ appels
  async function api(path, options = {}) {
    const session = sessionStorage.getItem("a2med_proxy_session");
    const headers = options.body ? { "Content-Type": "application/json" } : {};
    if (session) headers["X-A2Med-Session"] = session;
    // un corps implique POST : les appelants ne le répètent pas (et un GET+body est refusé)
    const method = options.method || (options.body ? "POST" : "GET");
    let response;
    try {
      response = await fetch(API_BASE + path, {
        method, headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: "include",
      });
    } catch (e) {
      throw (C && C.networkError) ? C.networkError(API_BASE, e) : e;
    }
    if (response.status === 401) {              // le gate est ici, pas une redirection qui perd l'écran
      sessionStorage.removeItem("a2med_proxy_session");
      const err = new Error("Authentification requise"); err.code = "auth"; err.http = 401;
      throw err;
    }
    const text = await response.text();
    if (!response.ok) {
      throw (C && C.httpError) ? C.httpError(response, text)
        : new Error(`API ${response.status}`);
    }
    if (!(response.headers.get("content-type") || "").includes("json")) return text;
    return text ? JSON.parse(text) : null;
  }

  // ------------------------------------------------------------------ écrans
  const ECRANS = ["nom", "auth", "liste", "item", "fin"];
  function montrer(nom) {
    // les ids réels sont « ecran-nom », « ecran-item »… ; montrer() se nomme sans préfixe
    ECRANS.forEach((e) => { $("ecran-" + e).hidden = e !== nom; });
    $("progression").hidden = nom !== "item";
    if (nom !== "item") $("titre-page").textContent = "Retour expert";
  }

  function direErreur(id, message) {
    const zone = $(id);
    if (!message) { zone.hidden = true; zone.textContent = ""; return; }
    zone.hidden = false;
    zone.textContent = message;
  }

  function confirmer(texte) {
    const p = $("confirmation");
    p.textContent = texte; p.hidden = false;
    requestAnimationFrame(() => p.classList.add("visible"));
    clearTimeout(confirmer.t);
    confirmer.t = setTimeout(() => {
      p.classList.remove("visible");
      setTimeout(() => { p.hidden = true; }, 250);
    }, 1100);
  }

  function progresser(fait, total) {
    $("compteur").textContent = `${fait} / ${total}`;
    $("remplissage").style.width = (total ? Math.round(100 * fait / total) : 0) + "%";
  }

  // ------------------------------------------------------------------ identification
  $("valider-nom").addEventListener("click", () => {
    const nom = $("expert-id").value.trim();
    if (!nom) { direErreur("nom-aide", "Écrivez au moins une initiale."); return; }
    E.expert = nom;
    localStorage.setItem("a2med_expert_id", nom);
    demarrer().then(lister);
  });
  $("expert-id").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") $("valider-nom").click();
  });

  // ------------------------------------------------------------------ mot de passe (frontière publique)
  async function authentifier(mot) {
    let r;
    try {
      r = await fetch(API_BASE + "/__auth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: mot }), credentials: "include",
      });
    } catch (e) { return "Service injoignable — le tunnel est peut-être éteint."; }
    if (!r.ok) return "Mot de passe refusé.";
    const d = await r.json().catch(() => null);
    if (d && d.session) sessionStorage.setItem("a2med_proxy_session", d.session);
    return null;
  }
  $("valider-mdp").addEventListener("click", async () => {
    const pb = await authentifier($("motdepasse").value);
    direErreur("auth-erreur", pb);
    if (!pb) { montrer("liste"); await lister(); }
  });
  $("motdepasse").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") $("valider-mdp").click();
  });

  // ------------------------------------------------------------------ liste des campagnes
  async function lister() {
    direErreur("liste-erreur", problem);
    let data;
    try {
      data = await api("/api/expert/campaigns?expert=" + encodeURIComponent(E.expert));
    } catch (e) {
      if (e.code === "auth") { montrer("auth"); $("motdepasse").focus(); return; }
      direErreur("liste-erreur", e.message || "Service indisponible.");
      return;
    }
    const cont = $("campagnes");
    cont.textContent = "";
    const camps = (data && data.campagnes) || [];
    if (!camps.length) {
      direErreur("liste-erreur", "Aucune campagne n'est publiée pour le moment.");
    }
    camps.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "campagne";
      const prog = c.progression || {};
      const etat = prog.statut || "Nouveau";
      const p = document.createElement("p");
      p.className = "nom"; p.textContent = c.titre || c.campaign_id;
      const d = document.createElement("p");
      d.className = "desc"; d.textContent = c.description || "";
      const m = document.createElement("p");
      m.className = "meta";
      const infos = document.createElement("span");
      infos.textContent = c.erreur
        ? "campagne indisponible"
        : `${c.n_items} éléments · ~${c.estimation_min} min`;
      const badge = document.createElement("span");
      badge.className = "etat " + (etat === "Terminé" ? "fini" : etat === "En cours" ? "encours" : "");
      badge.textContent = c.erreur ? "invalide"
        : (etat === "En cours" ? `En cours — ${prog.n_annotes}/${prog.n_items}` : etat);
      m.append(infos, badge);
      b.append(p, d, m);
      b.addEventListener("click", () => ouvrir(c));
      cont.appendChild(b);
    });
    montrer("liste");
  }

  // ------------------------------------------------------------------ session et item
  async function ouvrir(c) {
    direErreur("liste-erreur", "");
    try {
      const s = await api("/api/expert/session", {
        body: { campaign_id: c.campaign_id, expert_id: E.expert, campaign_sha: c.campaign_sha },
      });
      E.campagne = c; E.session = s; E.index = s.current_index || 0;
      await montrerItem(E.index);
    } catch (e) {
      if (e.code === "auth") { montrer("auth"); return; }
      if (e.code === "campagne_version_differente") {
        direErreur("liste-erreur", e.message + " (campagne rechargée : ouvrez-la de nouveau.)");
        await lister();
        return;
      }
      direErreur("liste-erreur", e.message || "Ouverture impossible.");
    }
  }

  async function montrerItem(index) {
    try {
      const s = await api(`/api/expert/session/${E.session.session_id}?index=${index}`);
      E.session = s; E.index = index; E.item = s.item;
      if (!s.item) { montrer("fin"); finir(); return; }
      dessiner(s);
      montrer("item");
      window.scrollTo(0, 0);
    } catch (e) {
      if (e.code === "auth") { montrer("auth"); return; }
      if (e.code === "session_introuvable") { await lister(); return; }
      direErreur("item-erreur", e.message || "Item indisponible.");
    }
  }

  function dessiner(s) {
    const it = E.item = s.item;
    const deja = s.reponses[it.item_id] || {};
    progresser(Math.min(s.current_index + 1, s.n_items), s.n_items);
    $("titre-page").textContent = s.titre || "Retour expert";
    $("item-source").textContent = `Item ${s.current_index + 1} sur ${s.n_items}`;
    $("item-question").textContent = it.question || "";
    $("item-claim").textContent = it.claim || "";
    $("item-consigne").textContent = s.consigne || "";
    const ev = $("item-evidence");
    ev.textContent = "";
    (it.evidence || []).forEach((e) => {
      const c = document.createElement("div"); c.className = "evidence";
      const ssource = document.createElement("p"); ssource.className = "source";
      const a = document.createElement("span"); a.className = "alias"; a.textContent = e.alias;
      const d = document.createElement("span"); d.className = "doc";
      d.textContent = [e.doc, e.page ? "p. " + e.page : ""].filter(Boolean).join(" · ");
      ssource.append(a, d);
      const t = document.createElement("p"); t.textContent = e.text;
      c.append(ssource, t);
      ev.appendChild(c);
    });
    const plieuse = $("plieuse-reponse");
    plieuse.open = false;
    $("item-reponse").textContent = it.answer || "(réponse non disponible)";
    plieuse.hidden = !it.answer;
    E.reponseOuverte = false; E.ouverteAvantVerdict = false;
    // note et verdict déjà donnés : un item est modifiable, pas sacré
    $("item-note").value = deja.note || "";
    $("plieuse-note").open = Boolean(deja.note);
    document.querySelectorAll(".verdict").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.verdict === deja.verdict));
      b.disabled = false;
    });
    direErreur("item-erreur", "");
    E.minute = Date.now();
  }

  // ouverture de la réponse complète : mesurée, car elle peut avoir influencé le jugement
  $("plieuse-reponse").addEventListener("toggle", async () => {
    const plieuse = $("plieuse-reponse");
    if (!plieuse.open || E.reponseOuverte || !E.session || !E.item) return;
    E.reponseOuverte = true;
    const deja = (E.session.reponses || {})[(E.item || {}).item_id];
    E.ouverteAvantVerdict = !deja;
    try {
      await api("/api/expert/open-answer", {
        body: { session_id: E.session.session_id, item_id: E.item.item_id,
                ouverte_avant_verdict: E.ouverteAvantVerdict } });
    } catch (e) { /* une trace qui n'écrit pas ne doit pas bloquer une décision */ }
  });

  async function trancher(verdict, silencieux) {
    if (E.enCours || !E.session || !E.item) return;
    E.enCours = true;
    document.querySelectorAll(".verdict").forEach((b) => { b.disabled = true; });
    const item = E.item;
    const deja = (E.session.reponses || {})[item.item_id];      // ce que CET écran croit déjà enregistré
    const corps = {
      session_id: E.session.session_id, campaign_sha: E.session.campaign_sha,
      item_id: item.item_id, verdict, note: $("item-note").value.trim(),   // "" = note effacée
      verdict_attendu: deja ? deja.verdict : null,                          // verrou optimiste
      response_time_s: Math.max(0, Math.round((Date.now() - E.minute) / 100) / 10),
      reponse_complete_ouverte: E.reponseOuverte, ouverte_avant_verdict: E.ouverteAvantVerdict,
    };
    try {
      const r = await api("/api/expert/answer", { body: corps });
      E.session.reponses = E.session.reponses || {};
      E.session.reponses[item.item_id] = { verdict, note: corps.note, revision_count: r.revision_count,
                                           answered_at: r.saved_at };
      document.querySelectorAll(".verdict").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.verdict === verdict));
      });
      const total = E.session.n_items;
      const modif = r.revision_count > 0;
      if (verdict === "SKIPPED") confirmer("Passé");
      else confirmer(modif ? "Modifié et enregistré" : "Enregistré");
      progresser(Math.min((E.session.n_annotes || 0) + (modif ? 0 : 1), total), total);
      // enchaînement automatique : on ne demande jamais « enregistrer » deux fois
      if (!silencieux && E.index < E.session.n_items - 1) {
        await montrerItem(E.index + 1);
      } else if (!silencieux) {
        montrer("fin"); finir();
      }
      E.enCours = false;
    } catch (e) {
      E.enCours = false;
      document.querySelectorAll(".verdict").forEach((b) => { b.disabled = false; });
      if (e.code === "campagne_version_differente") {
        direErreur("item-erreur", e.message);
      } else if (e.code === "verdict_a_change") {
        // quelqu'un d'autre (un autre écran du même expert) a tranché : on relit, on n'écrase pas
        direErreur("item-erreur", "cet item a été modifié depuis un autre écran — "
                                  + "la version enregistrée est affichée, rien n'a été écrasé.");
        await montrerItem(E.index);
      } else if (e.code === "auth") { montrer("auth"); }
      else { direErreur("item-erreur", (e.message || "Enregistrement impossible.")
                            + " — votre réponse n'a pas été gardée, réessayez."); }
    }
  }

  document.querySelectorAll(".verdict").forEach((b) =>
    b.addEventListener("click", () => trancher(b.dataset.verdict)));
  $("btn-passer").addEventListener("click", () => trancher("SKIPPED"));

  // une note tapée APRÈS le verdict est enregistrée avec lui (sinon elle serait perdue)
  $("item-note").addEventListener("blur", () => {
    const deja = ((E.session || {}).reponses || {})[((E.item || {}).item_id)];
    if (deja && deja.verdict && deja.verdict !== "SKIPPED"
        && (deja.note || "") !== $("item-note").value.trim()) {
      trancher(deja.verdict, true);
    }
  });

  async function naviguer(delta) {
    if (!E.session) return;
    const cible = Math.max(0, Math.min(E.session.n_items - 1, E.index + delta));
    if (cible === E.index && delta > 0) { montrer("fin"); finir(); return; }
    try {
      await api("/api/expert/navigate", { body: { session_id: E.session.session_id, index: cible } });
    } catch (e) { if (e.code === "auth") { montrer("auth"); return; } }
    await montrerItem(cible);
  }
  $("btn-precedent").addEventListener("click", () => naviguer(-1));
  $("btn-suivant").addEventListener("click", () => naviguer(1));
  $("btn-retour-liste").addEventListener("click", lister);

  function finir() {
    const s = E.session || {};
    const passes = s.n_passes || 0;
    $("fin-resume").textContent =
      `${s.n_annotes || 0} affirmation${(s.n_annotes || 0) > 1 ? "s" : ""} tranchée`
      + `${(s.n_annotes || 0) > 1 ? "s" : ""} sur ${s.n_items || 0}`
      + (passes ? ` · ${passes} passée${passes > 1 ? "s" : ""}` : "")
      + ". Rien n'a été calculé pendant que vous lisiez : c'est vous qui avez jugé.";
  }

  // ------------------------------------------------------------------ raccourcis (desktop, jamais imposés)
  document.addEventListener("keydown", (ev) => {
    if ($("ecran-item").hidden) return;
    const champ = document.activeElement;
    if (champ && /INPUT|TEXTAREA/.test(champ.tagName)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const carte = { "1": "SUPPORTED", "2": "UNSUPPORTED", "3": "AMBIGUOUS" };
    const k = ev.key.toLowerCase();
    if (carte[k]) { ev.preventDefault(); trancher(carte[k]); }
    else if (k === "s") { ev.preventDefault(); trancher("SKIPPED"); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); naviguer(-1); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); naviguer(1); }
  });

  // ------------------------------------------------------------------ démarrage
  async function demarrer() {
    if (problem) { direErreur("nom-aide", problem); }
    $("expert-id").value = E.expert;
  }

  (function boot() {
    if (problem) { montrer("nom"); direErreur("nom-aide", problem); return; }
    if (!E.expert) { montrer("nom"); $("expert-id").focus(); return; }
    montrer("liste");
    lister();
  })();
})();
