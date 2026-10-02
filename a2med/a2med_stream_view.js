/* A²-Med — décodeur d'affichage incrémental (mission web-clinician-v3-001).
   Ce fichier ne fait PAS le parsing scientifique : il ne produit qu'un aperçu lisible du texte
   reconnu dans la sortie brute du générateur, le temps que l'événement `done` arrive.
   Autorité unique du résultat : l'objet `done` de /api/ask/stream (identique à celui de /api/ask).

   Clés reconnues — schéma du prompt B, lu dans tools/adhoc_query.py:451-460 :
     {"status": …, "claims": [{"claim": "fait", "evidence": ["E2"]}],
      "limitations": ["…"], "reason": "une phrase (ABSTENTION)"}
   Donc `claim` (affirmation), `reason` (motif), `limitations` (liste) ; `answer`/`text` acceptés
   par tolérance (autres prompts du même pipeline). `status`, `evidence`, `citation_ids`, les
   nombres et les objets imbriqués ne sont JAMAIS lus ici : ce décodeur ne décide aucun statut,
   n'invente aucune provenance, et n'émet jamais un fragment partiel. */
(function (global) {
  'use strict';

  // Une valeur n'est émise que si sa chaîne JSON est FERMÉE : impossible d'afficher un préfixe.
  const CLE = /"(claim|answer|text|reason)"[ \t]*:[ \t]*"((?:[^"\\]|\\.)*)"/g;
  const LISTE = /"limitations"[ \t]*:[ \t]*\[([^\]]*)\]/g;      // on attend le `]` fermant
  const CHAINE = /"((?:[^"\\]|\\.)*)"/g;
  const MAX_AFFICHE = 4000;      // fenêtre d'affichage (le flux complet reste côté serveur)
  const MAX_BRUT = 200000;       // garde-fou contre un flux qui ne finirait pas

  // Le jeton est une chaîne JSON complète : JSON.parse déploie les échappements (\" \\ \n \uXXXX)
  // sans rien réparer. S'il refuse, on n'affiche pas plutôt que d'inventer.
  function deployer(brute) {
    try {
      const v = JSON.parse('"' + brute + '"');
      return typeof v === 'string' && v.trim() ? v : null;
    } catch { return null; }
  }

  function creer() {
    let brut = '', vus = {}, affiche = 0;
    const reinitialiser = () => { brut = ''; vus = {}; affiche = 0; };

    function delta(nouveau) {
      if (nouveau) brut += String(nouveau);
      const textes = [];
      let debordement = brut.length > MAX_BRUT;

      const parCle = {};
      for (const [, cle, valeur] of brut.matchAll(CLE)) (parCle[cle] ||= []).push(valeur);
      const groupes = Object.keys(parCle).map((cle) =>
        [cle, parCle[cle], vus[cle] || 0]);
      groupes.push(['limitations',
        [...brut.matchAll(LISTE)].flatMap(([, corps]) => [...corps.matchAll(CHAINE)].map((m) => m[1])),
        vus.limitations || 0]);

      for (const [cle, liste, deja] of groupes) {
        for (let i = deja; i < liste.length; i++) {
          const chaine = deployer(liste[i]);
          if (chaine === null) continue;                       // jamais « réparée »
          if (affiche + chaine.length > MAX_AFFICHE) { debordement = true; break; }
          affiche += chaine.length;
          textes.push(chaine);
        }
        vus[cle] = Math.max(vus[cle] || 0, liste.length);
      }
      // ponytail: `limitations` s'arrête au premier `]`, donc un `]` échappé dans une limite
      // retarde l'aperçu de cette limite (jamais le résultat final, qui vient de `done`).
      return { textes, en_attente: textes.length === 0, debordement };
    }
    return { delta, reset: reinitialiser, get brut() { return brut; } };
  }

  global.A2MEDStreamView = { creer, CLES: ['claim', 'answer', 'text', 'reason', 'limitations'] };
})(typeof window !== 'undefined' ? window : globalThis);
