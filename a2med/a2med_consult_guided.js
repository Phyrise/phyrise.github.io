/* Consultation guidée dans la carte existante. Le flux n'affiche que des questions JSON
   complètes ; les choix n'apparaissent qu'après le résultat validé du serveur. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const API = String(document.body.dataset.api || window.A2MED_API_BASE || "").replace(/\/$/, "");
  const SESSION = "a2med_proxy_session:" + (API || location.origin);
  const toggle = $("guidedEnabled"), form = $("askForm");
  if (!toggle || !form) return;
  let supported = false, busy = false, trace = null, turn2Used = false;
  let seq = 0, raw = "", previewQuestions = [], saved = null, invalid = false;
  let decoder = null, draftItems = [], capabilityPromise = null, capabilityLoaded = false, capabilityChecked = false;
  let turn2Active = false;
  const hintDefault = "Expérimental : demande une précision si nécessaire.";
  const session = () => { try { return sessionStorage.getItem(SESSION); } catch { return null; } };
  const isUnlocked = () => { try { return sessionStorage.getItem("a2med_test_unlocked") === "1"; } catch { return false; } };
  function resetPanel() {
    const fields = $("guidedFields");
    if (fields) {
      if (window.A2MEDDocumentView) window.A2MEDDocumentView.nettoyer(fields);
      fields.textContent = "";
    }
    if ($("guidedPanel")) $("guidedPanel").hidden = true;
    if ($("guidedContinue")) $("guidedContinue").disabled = true;
    if ($("guidedError")) { $("guidedError").textContent = ""; $("guidedError").hidden = true; }
  }
  function reset() {
    seq++; raw = ""; previewQuestions = []; draftItems = [];
    if (decoder) decoder.reset();
    decoder = window.A2MEDStreamView ? window.A2MEDStreamView.creer() : null;
    if ($("draftList")) $("draftList").textContent = "";
    if ($("draftMore")) $("draftMore").hidden = true;
    trace = null; turn2Used = false; resetPanel();
  }
  function mode() { return document.querySelector('input[name="mode"]:checked')?.value || "courte"; }
  function restore() {
    if (!saved) return;
    const m = document.querySelector('input[name="mode"][value="' + CSS.escape(saved.mode) + '"]');
    if (m) m.checked = true;
    if (saved.model) {
      const model = document.querySelector('input[name="model"][value="' + CSS.escape(saved.model) + '"]');
      if (model) model.checked = true;
    }
    saved = null;
    window.updateMode?.();
  }
  function controls() {
    if (!toggle) return;
    const sourcesOnly = mode() === "sources";
    if (sourcesOnly && toggle.checked) { toggle.checked = false; restore(); reset(); }
    const normalBusy = !!$("askBtn")?.disabled && !busy;
    toggle.disabled = !supported || sourcesOnly || busy || normalBusy;
    $("guidedHint").textContent = !supported
      ? (capabilityChecked ? "Guidé expérimental — indisponible sur ce service." : "Vérification du guidage…")
      : sourcesOnly ? "Guidé expérimental — choisissez un mode avec génération."
      : toggle.checked ? "Expérimental · Flash · réponse standard."
      : hintDefault;
    document.querySelectorAll('input[name="mode"],input[name="model"]').forEach(el => {
      if (el.dataset.guidedBaseDisabled === undefined)
        el.dataset.guidedBaseDisabled = String(el.disabled);
      el.disabled = (toggle.checked && supported) || normalBusy
        || el.dataset.guidedBaseDisabled === "true";
    });
  }
  async function get(path, body, signal) {
    const headers = { "Content-Type": "application/json" };
    if (session()) headers["X-A2Med-Session"] = session();
    let r;
    try { r = window.apiFetch
      ? await window.apiFetch(path, { method:"POST", headers, body:JSON.stringify(body), signal })
      : await fetch(API + path, { method:"POST", headers, credentials:"include",
          body:JSON.stringify(body), signal }); }
    catch (e) { throw new Error(e.name === "AbortError" ? "Le calcul guidé a dépassé le délai prévu."
      : "Le service de Consultation ne répond pas."); }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {}
      throw window.A2MEDContract.httpError(r, text, data.trace_id);
    }
    return r;
  }
  async function checkCapabilities() {
    if (capabilityLoaded || capabilityPromise) return capabilityPromise;
    const headers = {}; if (session()) headers["X-A2Med-Session"] = session();
    capabilityPromise = (async () => {
      try {
        const r = window.apiFetch ? await window.apiFetch("/api/capabilities")
          : await fetch(API + "/api/capabilities", { headers, credentials:"include" });
        supported = r.ok && (await r.json()).guided_consult === true;
        capabilityLoaded = r.ok;
      } catch { supported = false; }
      capabilityChecked = true; controls();
    })();
    try { await capabilityPromise; } finally { capabilityPromise = null; }
  }
  function drawPreview() {
    const panel = $("guidedPanel"), fields = $("guidedFields");
    if (!panel || !fields) return;
    fields.textContent = "";
    previewQuestions.slice(0, 3).forEach(q => {
      const p = document.createElement("p"); p.className = "guided-preview-question";
      p.textContent = q; fields.append(p);
    });
    panel.hidden = !previewQuestions.length;
    $("guidedContinue").disabled = true;
  }
  function textDelta(text) {
    const delta = String(text || "");
    if (decoder) {
      const decoded = decoder.delta(delta);
      if (decoded.textes.length) {
        if ($("answerCard").dataset.view !== "drafting") {
          window.setView?.("drafting");
          $("draftFlag").textContent = "Analyse guidée en cours — éléments non vérifiés";
        }
        draftItems = draftItems.concat(decoded.textes);
        $("draftList").textContent = "";
        draftItems.slice(0, 30).forEach(value => {
          const li = document.createElement("li"); li.textContent = value; $("draftList").append(li);
        });
      }
      if (decoded.debordement && $("draftMore")) {
        $("draftMore").textContent = "Affichage limité pendant l’analyse ; le résultat complet sera affiché après validation.";
        $("draftMore").hidden = false;
      }
    }
    raw += delta;
    const re = /"question"[ \t]*:[ \t]*"((?:[^"\\]|\\.)*)"/g, found = [];
    for (const m of raw.matchAll(re)) {
      try {
        const q = JSON.parse('"' + m[1] + '"').trim();
        if (q && !previewQuestions.includes(q)) found.push(q);
      } catch { /* chaîne incomplète : ne rien afficher */ }
    }
    if (found.length) { previewQuestions = previewQuestions.concat(found).slice(0, 3); drawPreview(); }
  }
  function progress(name) {
    const steps = { retrieval:0, selection:1, rerank:1, generation:2, analysis:2,
      validation:3, generation_terminee:3 };
    if (steps[name] !== undefined && window.setStep) window.setStep(steps[name]);
    const labels = { retrieval:"Recherche dans les recommandations", selection:"Sélection des passages",
      rerank:"Vérification de la pertinence",
      generation:turn2Active ? "Rédaction de la réponse" : "Analyse guidée en cours",
      analysis:"Analyse guidée en cours",
      validation:turn2Active ? "Vérification des citations" : "Validation des questions et des preuves",
      generation_terminee:turn2Active ? "Vérification des citations" : "Validation des questions et des preuves" };
    if (labels[name]) $("progressLead").textContent = labels[name];
    if ((name === "generation" || name === "analysis") && $("answerCard").dataset.view !== "drafting") {
      window.setView?.("drafting");
      $("draftFlag").textContent = turn2Active ? "Rédaction en cours — non vérifiée"
        : "Analyse guidée en cours — éléments non vérifiés";
    }
    if (name === "validation" || name === "generation_terminee") window.setView?.("checking");
  }
  async function stream(path, body, requestSeq) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 180000);
    try {
      const r = await get(path, body, abort.signal), reader = r.body.getReader(), textDecoder = new TextDecoder();
      let buf = "", out = null, failure = null;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        buf += textDecoder.decode(part.value, { stream:true });
        let at;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0,at); buf = buf.slice(at+2);
          const ev = /^event:[ \t]*(.+)$/m.exec(frame)?.[1];
          const d = /^data:[ \t]*(.+)$/m.exec(frame)?.[1];
          if (!ev) continue;
          let data = {}; try { data = d ? JSON.parse(d) : {}; } catch {}
          if (requestSeq !== seq) return null;
          if (ev === "stage") progress(data.name || data.stage);
          else if (ev === "text_delta") {
            if ($("answerCard").dataset.view !== "drafting") {
              window.setView?.("drafting");
              $("draftFlag").textContent = "Analyse guidée en cours — éléments non vérifiés";
            }
            textDelta(data.text);
          }
          else if (ev === "reset") {
            raw = ""; previewQuestions = []; draftItems = [];
            if (decoder) decoder.reset();
            if ($("draftList")) $("draftList").textContent = "";
            drawPreview();
            window.setView?.("search");
          }
          else if (ev === "validation" && data.stage === "generation_terminee") progress("generation_terminee");
          else if (ev === "done") { out = data; break; }
          else if (ev === "error") { failure = data.message_technique || data.error || "Le calcul guidé a échoué."; break; }
        }
        if (out || failure) break;
      }
      if (failure) throw new Error(failure);
      if (!out) throw new Error("Le flux s’est arrêté avant validation. Aucun résultat n’est affiché.");
      return out;
    } finally { clearTimeout(timer); }
  }
  function adapt(out, question) {
    const claims = Array.isArray(out.claims) ? out.claims : [];
    const allSources = Array.isArray(out.sources) ? out.sources.map(s => Object.assign({}, s)) : [];
    const cited = new Set(claims.flatMap(c => Array.isArray(c.refs) ? c.refs : []));
    const sources = ["ANSWER", "CONDITIONAL_ANSWER"].includes(out.status)
      ? allSources.filter(s => cited.has(s.ref)) : allSources;
    const generator = out.generator || {};
    return { question:question, status:out.status,
      status_requested:out.status_requested || out.asked_status || out.status,
      answer:claims.map(c => ({ text:c.claim, refs:Array.isArray(c.refs)?c.refs:[], citation_valid:true })),
      sources:sources, source_meta:out.source_meta || {},
      limitations:out.limitations || [], reason:out.reason || "", timings:out.timings || {},
      technique:{
        n_passages:out.n_passages ?? "non communiqué",
        n_pool:out.n_pool ?? "non communiqué",
        context_depth:out.context_depth ?? "non communiqué",
        n_claims:out.n_claims ?? claims.length, n_sources:sources.length,
        claims_all_valid:out.claims_all_valid ?? true,
        gen_model:generator.model || generator.label || "Flash (modèle fixe)",
        generation_prompt_sha256:out.prompt_sha256 || "non communiqué",
        obsolete_excluded_stems:out.obsolete_excluded_stems || ["non communiqué"],
        sampling:generator.sampling || {temperature:0,max_tokens:2000,enable_thinking:false}
      },
      reuse_context:out.reuse_mode === "A", stream_stats:out.stream_stats || null, guided:true, trace_id:out.trace_id };
  }
  function why(field, c, sources) {
    const ranks = new Set((c.evidence || []).map(x => parseInt(String(x).replace(/\D/g,""),10)));
    const d = document.createElement("details"); d.className = "guided-why";
    const sum = document.createElement("summary"); sum.textContent = "Pourquoi ? Voir le passage source"; d.append(sum);
    (sources || []).filter(s => ranks.has(Number(s.retrieval_rank))).forEach(s => {
      const item = document.createElement("div"), label = document.createElement("p");
      item.className = "guided-proof"; label.className = "fine";
      label.textContent = String(s.ref || "") + " · " + String(s.document || "")
        + " · repère du registre " + String(s.page ?? "non transmis");
      item.append(label);
      if (window.A2MEDDocumentView && s.document) {
        const slot = document.createElement("div"); item.append(slot);
        window.A2MEDDocumentView.creer(API,{document:s.document,page:s.page},{
          apiFetch:(path,init)=>window.apiFetch
            ? window.apiFetch(path,Object.assign({},init,{preserveDocumentView:true}))
            : fetchWithSession(path,init)
        }).then(v=>{ if(slot.isConnected) slot.append(v); else v._disposeDocumentView?.(); }).catch(()=>{});
      }
      const quote = document.createElement("blockquote"); quote.textContent = String(s.excerpt || "");
      item.append(quote); d.append(item);
    });
    field.append(d);
  }
  function fetchWithSession(path,init) {
    const headers = Object.assign({},init.headers || {}); if(session()) headers["X-A2Med-Session"]=session();
    return fetch(API+path,Object.assign({},init,{headers,credentials:"include"}));
  }
  function makeClarification(c,i,sources) {
    const ctl = c.control || {}, types = ["yes_no_unknown","threshold_choice","numeric","enum"];
    if (!types.includes(ctl.type)) {
      invalid = true; const p=document.createElement("p"); p.className="fine";
      p.textContent="Précision non affichée : type de réponse non reconnu."; return p;
    }
    const fs=document.createElement("fieldset"); fs.className="guided-field";
    fs.dataset.factor=String(c.factor || "f"+i); fs.dataset.type=ctl.type;
    const legend=document.createElement("legend"); legend.textContent=String(c.question || "").trim() || "Précision clinique";
    fs.append(legend); const name="guided-"+i;
    function radios(opts) {
      const row=document.createElement("div"); row.className="guided-choices";
      opts.forEach((o,k)=>{ const val=String(o.value ?? ""), text=String(o.label ?? val); if(!val.trim()||!text.trim()) return;
        const label=document.createElement("label"), input=document.createElement("input"), span=document.createElement("span");
        input.type="radio"; input.name=name; input.value=val; input.id=name+"-"+k; span.textContent=text;
        label.append(input,span); row.append(label);
      }); fs.append(row);
    }
    if(ctl.type==="yes_no_unknown") radios([{value:"non",label:"Non"},{value:"oui",label:"Oui"},{value:"inconnu",label:"Inconnu"}]);
    else if(ctl.type==="enum"||ctl.type==="threshold_choice") {
      const opts=Array.isArray(ctl.options)?ctl.options:[];
      if(!opts.length) invalid=true;
      radios(opts.map(o=>typeof o==="string"?{value:o,label:o}:{value:o?.value,label:o?.label ?? o?.value}));
    } else {
      const row=document.createElement("div"); row.className="guided-number";
      const input=document.createElement("input"); input.type="text"; input.inputMode="decimal";
      input.name=name; input.id=name; input.autocomplete="off"; input.pattern="[0-9]{1,3}([.,][0-9]{1,2})?"; input.placeholder="valeur";
      const unit=document.createElement("label"); unit.textContent=String(ctl.unit||""); unit.htmlFor=name;
      const label=document.createElement("label"); label.className="guided-unknown";
      const unknown=document.createElement("input"); unknown.type="radio"; unknown.name=name; unknown.value="inconnu";
      const text=document.createElement("span"); text.textContent="Inconnu"; label.append(unknown,text);
      input.addEventListener("input",()=>{unknown.checked=false;});
      unknown.addEventListener("change",()=>{if(unknown.checked)input.value="";});
      row.append(input,unit,label); fs.append(row);
    }
    why(fs,c,sources); return fs;
  }
  function collect() {
    const values={}, missing=[];
    $("guidedFields").querySelectorAll("fieldset.guided-field").forEach(fs=>{
      let val=null;
      if(fs.dataset.type==="numeric") {
        const text=fs.querySelector('input[type="text"]')?.value||"", unk=fs.querySelector('input[type="radio"]:checked');
        if(unk) val=unk.value; else if(/^\d{1,3}([.,]\d{1,2})?$/.test(text.trim())) val=text.trim();
      } else val=fs.querySelector('input[type="radio"]:checked')?.value ?? null;
      if(val===null) missing.push(fs.dataset.factor); else values[fs.dataset.factor]=val;
    });
    return {values,missing};
  }
  function fail(message) { $("guidedError").textContent=message; $("guidedError").hidden=false; }
  async function turn2(question) {
    if(busy||!trace||turn2Used)return;
    const ans=collect(); if(ans.missing.length){fail("Répondez à chaque précision ou choisissez « Inconnu » avant de continuer.");return;}
    busy=true; turn2Used=true; turn2Active=true; const id=seq; let completed=false;
    const began=Date.now();
    $("guidedContinue").disabled=true; $("askBtn").disabled=true;
    $("guidedFields").querySelectorAll("input").forEach(el=>{el.disabled=true;});
    controls();
    $("error").hidden=true; window.startProgress?.("standard",true); $("progressLead").textContent="Réponse à partir des précisions et des preuves";
    try {
      const out=await stream("/api/consult-guided/turn2/stream",{trace_id:trace,answers:ans.values,mode:"A"},id);
      if(id!==seq||!out)return; completed=true; trace=null;
      resetPanel();
      out.timings=out.timings||{};
      if(!Number.isFinite(out.timings.t_total_s))out.timings.t_total_s=(Date.now()-began)/1000;
      window.render(adapt(out,question));
      window.say?.("Réponse guidée vérifiée à partir des sources citées."); window.remember?.(question,out.status);
    } catch(e) {
      if(id===seq) {
        draftItems=[]; if(decoder)decoder.reset();
        $("draftList").textContent=""; $("draftMore").hidden=true;
        window.setView?.("result");
        fail(String(e.message||e));
      }
    }
    finally {
      window.stopProgress?.(); busy=false; turn2Active=false; $("askBtn").disabled=false;
      if(!completed&&id===seq) {
        turn2Used=false; $("guidedContinue").disabled=false;
        $("guidedFields").querySelectorAll("input").forEach(el=>{el.disabled=false;});
      }
      controls();
    }
  }
  function showClarifications(out,question) {
    const fields=$("guidedFields"); fields.textContent=""; invalid=false;
    (out.clarifications||[]).slice(0,3).forEach((c,i)=>fields.append(makeClarification(c,i,out.sources||[])));
    $("guidedPanel").hidden=false;
    $("guidedContinue").disabled=invalid||!fields.querySelector("fieldset.guided-field");
    $("guidedContinue").onclick=()=>turn2(question);
  }
  async function askGuided(question) {
    busy=true; $("askBtn").disabled=true; controls(); reset(); const id=seq;
    const began=Date.now();
    $("error").hidden=true; $("result").hidden=false; window.startProgress?.("standard");
    $("progressLead").textContent="Recherche et analyse guidées";
    $("progressNote").innerHTML='En attente du moteur. <span id="elapsed"></span>';
    window.setView?.("search");
    $("answer").textContent=""; $("limits").textContent=""; $("limits").hidden=true;
    $("sourcesPanel").hidden=true; $("provisionalBanner").hidden=true;
    $("copyAllBtn").hidden=true; $("statusCode").textContent="";
    $("statusMeaning").textContent=""; $("answerTime").textContent="";
    $("tech").textContent=""; $("resultTiming").hidden=true;
    if ($("answerModel")) $("answerModel").hidden=true;
    try {
      const out=await stream("/api/consult-guided/ask/stream",{question},id);
      if(id!==seq||!out)return;
      out.timings=out.timings||{};
      if(!Number.isFinite(out.timings.t_total_s))out.timings.t_total_s=(Date.now()-began)/1000;
      trace=out.trace_id||null; turn2Used=false; resetPanel(); window.render(adapt(out,question));
      if(out.status==="CLARIFICATION"&&(out.clarifications||[]).length) {
        showClarifications(out,question); $("answerCard").dataset.status="CLARIFICATION";
        $("statusCode").textContent="Précisions nécessaires";
        const elapsed = out.timings && Number.isFinite(out.timings.t_total_s)
          ? " · " + out.timings.t_total_s.toFixed(1) + " s" : "";
        $("answerTime").textContent=elapsed.replace(/^ · /, "");
        $("sourcesTitle").textContent="Sources examinées pour les précisions ("+(out.sources||[]).length+")";
        $("answer").textContent=""; $("limits").hidden=true; $("copyAllBtn").hidden=true;
        window.say?.("Choisissez une réponse ou « Inconnu », puis continuez.");
      } else {
        trace=null; window.say?.("Résultat guidé validé."); window.remember?.(question,out.status);
      }
    } catch(e) {
      if(id===seq) {
        resetPanel(); draftItems=[]; if(decoder)decoder.reset();
        window.showFailure?.(String(e.message||e));
      }
    } finally { window.stopProgress?.(); busy=false; $("askBtn").disabled=false; controls(); }
  }
  toggle.checked = false; // Le choix ne survit jamais à une nouvelle page, y compris au retour bfcache.
  reset();
  window.addEventListener("pageshow", event => {
    if (event.persisted) { toggle.checked = false; restore(); reset(); controls(); }
  });
  toggle.addEventListener("change",()=>{
    if(busy){toggle.checked=!toggle.checked;return;}
    if(toggle.checked) {
      saved={mode:mode(),model:document.querySelector('input[name="model"]:checked')?.value||null};
      const standard=document.querySelector('input[name="mode"][value="standard"]'); if(standard)standard.checked=true;
      const flash=document.querySelector('input[name="model"][value="flash"]'); if(flash&&!flash.disabled)flash.checked=true;
      window.updateMode?.();
    } else restore();
    reset(); controls(); $("error").hidden=true;
  });
  document.querySelectorAll('input[name="mode"]').forEach(el=>el.addEventListener("change",()=>{
    if(mode()==="sources"&&toggle.checked){toggle.checked=false;restore();reset();} controls();
  }));
  form.addEventListener("submit",event=>{
    if (busy) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if ($("askBtn").disabled) return;
    reset();
    if(!toggle.checked||mode()==="sources"||!supported)return;
    event.preventDefault();event.stopImmediatePropagation();
    const q=$("q").value.trim();
    if (!q) { $("q").focus(); return; }
    const max = Number($("q").maxLength);
    if (max > 0 && q.length > max) {
      $("guidedError").textContent="Question trop longue : maximum "+max+" caractères.";
      $("guidedError").hidden=false; return;
    }
    askGuided(q);
  },true);
  const health=$("healthText");
  if(health&&typeof MutationObserver!=="undefined")new MutationObserver(()=>{
    if(health.textContent==="Service prêt"||isUnlocked())checkCapabilities();
  }).observe(health,{childList:true,characterData:true,subtree:true});
  if ($("askBtn") && typeof MutationObserver !== "undefined")
    new MutationObserver(controls).observe($("askBtn"), { attributes:true, attributeFilter:["disabled"] });
  if (typeof MutationObserver !== "undefined" && $("modelOptions"))
    new MutationObserver(controls).observe($("modelOptions"), { childList:true, subtree:true });
  controls();
  if(isUnlocked())checkCapabilities();
})();
