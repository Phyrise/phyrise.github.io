'use strict';
const $=id=>document.getElementById(id);
let data,view='library',domain='',selected=null,pageNumber=1,imageTicket=0;
const compare=new Intl.Collator('fr',{sensitivity:'base',numeric:true});
const normalize=text=>String(text||'').normalize('NFD').replace(/\p{Mn}/gu,'').toLowerCase();
function element(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=text;return node;}
function date(value){if(!value)return 'Non renseignée';if(/^\d{4}$/.test(value))return value;const month=/^\d{4}-\d{2}$/.test(value);return new Intl.DateTimeFormat('fr-FR',{day:month?undefined:'numeric',month:'long',year:'numeric',timeZone:'Asia/Tokyo'}).format(new Date(month?value+'-01T00:00:00Z':value));}
function status(doc){
 const f=doc.flags;
 if(f.includes('archive'))return ['Archive conservée','amber'];
 if(f.includes('updated'))return ['Version intégrée','green'];
 if(f.includes('exclude'))return ['Obsolète à écarter','red'];
 if(f.includes('update'))return ['À actualiser','amber'];
 if(f.includes('candidate'))return ['À examiner','blue'];
 if(f.includes('excluded'))return ['Hors recherche',''];
 if(f.includes('training'))return ['Formation','blue'];
 if(f.includes('revision'))return ['Révision signalée','amber'];
 if(f.includes('keep'))return ['Copie à conserver',''];
 if(doc.check_result==='checked')return ['Fichier identique','green'];
 return ['À vérifier',''];
}
function badge(doc){const [label,tone]=status(doc);return element('span','badge '+tone,label);}
function setView(next){view=next;$('library-view').hidden=view!=='library';$('updates-view').hidden=view!=='updates';document.querySelector('.workspace').classList.toggle('has-document',view==='library'&&selected!==null);for(const b of document.querySelectorAll('[data-view]'))b.classList.toggle('active',b.dataset.view===view);$('page-title').textContent=view==='library'?'Bibliothèque documentaire':'Suivi des mises à jour';$('intro').textContent=view==='library'?'Retrouver un document, vérifier sa version et lire l’original.':'Consulter les versions intégrées et les décisions de conservation.';}
function filtered(){const words=normalize($('search').value).trim().split(/\s+/).filter(Boolean),scope=$('scope').value,state=$('state').value;
 const docs=data.documents.filter(doc=>(!domain||doc.domain===domain)&&(scope==='all'||doc.scope===scope)&&(state==='all'||doc.flags.includes(state))&&words.every(w=>normalize([doc.title,doc.filename,doc.domain,doc.kind,doc.year].join(' ')).includes(w)));
 const sort=$('sort').value;docs.sort((a,b)=>sort==='year'?(b.year||0)-(a.year||0)||compare.compare(a.title,b.title):sort==='domain'?compare.compare(a.domain,b.domain)||compare.compare(a.title,b.title):compare.compare(a.title,b.title));return docs;}
function clearDocument(){selected=null;imageTicket++;$('viewer-content').replaceChildren();$('viewer-content').hidden=true;$('viewer-empty').hidden=false;setView('library');}
function renderDomains(){const container=$('domains');container.replaceChildren();const all=element('button','domain'+(!domain?' active':''));all.type='button';all.append(element('span','', 'Tous les domaines'),element('span','',data.stats.installed));all.onclick=()=>{domain='';setView('library');renderDomains();renderList();};container.append(all);
 for(const name of data.domains){const count=data.documents.filter(d=>d.scope==='installed'&&d.domain===name).length;const b=element('button','domain'+(domain===name?' active':''));b.type='button';b.append(element('span','',name),element('span','',count));b.setAttribute('aria-pressed',String(domain===name));b.onclick=()=>{domain=name;clearDocument();renderDomains();renderList();};container.append(b);}}
