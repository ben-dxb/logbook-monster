'use strict';
/* Supplements view: a log of what you took each day, picked from the supplement library or typed in
   free text, with an amount and a unit (g, mg, mcg, IU, capsules…), and the library itself – your own
   supplements plus ones other people have shared.
   #supps, #supps/2026-10-15 (a day's log), #supps/lib, #supps/lib/new, #supps/lib/12 (edit one of yours).
   "Trend" on a supplement follows it (by name) on the Timeline's trend chart.
   On the Library tab a supplement regime (PDF or photo) can be read with AI into line items, checked and edited,
   then added to the library – and logged for a day – in one go.
   Uses helpers from app.js and gym.js (gHead, gEmpty). */

let SUPPS=null, SUNITS=[], sReadAt=0;   /* units the server takes, from GET /api/supps */
const SLOG={}, SREAD={};            /* date -> that day's entries; date -> when they were read */
let STREND=new Set();             /* names followed on the Timeline chart, lower case */
let sDate=todayStr(), sPick='', sUnit='mg', sQuery='', sFilter='all', sMsg='', sTok=0;
let SAI=false, sAi=null, sAiMsg='';   /* AI set up; the regime being checked; its error (jobBusy('supps'): reading now) */

const sById=id=>SUPPS&&SUPPS.find(s=>s.id===id);
const sNum=n=>String(Math.round(n*1000)/1000);
let sMade=null;   /* {name, id}: a library copy "Save to my supplement library" made whose log entry didn't go through yet */
/* "1 capsule", "2 capsules", "500 mg" */
const sUnitTxt=(u,n)=>/s$/.test(u)&&+n===1?u.slice(0,-1):u;
const sDose=(n,u)=>`${sNum(n)} ${sUnitTxt(u,n)}`;
function sSort(){SUPPS.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.id-b.id);}
async function sLoad(){const r=await api('GET','/api/supps');sReadAt=Date.now();SUPPS=(r&&r.supplements)||[];if(r&&r.units)SUNITS=r.units;SAI=!!(r&&r.ai);sTrends(r&&r.trends);sSort();}
function sTrends(list){STREND=new Set((list||[]).map(n=>n.toLowerCase()));}
const sTrendBox=name=>`<label class="tog strend" title="Follow it on the Timeline’s trend chart"><input type="checkbox" data-st="${esc(name)}"${STREND.has(name.toLowerCase())?' checked':''}> Trend</label>`;
async function sSetTrend(el){
  const name=el.dataset.st, on=el.checked;
  const sync=v=>document.querySelectorAll('input[data-st]').forEach(x=>{if(x.dataset.st.toLowerCase()===name.toLowerCase())x.checked=v;});
  sync(on);
  try{const r=await api('PUT','/api/supps/trend',{name,on});sTrends(r.trends);}
  catch(e){sync(!on);if(!e.signedOut)alert(e.message);}
}
/* back to this tab: the library and the day's log again, in case another tab or device changed them (forms being filled in stay) */
document.addEventListener('visibilitychange',()=>{
  if(document.hidden||!SUPPS)return;
  Object.keys(SLOG).forEach(d=>{delete SLOG[d];});
  if(view!=='supps')return;
  const tok=sTok, onLog=!!$('#s-log'), onList=!!$('#s-list');
  sLoad().then(async()=>{
    if(tok!==sTok||view!=='supps')return;
    if(onList&&$('#s-list'))renderSuppList();
    if(onLog&&$('#s-log')){await sLogOn(sDate);if(tok===sTok&&view==='supps')renderSuppLog();}
  }).catch(()=>{});
});
async function sLogOn(d){if(!SLOG[d]||isStale(SREAD[d])){SLOG[d]=((await api('GET','/api/supps/log?date='+d))||{}).entries||[];SREAD[d]=Date.now();}return SLOG[d];}

