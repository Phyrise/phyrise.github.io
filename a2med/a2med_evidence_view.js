/* web-clinician-v3-002 — mise en page des preuves, SANS compréhension du contenu.
 *
 * RAW reste la vérité : ce fichier ne fabrique aucun fait médical. Il reçoit le texte exact du
 * registre (`content.text`) ou de la campagne (`evidence[].text`) et ne produit qu'une
 * PRÉSENTATION. Aucune règle ne regarde ce que les mots signifient : pas de LLM, pas de
 * dictionnaire, pas de résumé, pas de « correction » de terme, de dose, de durée, de négation.
 *
 * Ce qui est autorisé (et testé) : normaliser les blancs, refermer une souplesse de ligne
 * quand la suite commence par une minuscule, normaliser les glyphes de liste connus, marquer un
 * titre de première ligne, retirer un numéro de page SEULEMENT quand il est isolé en tête ou
 * queue et qu'il est exactement la page déjà connue (`page`), recoller une césure SEULEMENT si
 * le mot recollé existe déjà tel quel ailleurs dans le même passage.
 *
 * Ce qui est interdit et tient par construction : aucune jointure au-dessus d'une ligne blanche
 * (un schéma aplati « Contage ≤ 14 jours » / blanc / « Contage > 14 jours » n'est pas une phrase
 * coupée), aucun effacement de glyphe inconnu (U+FFFD reste visible : c'est la preuve que
 * l'extraction est abîmée), aucun changement de caractère hors blancs et puces déclarées.
 *
 * `canonical()` est l'invariant : appliqué au RAW et au DISPLAY, il doit donner la même chaîne.
 * Les seules différences qu'il accepte sont exactement celles déclarées ci-dessus.
 */