function renderList(){const docs=filtered();$('results-count').textContent=docs.length+' document'+(docs.length>1?'s':'')+(domain?' · '+domain:'');$('reset').hidden=!domain&&!$('search').value&&$('scope').value==='installed'&&$('state').value==='all';const list=$('document-list');list.replaceChildren();
 for(const doc of docs){const b=element('button','doc-row');b.type='button';b.dataset.document=doc.id;b.setAttribute('aria-pressed',String(doc.id===selected));b.append(element('span','doc-title',doc.title));const sub=element('span','doc-sub');sub.append(element('span','',doc.kind),element('span','',doc.year?String(doc.year):'Année à préciser'),badge(doc));b.append(sub,element('span','doc-domain',doc.domain+' · '+doc.pages+' pages PDF'));b.onclick=()=>openDocument(doc.id);list.append(b);}
 if(!docs.length){const empty=element('div','empty-results');empty.append(element('strong','', 'Aucun document ne correspond.'),element('p','','Essayez un autre titre ou retirez un filtre.'));list.append(empty);}}
function makeLink(text,url,cls='small-button'){const a=element('a',cls,text);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function metaPair(dl,title,value,cls){dl.append(element('dt','',title),element('dd',cls||'',value));}
function openDocument(id,reveal=false){const doc=data.documents.find(d=>d.id===id);if(!doc)return;if(reveal){domain='';$('search').value='';$('state').value='all';$('scope').value=doc.scope;renderDomains();}selected=id;pageNumber=1;setView('library');renderList();const body=$('viewer-content');body.replaceChildren();$('viewer-empty').hidden=true;body.hidden=false;
 const back=element('button','quiet back-list','← Retour aux documents');back.type='button';back.onclick=()=>{clearDocument();renderList();};body.append(back);
 const head=element('div','viewer-head');head.append(element('span','domain-name',doc.domain),element('h2','',doc.title));const line=element('div','viewer-summary');line.append(badge(doc),element('span','',doc.scope==='installed'?'Version du pack mobile':'Document repéré · pas encore dans le pack'),element('span','',doc.format==='pptx'?'Diaporama converti en PDF':'PDF'));head.append(line);body.append(head);
 if(['update','exclude','candidate','training','keep','revision','archive'].some(f=>doc.flags.includes(f))){let text=doc.message;if(doc.flags.includes('revision')&&!doc.flags.includes('update'))text='La page SPILF signale une révision en cours pour cette entrée. Cela ne signifie pas que la copie est déjà remplacée.';body.append(element('div','callout '+(doc.flags.includes('training')?'blue':doc.flags.includes('keep')?'neutral':''),text));}
 const nav=element('div','page-nav'),buttons=element('div','page-buttons');const previous=element('button','','←');previous.id='page-prev';previous.type='button';previous.setAttribute('aria-label','Page précédente');previous.onclick=()=>changePage(-1);const count=element('span','','');count.id='page-count';const next=element('button','','→');next.id='page-next';next.type='button';next.setAttribute('aria-label','Page suivante');next.onclick=()=>changePage(1);buttons.append(previous,count,next);const full=element('button','small-button','PDF complet ↗');full.type='button';full.onclick=()=>openPdf(doc,full);nav.append(buttons,full);body.append(nav);
 const preview=element('div','preview-area');preview.id='preview';preview.setAttribute('aria-live','polite');body.append(preview);
 const links=element('div','viewer-links');if(doc.source_url)links.append(makeLink('Source officielle ↗',doc.source_url));if(doc.new_source_url&&doc.flags.includes('update'))links.append(makeLink('Nouveau diaporama ↗',doc.new_source_url));if(doc.related_candidate){const b=element('button','small-button','Lire l’édition 2026');b.type='button';b.onclick=()=>openDocument(doc.related_candidate,true);links.append(b);}body.append(links);
 const details=element('details','viewer-meta'),summary=element('summary','','Version, dates et référence');const dl=element('dl','meta-grid');metaPair(dl,'Dans la recherche',doc.scope==='candidate'?'Non — intégration à examiner':doc.in_search?'Oui'+(doc.flags.includes('exclude')?' — exclusion encore à appliquer':''):'Non — déjà exclu');metaPair(dl,'Date du document',doc.document_date?date(doc.document_date):'Non renseignée');if(doc.document_date_label)metaPair(dl,'Origine de cette date',doc.document_date_label);metaPair(dl,'Année indiquée',doc.year?String(doc.year)+' — repère de classement':'Non renseignée');metaPair(dl,'Contrôle de la source',doc.checked_at?date(doc.checked_at):'Non vérifié dans ce contrôle');metaPair(dl,'Résultat du contrôle',doc.message);metaPair(dl,'Import initial',doc.imported_at?date(doc.imported_at):'Non renseigné');if(doc.installed_at)metaPair(dl,'Intégré au pack',date(doc.installed_at));if(doc.coverage)metaPair(dl,'Couverture de recherche',doc.coverage.indexed_pages+' / '+doc.coverage.total_pages+' pages PDF');metaPair(dl,'Passages indexés',doc.passages===null?'Pas encore indexé':doc.passages+' au total · '+doc.eligible_passages+' éligibles');metaPair(dl,'Fichier original',doc.filename,'filename');metaPair(dl,'Empreinte du PDF',doc.sha256,'filename');details.append(summary,dl);body.append(details);
 loadPage();if(matchMedia('(max-width:900px)').matches)document.querySelector('.workspace').scrollIntoView({block:'start'});
}
function changePage(delta){const doc=data.documents.find(d=>d.id===selected);if(!doc)return;pageNumber=Math.max(1,Math.min(doc.pages,pageNumber+delta));loadPage();}
async function loadPage(){const doc=data.documents.find(d=>d.id===selected);if(!doc)return;const mine=++imageTicket,number=pageNumber,preview=$('preview');$('page-count').textContent=number+' / '+doc.pages;$('page-prev').disabled=number===1;$('page-next').disabled=number===doc.pages;preview.replaceChildren();const note=element('p','preview-note');note.append(element('span','loading-ring'),document.createTextNode('Ouverture de la page originale…'));preview.append(note);
 try{const response=await documentFetch('/pages/'+doc.id+'/'+number+'.png');if(!response.ok)throw Error('Aperçu indisponible');const blob=await response.blob();if(mine!==imageTicket)return;const url=URL.createObjectURL(blob),img=new Image();img.alt=doc.title+' — page PDF '+number;img.onload=()=>{URL.revokeObjectURL(url);if(mine===imageTicket)preview.replaceChildren(img);};img.onerror=()=>{URL.revokeObjectURL(url);if(mine===imageTicket)pageError();};img.src=url;}catch(error){if(mine===imageTicket){if(error.auth)showAccess();else pageError();}}}

const LIBRARY_API=window.A2MED_DOCUMENTS_API,SESSION_API=window.A2MED_SESSION_API;
const SESSION_KEY='a2med_proxy_session:'+SESSION_API;
let memorySession='';
function storedSession(){try{return sessionStorage.getItem(SESSION_KEY)||memorySession;}catch{return memorySession;}}
async function documentFetch(path){
 const headers=new Headers();const token=storedSession();if(token)headers.set('X-A2Med-Session',token);
 const r=await fetch(LIBRARY_API+path,{headers,credentials:'omit'});
 if(r.status===401||r.status===403){const error=new Error('Accès requis');error.auth=true;throw error;}
 if(!r.ok)throw new Error('Document temporairement indisponible');return r;
}
function showAccess(){
 const preview=$('preview');if(!preview)return;preview.replaceChildren();
 const form=element('form','library-access'),title=element('strong','','Accéder aux documents originaux');
 const hint=element('p','','Utilisez le même mot de passe que pour Consultation.');
 const label=element('label','','Mot de passe'),input=element('input');input.type='password';input.id='documents-password';input.autocomplete='current-password';input.required=true;label.htmlFor=input.id;
 const submit=element('button','small-button','Ouvrir les documents');submit.type='submit';
 const error=element('p','access-error');error.setAttribute('role','alert');
 form.append(title,hint,label,input,submit,error);preview.append(form);
 form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;error.textContent='';
  try{const r=await fetch(LIBRARY_API+'/__auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:input.value}),credentials:'omit'});if(!r.ok)throw Error(r.status===401?'Mot de passe refusé.':'Accès temporairement indisponible.');const value=await r.json();if(!value.session)throw Error('Session indisponible.');memorySession=value.session;try{sessionStorage.setItem(SESSION_KEY,value.session);}catch{}input.value='';loadPage();}
  catch(e){error.textContent=e.message;}finally{submit.disabled=false;}
 };
}
async function openPdf(doc,button){
 const tab=window.open('about:blank','_blank');if(tab){tab.opener=null;tab.document.title='Ouverture du PDF…';}
 button.disabled=true;
 try{const r=await documentFetch('/documents/'+doc.id+'.pdf');const blob=await r.blob();const url=URL.createObjectURL(blob);if(tab&&!tab.closed)tab.location.replace(url+'#page='+pageNumber);else{const link=makeLink('Ouvrir le PDF téléchargé ↗',url);$('viewer-content').append(link);}}
 catch(e){if(tab)tab.close();if(e.auth)showAccess();else{const note=element('p','pdf-open-error','Le PDF est temporairement indisponible. Réessayez ou consultez le lien de la source officielle.');$('viewer-content').append(note);}}
 finally{button.disabled=false;}
}

function pageError(){const preview=$('preview');preview.replaceChildren();const note=element('p','preview-note','Cette page n’a pas pu être prévisualisée. Le PDF complet reste accessible.');const retry=element('button','small-button','Réessayer');retry.type='button';retry.onclick=()=>loadPage();preview.append(note,retry);}
function renderTasks(){for(const [type,target]of [['action','tasks'],['keep','keep-tasks']]){const parent=$(target);parent.replaceChildren();for(const task of data.tasks.filter(t=>t.type===type)){const card=element('article','task');const text=element('div');text.append(element('h3','',task.title),element('p','',task.detail));const buttons=element('div','task-actions');for(const [i,id]of task.doc_ids.entries()){const doc=data.documents.find(d=>d.id===id);const b=element('button',i?'secondary':'',doc.scope==='candidate'?'Lire le document repéré':task.doc_ids.length>1?'Voir notre copie':'Voir le document');b.type='button';b.onclick=()=>openDocument(id,true);buttons.append(b);}card.append(text,buttons);parent.append(card);}}}
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>setView(b.dataset.view);
$('search').oninput=()=>renderList();for(const id of ['scope','state','sort'])$(id).onchange=()=>renderList();
$('reset').onclick=()=>{domain='';$('search').value='';$('scope').value='installed';$('state').value='all';renderDomains();renderList();};
$('stat-docs').onclick=()=>{clearDocument();$('scope').value='installed';$('state').value='all';domain='';$('search').value='';renderDomains();renderList();};$('stat-actions').onclick=()=>setView('updates');
$('about-open').onclick=()=>$('about').showModal();$('about-close').onclick=()=>$('about').close();$('about').onclick=e=>{if(e.target===$('about'))$('about').close();};
function renderCompleted(){const entries=data.completed_updates||[];$('completed-section').hidden=!entries.length;for(const entry of entries){const card=element('article','task'),text=element('div');text.append(element('h3','',entry.title),element('p','',entry.detail));const buttons=element('div','task-actions');for(const id of entry.doc_ids){const b=element('button','','Voir la version intégrée');b.type='button';b.onclick=()=>openDocument(id,true);buttons.append(b);}card.append(text,buttons);$('completed-tasks').append(card);}if(!data.stats.actions)$('tasks').append(element('p','muted','Toutes les actions confirmées pour ce pack ont été traitées.'));if(data.prepared_at){$('pack-status').textContent='Pack préparé le '+date(data.prepared_at)+(data.deployed_to_phone?' · installé sur le téléphone.':' · installation sur téléphone en attente.');$('about-state').textContent=data.notice+' Cette page ne surveille pas automatiquement le site.';}}
fetch('./documents.json?v=20261020').then(r=>{if(!r.ok)throw Error();return r.json();}).then(catalogue=>{data=catalogue;$('count-installed').textContent=data.stats.installed;$('count-active').textContent=data.stats.in_search;$('count-actions').textContent=data.stats.actions;$('nav-total').textContent=data.stats.installed;$('nav-actions').textContent=data.stats.actions;$('task-count').textContent=data.stats.actions;$('snapshot').textContent=date(data.source_checked_at);$('audit-date').textContent=date(data.source_checked_at);$('pack-label').textContent=data.pack_label;$('load-status').textContent='';$('audit-limits').append(element('p','',data.audit.direct_documents_checked+' liens directs ont été contrôlés. '+data.audit.network_failures+' accès ont échoué et '+data.audit.html_instead_of_document+' téléchargements ont renvoyé du HTML plutôt qu’un document. Les documents absents ne sont pas ajoutés automatiquement.'),element('p','','Tuberculose : la page SPILF indique toujours une révision en cours. Les trois documents du pack sont des supports de formation, pas une recommandation actuelle.'));renderDomains();renderList();renderTasks();renderCompleted();}).catch(()=>{$('load-status').textContent='L’inventaire n’a pas pu être chargé. Rechargez la page.';});