async function renderSupps(args){
  if(view!=='supps')return;
  const tok=++sTok, box=$('#s-body'), [p,a]=args||[];
  const lib=p==='lib';
  const tabs=`<nav class="seg gtabs" aria-label="Supplements"><a href="#supps"${lib?'':' aria-current="page"'}>Log</a><a href="#supps/lib"${lib?' aria-current="page"':''}>Library</a></nav>`;
  try{
    if(!SUPPS){box.innerHTML=tabs+'<p class="note">Loading…</p>';await sLoad();if(tok!==sTok||view!=='supps')return;}
    else if(isStale(sReadAt)&&!(lib&&a)){await sLoad();if(tok!==sTok||view!=='supps')return;}
    if(lib&&(a==='new'||/^\d+$/.test(a||''))){
      let s=a==='new'?null:sById(+a);
      if(a!=='new'&&!(s&&s.mine)){await sLoad();if(tok!==sTok||view!=='supps')return;s=sById(+a);}   /* added in another tab since? */
      if(a!=='new'&&!(s&&s.mine)){box.innerHTML=tabs+gHead('#supps/lib','Supplement')+gEmpty('That supplement isn’t in your library.');return;}
      box.innerHTML=tabs+sEditPage(s);$('#s-name').focus();return;
    }
    if(lib){box.innerHTML=tabs+sLibPage();renderSuppList();return;}
    if(p&&!isDate(p)){box.innerHTML=tabs+gHead('#supps','Supplements')+gEmpty(`There’s no such day as “${p}”.`)+'<p><a class="ghost" href="#supps">Go to today</a></p>';return;}
    if(isDate(p))sDate=p;
    box.innerHTML=tabs+sLogPage();
    await sLogOn(sDate);if(tok!==sTok||view!=='supps')return;
    renderSuppLog();
  }catch(e){if(!e.signedOut&&tok===sTok)box.innerHTML=tabs+gEmpty('Couldn’t load your supplements: '+e.message);}
}

