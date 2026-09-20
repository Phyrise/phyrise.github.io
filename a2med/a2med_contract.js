/* Contrat partagé des deux pages publiques (index.html et eval.html).

Pourquoi ce fichier : les enums (modes, verdicts, familles, taxonomie) et la traduction des erreurs
HTTP vivaient dispersés dans app.js et eval.js, avec des libellés recopiés à la main. Le maître
prompt §5/§6 demande une source unique. Les valeurs réellement en service viennent de
`GET /api/capabilities` (le backend) ; ce fichier ne tient que (1) des valeurs de repli lisibles si
le backend ne répond pas, (2) les libellés, (3) le traducteur d'erreurs HTTP, (4) le contrôle de la
base d'API.

Aucune logique scientifique ici : ni retrieval, ni prompt, ni seuil.
*/
(function () {
  "use strict";

  /* Motifs vus par le clinicien (§7 du mission brief) -> CODES STABLES de la taxonomie.
     Une simple etiquette francaise ecrit le code existant : les aggregates, l'export et les
     sessions ne changent pas. Les 7 codes restants restent accessibles dans
     « Classification détaillée » (memes 17 clés, meme cle d'aggregate). */
  const TAXONOMY_SIMPLE = [
    { label: "Information importante manquante", code: "IMPORTANT_CONDITION_MISSING" },
    { label: "Information incorrecte", code: "INCORRECT_FACT" },
    { label: "Mauvais contexte / population", code: "APPLICABILITY_MISMATCH" },
    { label: "Mauvaise source / citation", code: "SOURCE_PROVENANCE_ISSUE" },
    { label: "Aurait dû s’abstenir", code: "SHOULD_HAVE_ABSTAINED" },
    { label: "S’est abstenu à tort", code: "INAPPROPRIATE_ABSTENTION" },
    { label: "Réponse trop vague / imprécise", code: "ANSWER_IMPRECISE" },
    { label: "Réponse trop détaillée", code: "EXCESSIVE_DETAIL" },
    { label: "Question ambiguë / impossible à trancher", code: "QUESTION_AMBIGUOUS" },
    { label: "Autre", code: "OTHER" },
  ];

  // Repli : uniquement ce qu'il faut pour afficher un message compréhensible quand /api/capabilities
  // est muet. Ce ne sont PAS des valeurs de vérité : dès que le backend répond, il les remplace.
  const FALLBACK = {
    contract: "inconnu",
    modes: [{ id: "standard", wire: "standard", label: "Standard" },
            { id: "short", wire: "courte", label: "Courte" },
            { id: "source_only", wire: "sources", label: "Sources" }],
    verdicts: ["correct", "partial", "incorrect", "cannot_assess"],
    verdict_keys: { "1": "correct", "2": "partial", "3": "incorrect", "4": "cannot_assess" },
    eval_kinds: ["benchmark", "free"],
    taxonomy: [], generators: [], sources_useful: [],
    taxonomy_simple: TAXONOMY_SIMPLE,
  };
  const VERDICT_LABEL = { correct: "Correct", partial: "Partiel", incorrect: "Incorrect",
                          cannot_assess: "Impossible à juger" };


  const MODE_LABEL = { standard: "Standard", courte: "Courte", sources: "Sources" };
  const HTTP_FR = {
    400: "requête refusée", 401: "session expirée — re-saisissez le mot de passe",
    403: "accès refusé", 404: "endpoint absent", 405: "méthode non permise",
    408: "délai dépassé", 409: "conflit (session verrouillée sur un autre SHA ?)",
    413: "corps trop volumineux", 422: "données invalides",
    500: "erreur interne du service", 502: "générateur indisponible", 503: "service indisponible",
    504: "délai dépassé en amont",
  };

  let caps = Object.assign({}, FALLBACK);

  /* Une erreur backend ne doit jamais devenir « réponse non JSON du service » sans explication.
     Le corps n'est jamais réaffiché tel quel (il peut porter un chemin) : seul `error`/`code`
     remonte, plus le content-type et le trace_id quand la page les connaît. */
  function httpError(response, text, traceId) {
    // `response.headers` peut manquer (sonde, appel hors fetch) : planter ici rouvrirait
    // exactement la panne que ce fichier existe pour fermer (le front qui casse sur une erreur).
    const headers = response && response.headers;
    const ct = String((headers && headers.get && headers.get("content-type"))
                      || "sans content-type").split(";")[0].trim();
    const trace = traceId ? ` · trace_id ${traceId}` : "";
    let data = null;
    if (text && text.trim().startsWith("{")) { try { data = JSON.parse(text); } catch (_) { data = null; } }
    if (data === null && text && text.trim()) {
      const onPages = /github\.io$|githubusercontent\.com$/.test(location.hostname);
      const hint = ct.includes("html")
        ? (onPages && !caps.api_base
           ? " — cette page n'a pas de base d'API : les appels partent sur GitHub Pages, qui répond 404"
           : " — du HTML a été reçu à la place du JSON (tunnel, proxy ou page d'erreur ?)")
        : ` — contenu attendu en JSON, reçu : ${ct}`;
      const err = new Error(`JSON invalide — HTTP ${response.status}${hint}${trace}`);
      err.code = "non_json"; err.http = response.status; err.contentType = ct;
      return err;
    }
    const detail = (data && (data.error || data.detail)) || "";
    const code = (data && data.code) || "";
    // Une panne TECHNIQUE de la génératrice a son propre texte : « Réponse incomplète — génération
    // interrompue » doit se lire plutôt qu'un « erreur serveur » fourre-tout. Le code machine, lui,
    // ne change pas : les agrégats et les clients existants restent comparables.
    const technique = (data && data.message_technique) || "";
    const fond = technique || HTTP_FR[response.status] || detail || `erreur HTTP ${response.status}`;
    const err = new Error(`API ${response.status} — ${fond}${code ? ` (${code})` : ""}${trace}`);
    err.code = code; err.http = response.status; err.detail = detail; err.body = data;
    err.technical_status = (data && data.technical_status) || "";
    return err;
  }

  // Le piège du 18/09 : page publiée sans base d'API → les appels partent sur github.io → 404 HTML.
  // Mieux vaut le dire une fois, clairement, que laisser trois listes vides.
  function apiBaseProblem(base) {
    caps.api_base = base;
    const onPages = /github\.io$|githubusercontent\.com$/.test(location.hostname);
    if (!base && onPages) {
      return "Base d'API non configurée sur cette page : le front est publié sans "
           + "window.A2MED_API_BASE et appelle GitHub Pages. Publier avec "
           + "`tools/publish_pages.py --api-base https://<tunnel>`.";
    }
    return null;
  }

  // Une base d'API morte (tunnel éteint, proxy en panne, base mal publiée) doit se lire comme
  // telle : « Service injoignable sur … », jamais une TypeError brute du navigateur.
  function networkError(base, cause) {
    const where = base || (typeof location !== "undefined" ? location.origin : "le service");
    const msg = base
      ? `Service injoignable sur ${where} — le tunnel ou le service est peut-être éteint.`
      : `Service injoignable sur ${where} — cette page n'a pas de base d'API : publier avec `
        + "`tools/publish_pages.py --api-base https://<tunnel>`.";
    const err = new Error(msg);
    err.code = "reseau"; err.http = 0; err.cause = cause;
    return err;
  }

  const modeWire = (id) => (caps.modes.find(m => m.id === id || m.wire === id) || {}).wire || id;
  const modeLabel = (wire) => (caps.modes.find(m => m.wire === wire) || {}).label
                           || MODE_LABEL[wire] || wire;
  const verdictLabel = (v) => VERDICT_LABEL[v] || v;
  const taxOf = (code) => caps.taxonomy.find(t => t.code === code || t.ui === code) || null;
  // `taxLabel` = la description française affichée ; `taxUi` = le code du master prompt (§6).
  // Le code réellement stocké dans les exports reste `t.code` (cle d'agregat stable).
  const taxLabel = (code) => { const t = taxOf(code); return t ? t.label : code; };
  const taxUi = (code) => { const t = taxOf(code); return t ? t.ui : code; };
  const taxStore = (uiCode) => { const t = taxOf(uiCode); return t ? t.code : uiCode; };
  // Motifs medecin : la liste du backend quand elle arrive, sinon la table figee ci-dessus.
  // Un contrat muet ne doit jamais rendre le scoring muet.
  const taxonomySimple = () => (caps.taxonomy_simple && caps.taxonomy_simple.length
    ? caps.taxonomy_simple : TAXONOMY_SIMPLE);
  const generators = () => caps.generators || [];
  const availableGenerators = () => generators().filter(g => g.available && g.model_served !== false);

  function apply(payload) {                       // la page garde son propre api() (session, retries)
    caps = Object.assign({}, FALLBACK, payload || {});
    return caps;
  }

  window.A2MEDContract = {
    FALLBACK, httpError, networkError, apiBaseProblem, apply, caps: () => caps,
    modeWire, modeLabel, verdictLabel, verdictKeys: () => caps.verdict_keys || FALLBACK.verdict_keys,
    verdicts: () => caps.verdicts || FALLBACK.verdicts,
    evalKinds: () => caps.eval_kinds || FALLBACK.eval_kinds,
    taxonomy: () => caps.taxonomy || [], taxOf, taxLabel, taxUi, taxStore,
    taxonomySimple, taxonomySimpleFallback: TAXONOMY_SIMPLE,
    generators, availableGenerators,
    sourcesUseful: () => (caps.sources_useful && caps.sources_useful.length
      ? caps.sources_useful : [{ ui: "yes", code: "oui", label: "Oui" },
                               { ui: "partial", code: "partiel", label: "Partiellement" },
                               { ui: "no", code: "non", label: "Non" },
                               { ui: "unrated", code: "na", label: "Non évalué" }]),
  };
})();
