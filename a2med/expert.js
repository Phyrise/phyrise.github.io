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
    enCours: false, dernierVerdict: null,
    positions: {}, plies: {},
  };

  /* ------------------------------------------------------------------ reprise et file locale
     Un avis rendu sur un téléphone dans un couloir peut être coupé par un réseau qui lâche,
     par un verrouillage d'écran, par un rappel téléphonique. Rien ici ne doit dépendre de la
     chance : le choix non parti est gardé localement, la position de lecture est rendue à son
     retour, et aucun envoi n'est déclenché sans une action explicite. */
  const CLE_ATTENTE = "a2med_expert_en_attente";
  const CLE_POSITIONS = "a2med_expert_positions";
  const jsonLu = (cle) => { try { return JSON.parse(sessionStorage.getItem(cle) || "null"); } catch (e) { return null; } };
  const jsonEcrit = (cle, valeur) => {
    try { sessionStorage.setItem(cle, JSON.stringify(valeur)); } catch (e) { /* quota: on continue */ }
  };
  const LIBELLES = { SUPPORTED: "Supportée", UNSUPPORTED: "Non supportée",
                     AMBIGUOUS: "Ambiguë", SKIPPED: "Passée" };
  const heure = () => new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  /* Les trois états demandés, et seulement eux : Envoi… / Enregistré ✓ / Non enregistré —
     Réessayer. « Enregistré » n'est jamais affirmé avant la réponse du serveur. */
  function etatSave(mode, detail) {
    const zone = $("etat-save"), renvoi = $("renvoi");
    if (!zone) return;
    const textes = { vide: "", attente: "Envoi en cours…", garde: "Enregistré ✓",
                     perdu: "Non enregistré — Réessayer" };
    zone.className = "etat-save " + mode;
    zone.hidden = mode === "vide";
    zone.textContent = textes[mode] + (detail ? " · " + detail : "");
    if (renvoi) renvoi.hidden = mode !== "perdu";
  }

  function gardeAttente(valeur) {
    jsonEcrit(CLE_ATTENTE, valeur);
    E.enAttente = valeur;
  }

  function positionActuelle() {
    const it = E.item;
    if (!it || !E.session) return;
    E.positions[it.item_id] = Math.round(window.scrollY || window.pageYOffset || 0);
    E.plies[it.item_id] = [...document.querySelectorAll("#item-evidence details")]
      .map((d, i) => (d.open ? "o" : "f")) .join("");
    jsonEcrit(CLE_POSITIONS, { session_id: E.session.session_id, positions: E.positions,
                               plies: E.plies });
  }


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
    positionActuelle();
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
      const mem = jsonLu(CLE_POSITIONS);
      if (mem && mem.session_id === s.session_id) {   // reprise du même trajet, pas d'un ancien
        E.positions = mem.positions || {};
        E.plies = mem.plies || {};
      } else {
        E.positions = {}; E.plies = {};
      }
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
    positionActuelle();                       // on part d'ici : la position en cours est gardée
    try {
      const s = await api(`/api/expert/session/${E.session.session_id}?index=${index}`);
      E.session = s; E.index = index; E.item = s.item;
      if (!s.item) { montrer("fin"); finir(); return; }
      dessiner(s);
      montrer("item");
      // pas de scrollTo(0,0) ici : `dessiner` rend la position de lecture de cet item
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
    dessinePreuves(it);

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

    /* état de sauvegarde à l'ouverture : ce que le serveur a, pas ce qu'on voudrait avoir */
    if (deja && deja.verdict) {
      etatSave("garde", LIBELLES[deja.verdict] || deja.verdict);
    } else {
      etatSave("vide");
    }
    E.dernierVerdict = deja ? deja.verdict : null;

    // un choix resté en local (réseau coupé, écran verrouillé) est signalé, jamais renvoyé seul
    const attente = jsonLu(CLE_ATTENTE);
    const rappel = $("item-attente");
    if (attente && attente.item_id === it.item_id
        && (attente.verdict || "") !== ((deja || {}).verdict || "")) {
      rappel.hidden = false;
      rappel.textContent = "Votre choix « " + (LIBELLES[attente.verdict] || attente.verdict)
        + " » n'avait pas été enregistré sur ce téléphone.";
      $("btn-reessayer").textContent = "Renvoyer « "
        + (LIBELLES[attente.verdict] || attente.verdict) + " »";
      E.dernierVerdict = attente.verdict;
    } else if (attente && attente.item_id !== it.item_id) {
      gardeAttente(null);                       // l'item concerné n'est plus celui-ci
      rappel.hidden = true;
    } else {
      rappel.hidden = true;
    }

    // position de lecture et preuves ouvertes ou fermées : rendues à qui revient
    const code = (E.plies || {})[it.item_id];
    if (code) {
      [...document.querySelectorAll("#item-evidence details")].forEach((d, i) => {
        d.open = code[i] === "o";
      });
    }
    const y = (E.positions || {})[it.item_id];
    window.scrollTo(0, Number.isFinite(y) ? y : 0);
  }

  /* Les preuves d'un item, servies comme partout ailleurs : vue mise en page par le formatter
     déterministe (aucun LLM, aucune réécriture), texte brut exact de la campagne sous un
     repli, contexte limité à ce que la campagne a enregistré. Le texte de la campagne reste
     la seule vérité : ici, la vue est seulement lue, jamais stockée. */
  function dessinePreuves(it) {
    const ev = $("item-evidence");
    const V = window.A2MEDEvidenceView;
    const toutes = it.evidence || [];
    toutes.forEach((e, n) => {
      const c = document.createElement("div"); c.className = "evidence";
      const ssource = document.createElement("p"); ssource.className = "source";
      const a = document.createElement("span"); a.className = "alias"; a.textContent = e.alias;
      const d = document.createElement("span"); d.className = "doc";
      d.textContent = [e.doc, e.page ? "p. " + e.page : ""].filter(Boolean).join(" · ");
      ssource.append(a, d);
      c.append(ssource);
      const brut = String(e.text == null ? "" : e.text);
      const corps = document.createElement("div"); corps.className = "preuve-corps";
      if (V) {
        const vue = V.formater(brut, { page: e.page });
        const h = document.createElement("div"); h.className = "preuve-vue";
        vue.blocs.forEach((b) => {
          if (b.type === "liste") {
            if (!b.puces) {                       // numérotée : le numéro reste dans le texte
              b.items.forEach((x) => {
                const item = document.createElement("p");
                item.className = "ev-item-numerote"; item.textContent = x;
                h.append(item);
              });
            } else {
              const ul = document.createElement("ul"); ul.className = "ev-liste";
              b.items.forEach((x) => {
                const li = document.createElement("li"); li.textContent = x; ul.append(li);
              });
              h.append(ul);
            }
            return;
          }
          const para = document.createElement("p");
          para.className = b.type === "titre" ? "ev-titre" : "ev-paragraphe";
          para.textContent = b.texte;
          h.append(para);
        });
        corps.append(h);
        // le texte brut reste LE texte de la campagne, dans un <pre>, sans aucun traitement
        const plie = document.createElement("details"); plie.className = "preuve-brut";
        const somme = document.createElement("summary");
        somme.textContent = "Voir le texte brut enregistré par la campagne";
        const pre = document.createElement("pre"); pre.textContent = brut;
        plie.append(somme, pre);
        corps.append(plie);
        const autres = toutes.filter((o, i) => i !== n && o.doc === e.doc)
          .map((o) => `${o.alias}${o.page ? " p. " + o.page : ""}`);
        const dl = document.createElement("dl"); dl.className = "contexte";
        const champs = [
          ["Document", e.doc || "non enregistré"],
          ["Page/diapositive", (e.page === undefined || e.page === null || e.page === "")
            ? "non enregistrée" : String(e.page)],
          ["Section du document", "non enregistrée dans la campagne"],
          ["Autre passage de ce document", autres.length ? autres.join(" · ") : "aucun dans cet item"],
        ];
        champs.forEach(([c1, v]) => {
          const dt = document.createElement("dt"); dt.textContent = c1;
          const dd = document.createElement("dd"); dd.textContent = v;
          dl.append(dt, dd);
        });
        corps.append(dl);
      } else {
        // pas de module chargé : on affiche le brut, jamais une vue improvisée
        const t2 = document.createElement("p"); t2.textContent = brut;
        corps.append(t2);
      }
      c.append(corps);
      ev.appendChild(c);
    });
  }

  // bascules des preuves : un seul delégataire, les cartes sont recréées à chaque item
  $("item-evidence").addEventListener("click", (ev) => {
    if (ev.target.closest("details, summary")) positionActuelle();
  });

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
    E.dernierVerdict = verdict;
    document.querySelectorAll(".verdict").forEach((b) => { b.disabled = true; });
    const item = E.item;
    const deja = (E.session.reponses || {})[item.item_id];      // ce que CET écran croit déjà enregistré
    // le choix visuel est pris immédiatement : un doigt qui a appuyé doit voir ce qu'il a choisi,
    // même si le réseau ne répond jamais. L'enregistrement, lui, n'est affirmé qu'après réponse.
    document.querySelectorAll(".verdict").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.verdict === verdict));
    });
    if (!silencieux) etatSave("attente");
    const corps = {
      session_id: E.session.session_id, campaign_sha: E.session.campaign_sha,
      item_id: item.item_id, verdict, note: $("item-note").value.trim(),   // "" = note effacée
      verdict_attendu: deja ? deja.verdict : null,                          // verrou optimiste
      response_time_s: Math.max(0, Math.round((Date.now() - E.minute) / 100) / 10),
      reponse_complete_ouverte: E.reponseOuverte, ouverte_avant_verdict: E.ouverteAvantVerdict,
      // le serveur sait avancer tout seul ; on lui demande explicitement de ne pas le faire.
      // Enregistrer n'est pas tourner la page : la position de lecture est une décision du
      // praticien, et c'est aussi ce qui fait qu'une reprise ramène à l'item qu'on lisait.
      current_index: E.index,
    };
    // écrit AVANT l'envoi : c'est ce qui survit à un écran qui s'éteint en plein vol
    gardeAttente({ session_id: E.session.session_id, item_id: item.item_id, verdict,
                   note: corps.note, envoye_a: new Date().toISOString() });
    try {
      const r = await api("/api/expert/answer", { body: corps });
      E.session.reponses = E.session.reponses || {};
      E.session.reponses[item.item_id] = { verdict, note: corps.note, revision_count: r.revision_count,
                                           answered_at: r.saved_at };
      gardeAttente(null);
      $("item-attente").hidden = true;
      const total = E.session.n_items;
      const modif = r.revision_count > 0;
      // « ce qu'on nous demande de corriger » : l'état reste à l'écran, on ne se contente pas
      // d'un merci qui disparaît
      etatSave("garde", (LIBELLES[verdict] || verdict) + " · " + heure()
        + (modif ? " · révision " + r.revision_count : ""));
      confirmer(verdict === "SKIPPED" ? "Passé" : modif ? "Modifié et enregistré" : "Enregistré");
      progresser(Math.min((E.session.n_annotes || 0) + (modif ? 0 : 1), total), total);
      document.querySelectorAll(".verdict").forEach((b) => { b.disabled = false; });
      E.enCours = false;
      // PAS d'enchaînement automatique (demande expresse de la mission v3-002) : le praticien
      // garde la main, et garde la page où il est. On ne déplace la vue que sur son geste.
      if (!silencieux) {
        const suivant = $("btn-suivant");
        if (suivant && E.index < total - 1) suivant.focus();
        else montrer("fin");
        if (E.index >= total - 1) finir();
      }
    } catch (e) {
      E.enCours = false;
      document.querySelectorAll(".verdict").forEach((b) => { b.disabled = false; });
      if (e.code === "campagne_version_differente") {
        etatSave("perdu");
        direErreur("item-erreur", e.message);
      } else if (e.code === "verdict_a_change") {
        // quelqu'un d'autre (un autre écran du même expert) a tranché : on relit, on n'écrase pas
        gardeAttente(null);
        etatSave("vide");
        direErreur("item-erreur", "cet item a été modifié depuis un autre écran — "
                                  + "la version enregistrée est affichée, rien n'a été écrasé.");
        await montrerItem(E.index);
      } else if (e.code === "auth") {
        etatSave("perdu");
        montrer("auth");
      } else {
        // le choix reste à l'écran et reste renvoyable tel quel : pas de saisie à refaire
        etatSave("perdu");
        direErreur("item-erreur", (e.message || "Enregistrement impossible.")
                              + " — votre choix reste affiché, rien n'a été envoyé.");
      }
    }
  }

  document.querySelectorAll(".verdict").forEach((b) =>
    b.addEventListener("click", () => trancher(b.dataset.verdict)));
  $("btn-passer").addEventListener("click", () => trancher("SKIPPED"));
  // renvoi explicite du même verdict : jamais d'envoi automatique d'un choix non confirmé
  $("btn-reessayer").addEventListener("click", () => {
    if (!E.dernierVerdict) return;
    trancher(E.dernierVerdict);
  });

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