/* ---------- the day's log ---------- */
function sUnitOptions(sel){return SUNITS.map(u=>`<option value="${esc(u)}"${u===sel?' selected':''}>${esc(u)}</option>`).join('');}
function sLogPage(){
  const t=todayStr(), title=sDate===t?'Today':sDate===addDays(t,-1)?'Yesterday':parse(sDate).toLocaleDateString(undefined,{weekday:'long'});
  const pick=sById(+sPick);if(!pick)sPick='';
  const opts=`<option value="">Something else – describe it</option>`+(SUPPS.length?`<optgroup label="From the library">${SUPPS.map(s=>`<option value="${s.id}"${String(s.id)===sPick?' selected':''}>${esc(s.name)}${s.amount!=null?' ('+esc(sDose(s.amount,s.unit))+')':''}</option>`).join('')}</optgroup>`:'');
  const quick=SUPPS.filter(s=>s.amount!=null).map(s=>`<button class="ghost" type="button" data-sa="quick" data-id="${s.id}">+ ${esc(s.name)} ${esc(sDose(s.amount,s.unit))}</button>`).join('');
  return `<div class="datebar">
      <button class="nav" type="button" data-sa="prev" aria-label="Previous day">‹</button>
      <div class="dt"><h2>${esc(title)}</h2><span class="sub">${esc(fmtLong(sDate))}</span></div>
      <button class="nav" type="button" data-sa="next" aria-label="Next day">›</button>
      ${sDate===t?'':'<button class="ghost" type="button" data-sa="today">Today</button>'}
      <label class="ghost pick" title="Pick a date"><span>Pick date</span><input type="date" id="s-date" aria-label="Pick a date" value="${sDate}"></label>
    </div>
    <form id="s-form" class="panel sform">
      <label class="f swide"><span class="lbl">Supplement</span><select id="s-pick">${opts}</select></label>
      <label class="f swide"><span class="lbl" id="s-desclbl">${pick?'Note (optional)':'Description'}</span><input id="s-desc" maxlength="200" placeholder="${pick?'e.g. with breakfast':'e.g. Vitamin D3 + K2'}"></label>
      <label class="f"><span class="lbl">Amount</span><input id="s-amt" type="number" inputmode="decimal" min="0" step="any" value="${pick&&pick.amount!=null?sNum(pick.amount):''}" required></label>
      <label class="f"><span class="lbl">Unit</span><select id="s-unit">${sUnitOptions(pick?pick.unit:sUnit)}</select></label>
      <label class="tog swide" id="s-savebox"${pick?' hidden':''}><input type="checkbox" id="s-save"> Save to my supplement library</label>
      <p id="s-err" class="aderr swide" role="alert" hidden></p>
      <div class="factions swide"><button class="btn" type="submit">Add to log</button></div>
    </form>
    ${quick?`<div class="squick" aria-label="Quick add"><span class="lbl">Quick add (usual amount)</span><div class="factions">${quick}</div></div>`:''}
    <section class="panel" aria-labelledby="s-logh"><h2 id="s-logh" class="lbl">Taken</h2><div id="s-log"><p class="note">Loading…</p></div></section>`;
}
function renderSuppLog(){
  const el=$('#s-log');if(!el)return;
  const list=SLOG[sDate]||[];
  el.innerHTML=(sMsg?`<p class="note fmsg" role="status">${esc(sMsg)}</p>`:'')+(list.length
    ?list.map(e=>`<div class="orow"><span>${esc(e.name)}</span><b class="sdose">${esc(sDose(e.amount,e.unit))}</b>${e.note?`<span class="ml">${esc(e.note)}</span>`:''}${sTrendBox(e.name)}<button class="x" type="button" data-sa="del" data-id="${e.id}" aria-label="Remove ${esc(e.name)}">×</button></div>`).join('')
    :gEmpty('Nothing logged for this day.'));
}
async function sAdd(body){
  const e=await api('POST','/api/supps/log',body);
  (SLOG[e.date]=SLOG[e.date]||[]).push(e);sMsg='';
  if(e.date===sDate)renderSuppLog();
  return e;
}
function sPickChanged(){
  sPick=$('#s-pick').value;const s=sById(+sPick);
  $('#s-desclbl').textContent=s?'Note (optional)':'Description';
  $('#s-desc').placeholder=s?'e.g. with breakfast':'e.g. Vitamin D3 + K2';
  $('#s-savebox').hidden=!!s;
  if(s){$('#s-amt').value=s.amount!=null?sNum(s.amount):'';$('#s-unit').value=s.unit;}
}
async function sSubmit(form){
  const err=$('#s-err'), btn=form.querySelector('button[type=submit]'), s=sById(+sPick);
  const desc=$('#s-desc').value.trim(), amount=$('#s-amt').value, unit=$('#s-unit').value;
  err.hidden=true;
  if(!fieldErrors(form,[[!s&&!desc&&$('#s-desc'),'Pick a supplement from the library or describe it'],
    [amount.trim()===''&&$('#s-amt'),'Enter the amount']]))return;
  const save=!s&&$('#s-save').checked;
  btn.disabled=true;
  try{
    if(save){
      /* the entry is logged even if the library copy can't be made; a copy made before a failed log is used again, not made twice */
      const same=desc.replace(/\s+/g,' ').toLowerCase();   /* one of yours by that name already: use it (the server refuses a second) */
      let n=sMade&&sMade.name===desc?sById(sMade.id):SUPPS.find(x=>x.mine&&x.name.toLowerCase()===same)||null, libErr='';
      if(!n)try{n=await api('POST','/api/supps',{name:desc,amount,unit,notes:'',public:false});SUPPS.push(n);sSort();sMade={name:desc,id:n.id};}
        catch(e){if(e.signedOut)throw e;libErr=e.message;}
      await sAdd(n?{date:sDate,supplement:n.id,amount,unit}:{date:sDate,name:desc,amount,unit});
      sMade=null;sUnit=unit;sPick='';await renderSupps([sDate]);
      if(libErr&&$('#s-err')){$('#s-err').textContent='Logged, but it couldn’t be saved to your supplement library: '+libErr;$('#s-err').hidden=false;}
      return;
    }
    await sAdd(s?{date:sDate,supplement:s.id,note:desc,amount,unit}:{date:sDate,name:desc,amount,unit});
    if(!s)sUnit=unit;
    $('#s-desc').value='';if(!s)$('#s-amt').value='';btn.disabled=false;
  }catch(e){btn.disabled=false;if(!e.signedOut&&!errToField(e,[[/^amount|too small/i,$('#s-amt')],[/unit/i,$('#s-unit')],[/describe|too long/i,$('#s-desc')]])){err.textContent=endStop(e.message);err.hidden=false;}}
}