(function (global) {
  "use strict";

  var NFAIRE = "\uFFFD";   // garde-fou lisible : jamais effacé
  var PUCE_GLYPHES = "\u2022\u25AA\u25AB\u25CF\u2023\u25B6\u00B7";     // • ▪ ‣ ● ‣ ▶ ·
  var PUCE = new RegExp("[" + PUCE_GLYPHES + "]");                  // un glyphe de puce connu
  // ligne qui commence par une puce (glyphe, ou tiret demi/long) : c'est un item, pas une phrase
  var LIGNE_PUCE = new RegExp("^(\\s*)([" + PUCE_GLYPHES + "\u2013\u2014-])\\s+(.*)$");
  // n'importe quel marqueur de liste (puce ou numéro) : servi à la comparaison canonique
  // marqueur d'item : tiret (puce normalisée) ou numéro suivi de ) ou . — conservé tel quel
  var ITEM = /^\s*(-|\d+[.)])\s+(.*)$/;
  var MARQUEUR = new RegExp("^\\s*(?:[" + PUCE_GLYPHES + "\u2013\u2014-]|\\d+[.)])\\s+");
  var DEBUT_LISTE = new RegExp("^\\s*(?:" + PUCE.source + "|[-*\u2013\u2014]|\\d+[.)\\]]|\\(?[A-Za-zÀ-ÿ][.)])\\s");
  var FIN_PHRASE = /[.!?:;\u2026\u00BB\u201D"')\]]\s*$/;         // . ! ? ; : … » " ) ]
  var NOMBRE_SEUL = /^\s*\d{1,3}\s*$/;
  var CESURE = /([À-ÿ\w])-$/;
  var MOT = /[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*/g;

  function decoupe_lignes(texte) {
    return String(texte == null ? "" : texte).replace(/\r\n?/g, "\n").split("\n");
  }

  /* Les deux premiers tiers ne touchent QUE des blancs : ils ne peuvent donc pas changer un mot. */
  function normalise_blancs(texte) {
    var lignes = decoupe_lignes(texte).map(function (l) {
      return l.replace(/\t/g, " ").replace(/ {2,}/g, " ").replace(/[ \t]+$/g, "");
    });
    var out = [], blancs = 0;
    for (var i = 0; i < lignes.length; i++) {
      if (lignes[i] === "") {
        blancs++;
        if (blancs <= 2) out.push("");                   // plus de deux lignes blanches → deux
      } else {
        blancs = 0;
        out.push(lignes[i]);
      }
    }
    return out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  }

  function minuscule(c) { return /^[a-zà-ÿ]$/.test(c); }

  /* R4 — referme une souplesse de ligne. Conservateur par construction : la suite doit
     commencer par une minuscule, la ligne précédente ne doit pas finir sur une ponctuation de
     fin d'énoncé, aucune ligne blanche ne doit les séparer, et aucune des deux ne doit
     ressembler à un item de liste. */
  function referme_souplesse(lignes) {
    var out = [], jointures = 0;
    function peut_refermer(cur, suivant) {
      return cur !== "" && suivant !== undefined && suivant !== ""
        && !FIN_PHRASE.test(cur) && cur.length > 3
        && !DEBUT_LISTE.test(cur) && !DEBUT_LISTE.test(suivant)
        && !NOMBRE_SEUL.test(suivant) && !/^[-\u2013\u2014]/.test(suivant)
        && minuscule(suivant.charAt(0)) && !/[{[]$/.test(cur)
        && !/[-\u2013\u2014]$/.test(cur);        // ligne coupée sur un trait d'union : R9 ou rien
    }
    for (var i = 0; i < lignes.length; i++) {
      var cur = lignes[i];
      while (peut_refermer(cur, lignes[i + 1])) {           // referme autant de souplesses que besoin
        cur = cur + " " + lignes[i + 1];                    // un saut de ligne est une frontière de mot
        i++;
        jointures++;
      }
      out.push(cur);
    }
    return { lignes: out, jointures: jointures };
  }

  /* R9 — césure. Preuve interne seulement : le mot recollé sans tiret doit exister ailleurs
     dans le même passage. Sinon on ne touche pas (un « anti-VZV », « 0.5-1ml »,
     « pneumocoque-vaccin » est un terme, pas une coupure). */
  function recolle_césure(texte) {
    var mots = {};
    var m;
    MOT.lastIndex = 0;
    while ((m = MOT.exec(texte))) mots[m[0].toLowerCase()] = true;
    var lignes = decoupe_lignes(texte), out = [], cesures = 0;
    for (var i = 0; i < lignes.length; i++) {
      var cur = lignes[i], suivant = lignes[i + 1];
      var c = CESURE.exec(cur);
      if (c && suivant !== undefined && suivant !== "" && minuscule(suivant.charAt(0))) {
        var debut = /^[a-zà-ÿ'’]+/.exec(suivant);
        var queue = /([\wÀ-ÿ'’]+)-$/.exec(cur);            // le mot qui a été coupé
        if (debut && queue) {
          var recolle = queue[1] + debut[0];              // le mot recollé, sans le tiret
          var autre = recolle.toLowerCase();
          // preuve interne : ce mot existe déjà, entier, ailleurs dans le même passage.
          // ET sa forme À TRAIT D'UNION n'existe pas ailleurs : si « pneumo-vaccin » est écrit
          // entier quelque part, la coupure « pneumo- » + « vacciner » est probablement ce terme,
          // pas une césure — recoller produirait un mot que le document n'emploie pas.
          var avec_tiret = (queue[1] + "-" + debut[0]).toLowerCase();
          var forme_a_tiret = mots[avec_tiret] || new RegExp("\\b" + queue[1] + "-+[^\\s]\\b", "i").test(texte);
          var existe = mots[autre] && !forme_a_tiret
                     && !new RegExp("\\b" + autre + "\\b", "i").test(cur);
          if (existe) {
          out.push(cur.slice(0, cur.length - queue[1].length - 1) + recolle
                   + suivant.slice(debut[0].length));
            cesures++;
            i++;
            continue;
          }
        }
      }
      out.push(cur);
    }
    return { texte: out.join("\n"), cesures: cesures };
  }

  /* R5 — numéro de page. Retiré seulement s'il est seul, en tête ou en queue, et exactement la
     page déjà connue des métadonnées. Ailleurs, un « 14 » seul est du contenu : on le garde. */
  function retire_numero(lignes, page) {   /* R5 — le texte retiré est consigné, pas oublié */
    if (page === undefined || page === null || page === "") return { lignes: lignes, retires: 0 };
    var attendu = String(page).trim();
    var premiers = [];
    while (premiers.length < lignes.length && lignes[premiers.length] === "") premiers.push(1);
    var i0 = premiers.length;
    var i1 = lignes.length - 1;
    while (i1 > i0 && lignes[i1] === "") i1--;
    var out = lignes.slice(), retires = 0, retires_texte = [];
    if (i0 < out.length && NOMBRE_SEUL.test(out[i0]) && out[i0].trim() === attendu) {
      retires_texte.push(out[i0].trim());
      out.splice(i0, 1); retires++;
    }
    var j = out.length - 1;
    while (j >= 0 && out[j] === "") j--;
    if (j >= 0 && NOMBRE_SEUL.test(out[j]) && out[j].trim() === attendu) {
      retires_texte.push(out[j].trim());
      out.splice(j, 1); retires++;
    }
    return { lignes: out, retires: retires, retires_texte: retires_texte };
  }

  /* R6 + R7 — puces connues → "-", et suite de puces → liste. Un seul glyphe inconnu
     (U+FFFD, etc.) reste tel quel, bien en vue. */
  function puces(lignes) {
    var n = 0, par = {};
    var out = lignes.map(function (l) {
      var m = LIGNE_PUCE.exec(l);
      if (m && m[2] !== "-") {                                  // m[2] = glyphe, m[3] = texte
        n++;
        par[m[2]] = (par[m[2]] || 0) + 1;                       //consigné par glyphe, pas en total
        return m[1] + "- " + m[3];
      }
      return l;
    });
    return { lignes: out, puces: n, par_glyphe: par };
  }

  /* Titre : seulement la première ligne, courte, sans ponctuation finale, suivie d'une ligne
     blanche. Le reste du texte n'est jamais « titré » par hypothèse. */
  /* Une ligne qui se termine sur un trait d'union est une coupure d'extraction : coller la suite
     sans espace fabriquerait un mot que le document n'écrit pas, mettre un espace en ferait un mot
     coupé. On garde donc le saut de ligne tel quel — laid, mais fidèle (`white-space: pre-wrap`). */
  function joint_lignes(ls) {
    return ls.reduce((a, l) => (a === "" ? l : a + (/[-\u2013\u2014]$/.test(a) ? "\n" : " ") + l), "");
  }
  /* Combien de ces sauts ont été conservés ? Chiffré dans le journal (`sauts_conservs`) :
     le compte exact de caractères (`audit_caracteres`) retire les blancs par construction, ce
     serait donc le seul endroit où la remise en page des blancs cesse d'être déclarée. */
  function compte_sauts_conservs(formate) {
    var n = 0;
    String(formate.net || "").split("\n\n").forEach(function (b) {
      var m = b.match(/[-\u2013\u2014]\n/g);
      if (m) n += m.length;
    });
    return n;
  }

  function blocs(lignes) {
    var out = [], i = 0;
    if (lignes.length && lignes[0] !== "" && lignes[0].length <= 80 && !FIN_PHRASE.test(lignes[0])
        && (lignes[1] === "" || lignes[1] === undefined)) {
      out.push({ type: "titre", texte: lignes[0] });
      i = 1;
      while (i < lignes.length && lignes[i] === "") i++;
    }
    var paragraphe = [], liste = [], marqueur_de_liste = "";
    function vide_paragraphe() {
      if (paragraphe.length) { out.push({ type: "paragraphe", texte: joint_lignes(paragraphe) }); paragraphe = []; }
    }
    function vide_liste() {
      if (liste.length) { out.push({ type: "liste", puces: marqueur_de_liste === "-",
                                     items: liste }); liste = []; }
    }
    for (; i < lignes.length; i++) {
      var l = lignes[i];
      if (l === "") { vide_paragraphe(); vide_liste(); continue; }
      var item = ITEM.exec(l);
      // Le marqueur est CONSERVÉ : « 2) recommandation » doit rester « 2) », le numéro peut
      // être une référence ("le point 3 de la recommandation"). Seule la puce est normalisée.
      if (item) {
        var marqueur = item[1];
        if (liste.length && marqueur !== marqueur_de_liste) vide_liste();
        vide_paragraphe();
        marqueur_de_liste = marqueur;
        liste.push(marqueur === "-" ? item[2] : marqueur + " " + item[2]);
        continue;
      }
      vide_liste();
      paragraphe.push(l);
    }
    vide_paragraphe(); vide_liste();
    return out;
  }

  function echappe(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* Entrée principale : texte exact → présentation + journal mesuré. */
  function formater(texte, options) {
    var opt = options || {};
    var brut = String(texte == null ? "" : texte);
    var etape = normalise_blancs(brut);
    var ces = recolle_césure(etape);
    var lignes = decoupe_lignes(ces.texte);
    var num = retire_numero(lignes, opt.page);
    var numeros = num.retires_texte || [];
    var p = puces(num.lignes);
    var r = referme_souplesse(p.lignes);
    var blocs_out = blocs(r.lignes);
    var net = blocs_out.map(function (b) {
      if (b.type !== "liste") return b.texte;
      return b.items.map(function (x) { return (b.puces ? "- " : "") + x; }).join("\n");
    }).join("\n\n");
    return {
      blocs: blocs_out,
      net: net,
      journal: {
        cesures: ces.cesures,
        numeros_page_retires: num.retires,
        numeros_retires: numeros,
        puces_normalisees: p.puces,
        puces_par_glyphe: p.par_glyphe,
        jointures: r.jointures,
        sauts_conservs: compte_sauts_conservs({ net: net }),
      },
    };
  }

  function vers_html(formate) {
    return formate.blocs.map(function (b) {
      if (b.type === "titre") return '<p class="ev-titre">' + echappe(b.texte) + "</p>";
      if (b.type === "liste") {
        if (!b.puces) {                                  // numérotée : le numéro reste dans le texte
          return b.items.map(function (x) {
            return '<p class="ev-item-numerote">' + echappe(x) + "</p>";
          }).join("");
        }
        return '<ul class="ev-liste">' + b.items.map(function (x) {
          return "<li>" + echappe(x) + "</li>";
        }).join("") + "</ul>";
      }
      return '<p class="ev-paragraphe">' + echappe(b.texte) + "</p>";
    }).join("");
  }

  /* RAW à l'écran, tel quel : le « texte brut » ne doit pas être une deuxième mise en page,
     c'est le contrôle. Les sauts de ligne d'origine restent visibles. */
  function brut_html(texte) {
    return "<pre class=\"ev-brut\">" + echappe(texte) + "</pre>";
  }

  /* L'invariant. Il accepte exactement les différences déclarées — et rien d'autre.
     `page` : la même métadonnée que celle passée à formater(), pour que R5 soit symétrique. */
  /* Ce qui reste quand on a retiré les séparateurs : la SÉQUENCE des lettres et des chiffres,
     dans l'ordre. Comparer deux séquences contrôle le contenu ET l'ordre — une permutation, une
     suppression, un ajout ou une dose changée la font diverger.

     Deux familles de différences sont retirées des DEUX côtés, jamais d'un seul :
       - les blancs, les traits d'union et les glyphes de puce (R2, R4, R6 : leur présence ou
         leur absence est un choix de présentation, chiffré dans le journal et vérifié par
         `audit_caracteres`, qui est le compte exact) ;
       - le numéro de page isolé (R5), seulement si `page` est fourni, comme dans formater().

     Rien d'autre n'est normalisé : pas de NFKD qui écraserait les accents, pas de minuscules,
     pas de dictionnaire. Le module ne « répare » pas la comparaison pour se la rendre facile. */
  var SEPARATEUR = new RegExp("[\\s" + PUCE_GLYPHES + "\u2013\u2014-]", "g");   // le tiret en dernier = littéral
  function canonical(texte, options) {
    var opt = options || {};
    var t = String(texte == null ? "" : texte);
    if (t.normalize) t = t.normalize("NFKC");
    var lignes = decoupe_lignes(t);
    if (opt.page !== undefined && opt.page !== null && opt.page !== "") {
      lignes = retire_numero(lignes, opt.page).lignes;      // R5, symétrique
    }
    return lignes.join("").replace(SEPARATEUR, "");
  }

  /* Comparaison de fidélité : même chaîne canonique = même contenu textuel.
     Retourne {fidele, ecart} avec un extrait de l'écart pour ne jamais échouer en silence. */
  function fidele(raw, display, options) {
    var a = canonical(raw, options), b = canonical(display, options);
    if (a === b) return { fidele: true, ecart: "" };
    var i = 0;
    while (i < a.length && a.charAt(i) === b.charAt(i)) i++;
    return {
      fidele: false,
      ecart: "à partir du caractère " + i + " : brut «…" + a.slice(Math.max(0, i - 40), i + 60)
           + "» contre affiché «…" + b.slice(Math.max(0, i - 40), i + 60) + "»",
    };
  }

  /* Audit indépendant de la comparaison canonique. `canonical` accepte les mêmes différences
     des DEUX côtés : une suppression accidentelle dans une règle passerait donc inaperçue.
     Celui-ci compte les caractères du RAW et du DISPLAY (blancs retirés) et n'admet que les
     différences CHIFFRÉES du journal : une puce remplacée, une césure recollée, un numéro de
     page déjà connu. Tout autre caractère manquant = échec. */
  function compte_caracteres(s) {
    var m = {};
    var t = String(s == null ? "" : s).replace(/\s+/g, "");
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      m[c] = (m[c] || 0) + 1;
    }
    return m;
  }

  function audit_caracteres(raw, display, journal, options) {
    var opt = options || {};
    var a = compte_caracteres(raw), b = compte_caracteres(display);
    var attendu = {};
    var j = journal || {};
    var cesures = j.cesures || 0;
    Object.keys(j.puces_par_glyphe || {}).forEach(function (g) {   // R6, consigné par glyphe
      var c = j.puces_par_glyphe[g];
      attendu[g] = (attendu[g] || 0) - c;                    // le glyphe disparaît
      attendu["-"] = (attendu["-"] || 0) + c;                // et devient un tiret d liste
    });
    attendu["-"] = (attendu["-"] || 0) - cesures;           // R9 retire le tiret de csure
    (j.numeros_retires || []).forEach(function (num) {     // R5 : que les chiffres de la page connue
      var c2 = compte_caracteres(num);
      Object.keys(c2).forEach(function (k) { attendu[k] = (attendu[k] || 0) - c2[k]; });
    });
    var ecarts = [], vus = {};
    Object.keys(a).concat(Object.keys(b)).forEach(function (c) {
      if (vus[c]) return;
      vus[c] = true;
      var delta = (b[c] || 0) - (a[c] || 0);
      var eu = attendu[c] || 0;
      if (delta !== eu) ecarts.push("« " + c + " » : brut " + (a[c] || 0) + ", affiché "
        + (b[c] || 0) + ", autorisé " + eu);
    });
    return { ok: ecarts.length === 0, ecarts: ecarts };
  }

  var module_ = {
    formater: formater, vers_html: vers_html, brut_html: brut_html,
    canonical: canonical, fidele: fidele, normalise_blancs: normalise_blancs,
    audit_caracteres: audit_caracteres, compte_caracteres: compte_caracteres,
  };
  global.A2MEDEvidenceView = module_;
  if (typeof module !== "undefined" && module.exports) module.exports = module_;
})(typeof window !== "undefined" ? window : globalThis);