/* ---------- the library ---------- */
function sLibPage(){
  const seg=[['all','All'],['mine','Mine'],['shared','Shared']].map(([v,l])=>`<button type="button" data-sa="filter" data-v="${v}" aria-pressed="${sFilter===v}">${l}</button>`).join('');
  return `<div class="gbar"><h2>Supplement library</h2><a class="btn" href="#supps/lib/new">New supplement</a></div>
    <p class="fintro">Supplements you take regularly, with your usual amount. Share one and everyone can pick it when they log. You can always log something that isn’t here by describing it.</p>
    <div class="ftools"><input id="s-q" type="search" placeholder="Search supplements" aria-label="Search supplements" value="${esc(sQuery)}">
      <div class="seg" role="group" aria-label="Show">${seg}</div></div>
    <div id="s-ai">${sAiBlock()}</div>
    <div id="s-list" class="flist"></div>`;
}

/* ---------- AI: a supplement regime into line items ---------- */
function sAiBlock(){
  const sAiBusy=jobBusy('supps'), row=SAI
    ?`<label class="grow gadd gfile${sAiBusy?' off':''}"><span>✦ ${sAiBusy?'Reading your regime – this can take a minute. You can leave this page; you’ll be told when it’s ready.':'Read a supplement regime with AI (PDF or photo)…'}</span>
        <input id="s-aifile" type="file" accept=".pdf,application/pdf,image/png,image/jpeg,image/webp"${sAiBusy?' disabled':''}></label>`
    :`<div class="grow gadd off"><span>✦ Read a supplement regime with AI – ${isAdmin?'add an OpenRouter key on the <a href="#admin">Super admin page</a> to turn this on':'the super admin needs to add an OpenRouter key first'}</span></div>`;
  return `<div class="glist">${row}</div>${sAiMsg?`<p class="aderr" role="alert">${esc(sAiMsg)}</p>`:''}${sAi?sAiPreview():''}`;
}
function renderSuppAi(){const el=$('#s-ai');if(el)el.innerHTML=sAiBlock();}
function sAiPreview(){
  const n=sAi.items.filter(x=>x.on).length;
  return `<section class="panel gai sai" aria-labelledby="s-aih"><h2 id="s-aih">From ${esc(sAi.file)}</h2>
    <p class="fintro">Check what the AI found and fix anything it got wrong. Ticked lines go into your library (only you see them until you share one);
      one marked <span class="chip ok">in library</span> has the same name as one of yours and gets this amount, unit and notes.</p>
    ${sAi.items.map((x,i)=>`<div class="sairow${x.on?'':' off'}">
      <label class="sion"><input type="checkbox" data-sai="on" data-i="${i}"${x.on?' checked':''} aria-label="Add ${esc(x.name)}"></label>
      <label class="f sainame"><span class="lbl">Name<span class="vh">, line ${i+1}</span> ${x.existing?'<span class="chip ok">in library</span>':'<span class="chip info">new</span>'}</span><input data-sai="name" data-i="${i}" maxlength="80" value="${esc(x.name)}"></label>
      <label class="f"><span class="lbl">Amount<span class="vh"> of ${esc(x.name)}</span></span><input data-sai="amount" data-i="${i}" type="number" inputmode="decimal" min="0" step="any" value="${x.amount==null?'':esc(sNum(x.amount))}"></label>
      <label class="f"><span class="lbl">Unit<span class="vh"> of ${esc(x.name)}</span></span><select data-sai="unit" data-i="${i}">${sUnitOptions(x.unit)}</select></label>
      <label class="f sainotes"><span class="lbl">Notes<span class="vh"> for ${esc(x.name)}</span></span><input data-sai="notes" data-i="${i}" maxlength="300" value="${esc(x.notes)}" placeholder="e.g. Morning with food"></label>
    </div>`).join('')}
    ${sAi.notes.length?`<details class="adnotes" open><summary>Left out, or the AI wasn’t sure (${sAi.notes.length})</summary><ul>${sAi.notes.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></details>`:''}
    <div class="gactions">
      <label class="tog"><input type="checkbox" id="s-ailog"${sAi.log?' checked':''}> Also log them on</label>
      <input type="date" id="s-ailogdate" aria-label="Day to log them on" value="${esc(sAi.day)}"${sAi.log?'':' disabled'}>
    </div>
    <p id="s-aierr" class="aderr" role="alert" hidden></p>
    <div class="gactions"><button class="btn" type="button" data-sa="aiadd"${n?'':' disabled'}>Add ${n} supplement${n===1?'':'s'}</button><button class="ghost" type="button" data-sa="aidrop">Discard</button></div>
  </section>`;
}
async function sAiRead(file){
  if(file.size>10*1024*1024){sAiMsg='That file is over 10 MB.';renderSuppAi();return;}
  sAiMsg='';sAi=null;jobSeen('supps');
  try{await jobStart('/api/supps/ai-import','supps',file);}   /* read in the background: jobs.js brings the result to J_OPEN.supps */
  catch(err){if(err.signedOut)return;sAiMsg='The AI couldn’t read that: '+err.message;}
  renderSuppAi();
}
J_BUSY.supps=renderSuppAi;
J_OPEN.supps=job=>{
  if(job.status!=='done'){sAi=null;sAiMsg='The AI couldn’t read that: '+(job.error||'Something went wrong');}
  else{const j=job.result;sAiMsg='';sAi={file:job.label||'your regime',notes:j.notes||[],items:j.items.map(x=>({...x,on:true})),log:false,day:todayStr()};}
  renderSuppAi();
};
async function sAiAdd(btn){
  const err=$('#s-aierr'), items=sAi.items.filter(x=>x.on).map(({name,amount,unit,notes})=>({name,amount,unit,notes}));
  const day=sAi.log?sAi.day:null;
  err.hidden=true;
  if(day&&!isDate(day))return fieldError($('#s-ailogdate'),'Pick a day from 2000 to a year from now');
  btn.disabled=true;
  try{
    const r=await api('POST','/api/supps/import',{items,log:day});
    SUPPS=r.supplements;sSort();
    if(day&&SLOG[day])SLOG[day].push(...r.entries);
    const skipped=day?items.length-r.entries.length:0;
    sMsg=[r.added?`Added ${r.added} to your library`:'',r.updated?`updated ${r.updated} you already had`:''].filter(Boolean).join(', ')+'.'
      +(day?` Logged ${r.entries.length} on ${fmtLong(day)}${skipped?` (${skipped} without an amount weren’t logged)`:''}.`:'');
    sMsg=sMsg[0].toUpperCase()+sMsg.slice(1);
    sAi=null;jobSeen('supps');renderSuppAi();renderSuppList();
  }catch(e){btn.disabled=false;if(!e.signedOut){err.textContent=e.message;err.hidden=false;}}
}
function renderSuppList(){
  const el=$('#s-list');if(!el)return;
  const q=sQuery.trim().toLowerCase();
  const list=SUPPS.filter(s=>(sFilter==='all'||(sFilter==='mine'?s.mine:s.public))&&(!q||s.name.toLowerCase().includes(q)||s.notes.toLowerCase().includes(q)));
  let h=sMsg?`<p class="note fmsg" role="status">${esc(sMsg)}</p>`:'';
  if(!SUPPS.length)h+=gEmpty('Nothing here yet. Tap “New supplement” to add one, or tick “Save to my supplement library” when you log one.');
  else if(!list.length)h+=gEmpty(sFilter==='shared'&&!q?'Nobody has shared a supplement yet.':sFilter==='mine'&&!q?'You haven’t added any supplements yet.':'No supplements match.');
  h+=list.map(sCard).join('');
  el.innerHTML=h;
}
function sCard(s){
  const tag=s.mine?(s.public?'<span class="chip ok">Shared</span>':'<span class="chip">Only you</span>')
    :`<span class="chip info">Shared${s.by?' by '+esc(s.by):''}</span>`;
  return `<article class="fcard" data-id="${s.id}">
    <div class="fhead"><h3>${esc(s.name)}</h3>${tag}</div>
    <span class="ml">${s.amount!=null?`Usual amount <b>${esc(sDose(s.amount,s.unit))}</b>`:`Measured in ${esc(s.unit)}`}</span>
    ${s.notes?`<details class="frecipe"><summary>Notes</summary><p>${esc(s.notes)}</p></details>`:''}
    <div class="factions"><button class="btn" type="button" data-sa="log" data-id="${s.id}">Log it</button>${sTrendBox(s.name)}
      ${s.mine?`<a class="ghost" href="#supps/lib/${s.id}">Edit</a>`:''}
      ${s.mine||isAdmin?`<button class="ghost" type="button" data-sa="sdel" data-id="${s.id}">${s.mine?'Delete':'Delete (admin)'}</button>`:''}</div>
  </article>`;
}
function sEditPage(s){
  const v=s||{name:'',amount:null,unit:'mg',notes:'',public:false};   /* the optional amount starts empty, not 0 */
  return gHead('#supps/lib',s?'Edit supplement':'New supplement')+`
    <form id="s-lform" class="panel fform" data-id="${s?s.id:''}">
      <label class="f fwide"><span class="lbl">Name</span><input id="s-name" maxlength="80" required value="${esc(v.name)}" placeholder="e.g. Creatine monohydrate"></label>
      <label class="f"><span class="lbl">Usual amount (optional)</span><input id="s-lamt" type="number" inputmode="decimal" min="0" step="any" value="${v.amount==null?'':esc(sNum(v.amount))}"></label>
      <label class="f"><span class="lbl">Unit</span><select id="s-lunit">${sUnitOptions(v.unit)}</select></label>
      <label class="f fwide"><span class="lbl">Notes (optional)</span><textarea id="s-notes" rows="4" maxlength="2000" placeholder="e.g. Take with food. Brand, strength per capsule…">${esc(v.notes)}</textarea></label>
      <label class="tog fwide"><input type="checkbox" id="s-public"${v.public?' checked':''}> Share with everyone – any account can see it and log it (only you can change it)</label>
      <p id="s-lerr" class="aderr fwide" role="alert" hidden></p>
      <div class="factions fwide"><button class="btn" type="submit">${s?'Save changes':'Add to library'}</button><a class="ghost" href="#supps/lib">Cancel</a>
        ${s?`<button class="ghost fdel" type="button" data-sa="sdel" data-id="${s.id}">Delete</button>`:''}</div>
    </form>`;
}
async function sSaveLib(form){
  const err=$('#s-lerr'), id=form.dataset.id, btn=form.querySelector('button[type=submit]');
  const body={name:$('#s-name').value,amount:$('#s-lamt').value,unit:$('#s-lunit').value,notes:$('#s-notes').value,public:$('#s-public').checked};
  err.hidden=true;
  if(!body.name.trim())return fieldError($('#s-name'),'Give the supplement a name');
  btn.disabled=true;
  try{
    const s=await api(id?'PUT':'POST','/api/supps'+(id?'/'+id:''),body);
    SUPPS=SUPPS.filter(x=>x.id!==s.id);SUPPS.push(s);sSort();
    sMsg=id?`Saved “${s.name}”.`:`Added “${s.name}” to your library.`;go('supps/lib');
  }catch(e){btn.disabled=false;if(!e.signedOut){if(/No such/.test(e.message))sLoad().catch(()=>{});
    if(!errToField(e,[[/name|already have/i,$('#s-name')],[/^amount|too small/i,$('#s-lamt')],[/unit/i,$('#s-lunit')],[/notes/i,$('#s-notes')]])){err.textContent=endStop(e.message);err.hidden=false;}}}
}
async function sDeleteLib(id){
  const s=sById(id);if(!s)return;
  if(!await ask(s.mine?`Delete “${s.name}” from your library? Days you’ve already logged it keep it.`:`Delete “${s.name}”${s.by?' (shared by '+s.by+')':''} from the library for everyone?`,
    {yes:s.mine?'Delete supplement':'Delete for everyone',no:'Keep it',danger:true}))return;
  if(!sById(id))return;
  try{await api('DELETE','/api/supps/'+id);}catch(e){if(!e.signedOut)alert(e.message);return;}
  SUPPS=SUPPS.filter(x=>x.id!==id);if(sPick===String(id))sPick='';sMsg=`Deleted “${s.name}”.`;
  if(location.hash==='#supps/lib')renderSuppList();else go('supps/lib');
}

/* ---------- events ---------- */
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-sa]');if(!b||view!=='supps')return;
  const a=b.dataset.sa, id=+b.dataset.id;
  if(a!=='del'&&a!=='quick')sMsg='';
  if(a==='prev'||a==='next')go('supps/'+addDays(sDate,a==='prev'?-1:1));
  else if(a==='today')go('supps/'+todayStr());
  else if(a==='filter'){sFilter=b.dataset.v;document.querySelectorAll('[data-sa=filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderSuppList();}
  else if(a==='log'){sPick=String(id);go('supps/'+sDate);}
  else if(a==='sdel')sDeleteLib(id);
  else if(a==='aiadd'&&sAi)sAiAdd(b);
  else if(a==='aidrop'){sAi=null;jobSeen('supps');renderSuppAi();}
  else if(a==='quick'){const s=sById(id);if(!s)return;b.disabled=true;
    try{await sAdd({date:sDate,supplement:s.id,amount:s.amount,unit:s.unit});}catch(err){if(!err.signedOut)alert(err.message);}b.disabled=false;}
  else if(a==='del'){
    try{await api('DELETE','/api/supps/log/'+id);}catch(err){if(!err.signedOut)alert(err.message);return;}
    Object.keys(SLOG).forEach(d=>{SLOG[d]=SLOG[d].filter(x=>x.id!==id);});renderSuppLog();
  }
});
document.addEventListener('change',e=>{
  if(view!=='supps')return;
  if(e.target.dataset.st!=null)sSetTrend(e.target);
  else if(e.target.id==='s-aifile'){const f=e.target.files&&e.target.files[0];e.target.value='';if(f&&!jobBusy('supps'))sAiRead(f);}
  else if(e.target.dataset.sai==='on'&&sAi){sAi.items[+e.target.dataset.i].on=e.target.checked;renderSuppAi();}
  else if(e.target.id==='s-ailog'&&sAi){sAi.log=e.target.checked;$('#s-ailogdate').disabled=!sAi.log;}
  else if(e.target.id==='s-ailogdate'&&sAi)sAi.day=e.target.value;
  else if(e.target.dataset.sai==='unit'&&sAi)sAi.items[+e.target.dataset.i].unit=e.target.value;
  else if(e.target.id==='s-pick')sPickChanged();
  else if(e.target.id==='s-date'&&isDate(e.target.value))go('supps/'+e.target.value);
});
document.addEventListener('input',e=>{
  if(view!=='supps')return;
  if(e.target.id==='s-q'){sQuery=e.target.value;renderSuppList();}
  else if(sAi&&['name','amount','notes'].includes(e.target.dataset.sai)){
    const x=sAi.items[+e.target.dataset.i], k=e.target.dataset.sai, v=e.target.value;
    x[k]=k==='amount'?(v===''?null:+v):v;
    if(k==='name'){   /* renamed onto (or off) one of yours: the chip says whether it'll be updated or added */
      const n=v.replace(/\s+/g,' ').trim().toLowerCase(), m=(SUPPS||[]).find(s=>s.mine&&s.name.toLowerCase()===n);x.existing=m?m.id:null;
      const c=e.target.closest('.sainame')&&e.target.closest('.sainame').querySelector('.chip');
      if(c){c.className='chip '+(m?'ok':'info');c.textContent=m?'in library':'new';}}
  }
});
document.addEventListener('submit',e=>{
  if(e.target.id==='s-form'){e.preventDefault();sSubmit(e.target);}
  else if(e.target.id==='s-lform'){e.preventDefault();sSaveLib(e.target);}
});
