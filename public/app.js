'use strict';
/* App shell: per-date days saved to the server, history calendar and weight tracking.
   The calculator itself (plan, solver, warnings) lives in engine.js. */

/* ---------- dates (local calendar dates as YYYY-MM-DD) ---------- */
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);};
const addDays=(s,n)=>{const d=parse(s);d.setDate(d.getDate()+n);return ymd(d);};
const wdOf=s=>(parse(s).getDay()+6)%7; /* 0 = Monday */
const todayStr=()=>ymd(new Date());
const isDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&!isNaN(parse(s));
const fmtLong=s=>parse(s).toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
const fmtShort=s=>parse(s).toLocaleDateString(undefined,{day:'numeric',month:'short'});
const fmtMonth=s=>parse(s).toLocaleDateString(undefined,{month:'long',year:'numeric'});
const TYPE_NAME={T:'Training day',R:'Rest day',S:'Saturday training'};

/* ---------- state ---------- */
let S={days:{},cur:todayStr()};            /* days: loaded day documents by date; pud & snackOv are account settings */
const SUMS={};                              /* date -> saved day summary (for calendar and week strip) */
const WEIGHTS={};                           /* date -> kg */
const SAVED={days:{},settings:null};        /* last JSON stored on the server, to spot what changed */
const LOGGED=new Set();                     /* dates stored on the server */
let view='day', month=todayStr().slice(0,7)+'-01', wRange=90, csrf='', ME='';
let resetArmed=false, isAdmin=false;
let LIB=[], LIBV=0;                         /* the food library (yours and shared), and a version to spot changes */

/* ---------- server ---------- */
async function api(method,url,body){
  let r;
  try{r=await fetch(url,{method,credentials:'same-origin',
    headers:{...(body!==undefined?{'content-type':'application/json'}:{}),'x-csrf-token':csrf},
    body:body!==undefined?JSON.stringify(body):undefined});}
  catch{throw new Error('Can’t reach the server – is it still running?');}
  if(r.status===401){setTimeout(toLogin,0);const e=new Error('You were signed out');e.signedOut=true;throw e;}
  if(r.status===404&&method==='GET') return null;
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`HTTP ${r.status}`);
  return j;
}

/* Signed out with changes still waiting: keep them in this browser and send them after you sign back in. */
const STASH='logbook-monster-unsaved';
function toLogin(){
  if(pending.size&&ME){try{localStorage.setItem(STASH,JSON.stringify({email:ME,at:Date.now(),jobs:[...pending.entries()]}));}catch{}}
  pending.clear();location.href='/login'+location.hash;   /* come back to the same day after signing in */
}
function restoreStash(){
  let st;try{st=JSON.parse(localStorage.getItem(STASH)||localStorage.getItem('mealswap-unsaved')||'null');localStorage.removeItem('mealswap-unsaved');}catch{}
  if(!st||st.email!==ME||!Array.isArray(st.jobs))return;
  try{localStorage.removeItem(STASH);}catch{}
  if(Date.now()-st.at>14*86400000)return;
  for(const [key,j] of st.jobs){
    if(key==='@settings'){const v=JSON.parse(j);S.pud={...PUD_DEFAULT,...(v.pud||{})};S.snackOv=v.snackOv||{};recalcPudding();}
    else if(isDate(key)){S.days[key]=migrate(JSON.parse(j));SAVED.days[key]=null;}
  }
}

/* Older saves have no chosen amounts: take them from the plan */
function migrate(D){
  D.meals.forEach((m,mi)=>['p','c','x'].forEach(b=>(m[b]||(m[b]=[])).forEach(i=>{
    if(i.a==null){const bm=D.base&&D.base[mi];const bi=bm&&bm.id===m.id?(bm[b]||[]).find(x=>x.f===i.f):null;i.a=bi?bi.g:i.g;}})));
  D.off=D.off||[];
  return D;
}
const pending=new Map(); let saveTimer=null, saveState='idle', saveErr='', inFlight=false;
function summaryOf(date,D){const t=dayTotals(D);return {...t,targets:{...D.targets},type:TYPE[wdOf(date)]};}

/* Called after every render: anything that differs from what the server has gets queued. */
function persist(){
  for(const [date,D] of Object.entries(S.days)){
    const j=JSON.stringify(D);
    if(SAVED.days[date]===undefined){SAVED.days[date]=j;continue;}   /* first sight of an unsaved plan: baseline */
    if(SAVED.days[date]!==j) pending.set(date,j);
  }
  const sj=JSON.stringify({pud:S.pud,snackOv:S.snackOv||{}});
  if(SAVED.settings!==null&&SAVED.settings!==sj) pending.set('@settings',sj);
  if(pending.size){saveState='pending';clearTimeout(saveTimer);saveTimer=setTimeout(flush,600);}
  renderStatus();
}
async function flush(){
  if(inFlight)return;
  const jobs=[...pending.entries()];pending.clear();
  if(!jobs.length)return;
  inFlight=true;saveState='saving';renderStatus();
  try{
    for(const [key,j] of jobs){
      if(key==='@settings'){await api('PUT','/api/settings',JSON.parse(j));SAVED.settings=j;continue;}
      const D=JSON.parse(j);const summary=summaryOf(key,D);
      await api('PUT','/api/days/'+key,{data:D,summary});
      SAVED.days[key]=j;LOGGED.add(key);SUMS[key]={date:key,...summary};
    }
    saveState=pending.size?'pending':'saved';saveErr='';
    if(pending.size)saveTimer=setTimeout(flush,600);
  }catch(e){
    jobs.forEach(([k,j])=>{if(!pending.has(k))pending.set(k,j);});
    inFlight=false;
    if(e.signedOut)return;               /* toLogin() stashes everything still pending */
    saveState='error';saveErr=e.message;
    saveTimer=setTimeout(flush,5000);
  }
  inFlight=false;
  renderStatus();if(view==='day')renderWeek();
}
window.addEventListener('beforeunload',e=>{if(pending.size||inFlight){e.preventDefault();e.returnValue='';}});

/* Fetch a saved day, or start one from the plan. False if it couldn't be loaded. */
async function loadDay(date){
  if(S.days[date])return true;
  if(LOGGED.has(date)){
    showLoading(true);
    try{const r=await api('GET','/api/days/'+date);
      if(r&&!S.days[date]){S.days[date]=migrate(r.data);SAVED.days[date]=JSON.stringify(S.days[date]);}
    }catch(e){showLoading(false);if(!e.signedOut)alert('Couldn’t load that day: '+e.message);return false;}
    showLoading(false);
  }
  if(!S.days[date]){S.days[date]=freshDay(wdOf(date));if(SAVED.days[date]===undefined)SAVED.days[date]=JSON.stringify(S.days[date]);}
  return true;
}
async function openDay(date){
  S.cur=date;
  if(!await loadDay(date))return;
  if(S.cur===date) render();
}
async function saveNow(){                    /* log a plan you haven't changed */
  const date=S.cur;pending.set(date,JSON.stringify(day()));await flush();
}
async function unlogDay(){
  const date=S.cur;
  if(!confirm(`Remove ${fmtLong(date)} from your history? This can’t be undone.`))return;
  try{await api('DELETE','/api/days/'+date);}catch(e){alert(e.message);return;}
  LOGGED.delete(date);delete SUMS[date];pending.delete(date);
  S.days[date]=freshDay(wdOf(date));SAVED.days[date]=JSON.stringify(S.days[date]);
  render();
}

/* ---------- rendering helpers ---------- */
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const r0=x=>Math.round(x), r1=x=>(Math.round(x*10)/10).toFixed(1);
function day(){if(!S.days[S.cur])S.days[S.cur]=freshDay(wdOf(S.cur));return S.days[S.cur];}
const wd=()=>wdOf(S.cur);
function showLoading(on){$('#loading').hidden=!on;}

function baseAmount(D,mi,box,f){const m=D.base[mi];if(!m||m.id!==D.meals[mi].id)return null;
  const b=(m[box]||[]).filter(i=>i.f===f);return b.length?b.reduce((s,i)=>s+i.g,0):null;}
function deltaTag(D,mi,box,i){
  const b=baseAmount(D,mi,box,i.f);const u=FOODS[i.f].unit||'g';
  if(b==null) return '<span class="delta new">new</span>';
  const d=Math.round(i.g-b); if(!d) return '<span class="delta"></span>';
  return `<span class="delta ${d>0?'up':'down'}">${d>0?'+':'−'}${Math.abs(d)}${u}</span>`;
}
function itemRow(D,mi,box,ii,i){
  const F=FOODS[i.f], id=`${S.cur}-${mi}-${box}-${ii}`, u=F.unit||'g';
  const list=box==='p'?PROTEIN_SWAPS:box==='x'?FAT_SWAPS:CARB_SWAPS;
  const opts=(list.includes(i.f)?list:[i.f,...list]).map(f=>`<option value="${f}"${f===i.f?' selected':''}>${esc(FOODS[f].n)}</option>`).join('');
  return `<div class="row${i.lock?' locked':''}${i.g===0?' zero':''}">
    <label class="lock" title="Lock this amount"><input type="checkbox" id="l-${id}" data-act="lock" data-m="${mi}" data-b="${box}" data-i="${ii}"${i.lock?' checked':''}><span>${i.lock?'Locked':'Lock'}</span></label>
    <select id="s-${id}" data-act="swap" data-m="${mi}" data-b="${box}" data-i="${ii}" aria-label="Food">${opts}</select>
    <span class="amt"><input id="g-${id}" type="number" inputmode="decimal" min="0" step="${F.step}" value="${r0(i.g)}" data-act="amt" data-m="${mi}" data-b="${box}" data-i="${ii}" aria-label="Amount"><em>${u}</em></span>
    ${deltaTag(D,mi,box,i)}
    <button class="x" data-act="del" data-m="${mi}" data-b="${box}" data-i="${ii}" aria-label="Remove">×</button>
  </div>`;
}
/* Delivered meat (foods with a daily order) comes in sauce: weigh the pack, get the amount to put on your plate */
function packOut(i,pk,F){const m=pk.m!=null?pk.m:F.order, g=packPortion(i.g,+pk.w,+m);
  return g==null?'Weigh the pack to get your portion':`Weigh out <b>${r0(g)}g</b> of the pack${i.g>m?' – more than one pack':''}`;}
function packHtml(D,mi,i){
  const F=FOODS[i.f], pk=(D.packs||{})[i.f]||{}, id=`pk-${S.cur}-${mi}-${i.f}`;
  const name=esc(F.n.replace(/^Health Road /,''));
  return `<div class="pack"><label class="pf"><span class="lbl">Pack with sauce</span><span class="amt"><input id="${id}-w" type="number" inputmode="decimal" min="0" step="1" value="${pk.w!=null?pk.w:''}" placeholder="weigh" data-act="pack" data-f="${i.f}" data-k="w"><em>g</em></span></label>
    <label class="pf"><span class="lbl">${name} in it</span><span class="amt"><input id="${id}-m" type="number" inputmode="decimal" min="0" step="1" value="${pk.m!=null?pk.m:F.order}" data-act="pack" data-f="${i.f}" data-k="m"><em>g</em></span></label>
    <span class="pout" data-packout="${i.f}" data-g="${i.g}" aria-live="polite">${packOut(i,pk,F)}</span></div>`;
}
function macLine(t){return `<span class="ml"><b>${r0(t.k)}</b> kcal · P ${r1(t.p)} · C ${r1(t.c)} · F ${r1(t.f)}</span>`;}
function boxHtml(D,mi,box,label){
  const items=D.meals[mi][box]||(D.meals[mi][box]=[]);const t=sum(items.map(i=>macOf(i.f,i.g)));
  return `<div class="box"><div class="bh"><span class="lbl">${label}</span>${items.length?macLine(t):''}</div>
    ${items.map((i,ii)=>itemRow(D,mi,box,ii,i)).join('')||'<p class="empty">Nothing here</p>'}
    ${box==='p'?items.filter(i=>i.g>0&&FOODS[i.f].order!=null).map(i=>packHtml(D,mi,i)).join(''):''}
    <div class="add"><select id="a-${S.cur}-${mi}-${box}" data-add="${box}" data-m="${mi}" aria-label="Add a food"><option value="">+ Add a food…</option>${(box==='x'?FAT_SWAPS:Object.keys(FOODS).filter(f=>!FAT_SWAPS.includes(f))).map(f=>`<option value="${f}">${esc(FOODS[f].n)}</option>`).join('')}</select></div>
  </div>`;
}
function chip(m,val,tgt){
  const d=val-tgt; let cls='ok',txt='on target';
  const tol={k:25,p:3,c:5,f:1}[m];
  if(m==='p'){ if(d<-tol){cls='bad';txt=`${r0(-d)}g short`;} else if(d>tol){cls='ok';txt=`+${r0(d)}g`;} }
  else if(m==='f'){ if(d>tol){cls='bad';txt=`${r1(d)}g over`;} else if(d<-tol){cls='info';txt=`${r1(-d)}g spare`;} }
  else if(Math.abs(d)>tol){cls=d>0?'bad':'info';txt=(d>0?'+':'−')+r0(Math.abs(d))+(m==='k'?' kcal':'g');}
  return `<span class="chip ${cls}">${txt}</span>`;
}

/* ---------- day view ---------- */
function renderWeek(){
  const mon=addDays(S.cur,-wd()), t=todayStr();
  $('#tabs').innerHTML=DAYS.map((n,i)=>{const d=addDays(mon,i);
    return `<button class="tab${d===S.cur?' on':''}${d===t?' today':''}${LOGGED.has(d)?' logged':''}" data-act="day" data-d="${d}" aria-pressed="${d===S.cur}" aria-label="${esc(fmtLong(d))}${LOGGED.has(d)?', saved':''}"><small>${n}</small><b>${parse(d).getDate()}</b><small>${TYPE[i]==='R'?'Rest':'Train'}</small></button>`;}).join('');
}
function renderStatus(){
  if(view!=='day')return;
  const date=S.cur, logged=LOGGED.has(date), p=pending.has(date);
  let h;
  if(saveState==='error'&&(p||pending.size)) h=`<span class="chip bad">Not saved</span> ${esc(saveErr)} Retrying… <button class="ghost" data-act="retry">Retry now</button>`;
  else if(saveState==='saving'||p) h='<span class="chip info">Saving…</span>';
  else if(logged) h=`<span class="chip ok">✓ Saved</span> In your history. <button class="ghost" data-act="unlog">Remove from history</button>`;
  else h='<span class="chip">Plan only</span> Not in your history yet – any change saves it. <button class="btn" data-act="savenow">Save day as is</button>';
  $('#status').innerHTML=h;
}
function renderWeightInline(){
  const el=$('#wt');const kg=WEIGHTS[S.cur];
  if(document.activeElement!==el) el.value=kg!=null?kg:'';
  const prev=Object.keys(WEIGHTS).filter(d=>d<S.cur).sort().pop();
  $('#wtdelta').textContent=kg!=null&&prev?`${kg-WEIGHTS[prev]>=0?'+':'−'}${Math.abs(kg-WEIGHTS[prev]).toFixed(1)} kg since ${fmtShort(prev)}`:'';
}
function render(){
  if(view!=='day')return;
  const D=day(), T=dayTotals(D), tg=D.targets, t=TYPE[wd()], td=todayStr();
  $('#dtitle').textContent=S.cur===td?'Today':S.cur===addDays(td,-1)?'Yesterday':S.cur===addDays(td,1)?'Tomorrow':parse(S.cur).toLocaleDateString(undefined,{weekday:'long'});
  $('#dsub').textContent=`${fmtLong(S.cur)} · ${TYPE_NAME[t]}`;
  $('#todaybtn').hidden=S.cur===td;
  $('#datepick').value=S.cur;
  renderWeek();
  renderWeightInline();
  const names={k:'Calories',p:'Protein min',c:'Carbs',f:'Fat max'};
  $('#sum').innerHTML=MAC.map(m=>`<div class="stat"><span class="lbl">${names[m]}</span>
      <span class="num">${r0(T[m])}<i>/ ${r0(tg[m])}${m==='k'?'':'g'}</i></span>${chip(m,T[m],+tg[m])}
      ${m==='p'?`<span class="sub">direct ${r0(T.d)}g</span>`:''}</div>`).join('');
  const left={k:tg.k-T.k,p:tg.p-T.p,c:tg.c-T.c,f:tg.f-T.f};
  $('#left').innerHTML=D.auto?'':`<b>Left to spend off plan:</b> ${r0(Math.max(0,left.k))} kcal · P ${r1(Math.max(0,left.p))} · C ${r1(Math.max(0,left.c))} · F ${r1(Math.max(0,left.f))}`;
  $('#left').hidden=D.auto;
  const w=warnings(D);
  $('#warn').innerHTML=w.map(x=>`<li>${esc(x)}</li>`).join(''); $('#warn').hidden=!w.length;
  $('#opts').innerHTML=`
    ${CUSTOM_PLAN&&CUSTOM_PLAN[t]?'':`<div class="seg" role="group" aria-label="Breakfast"><span class="lbl">Breakfast</span>
      <button data-act="bf" data-v="omelette" aria-pressed="${D.bf==='omelette'}">Omelette</button>
      <button data-act="bf" data-v="eggs" aria-pressed="${D.bf==='eggs'}">Egg &amp; egg white</button></div>`}
    ${t==='S'&&!(CUSTOM_PLAN&&CUSTOM_PLAN.S)?`<label class="tog"><input type="checkbox" id="pie" data-act="pie"${D.pie?' checked':''}> Lemon pie Saturday</label>`:''}
    <label class="tog"><input type="checkbox" id="auto" data-act="auto"${D.auto?' checked':''}> Auto-balance the day</label>
    <button class="ghost" data-act="reset">${resetArmed?'Tap again to reset':'Reset day to plan'}</button>`;
  $('#meals').innerHTML=D.meals.map((m,mi)=>{
    const mt=sum([...m.p,...m.c,...(m.x||[])].map(i=>macOf(i.f,i.g)));
    const all=[...m.p,...m.c,...(m.x||[])];const saved=!m.dirty&&all.length&&all.every(i=>i.lock);
    return `<section class="meal${m.dirty?' dirty':''}"><header><span class="mn">Meal ${esc(m.id)}</span><h2>${esc(m.name)}</h2>${macLine(mt)}${saved?'<span class="chip ok">Locked</span>':''}</header>
      ${m.dirty?`<div class="savebar" role="status"><span>Changes not saved – the rest of the day won't move until you save.</span><span class="sb"><button class="ghost" data-act="undo" data-m="${mi}">Undo changes</button><button class="btn" data-act="save" data-m="${mi}">Save meal</button></span></div>`:''}
      ${m.note?`<p class="mnote">${esc(m.note)}</p>`:''}
      <div class="boxes">${BOXES.map(([b,l])=>boxHtml(D,mi,b,l)).join('')}</div></section>`;
  }).join('');
  const ot=sum(D.off.map(o=>({k:+o.k||0,p:+o.p||0,c:+o.c||0,f:+o.f||0})));
  $('#offlist').innerHTML=D.off.map((o,oi)=>`<div class="orow"><span>${esc(o.n||'Off-plan food')}</span>${o.snack||o.lib?`<label class="qty"><input id="oq-${S.cur}-${oi}" type="number" inputmode="decimal" min="0" step="${o.lib&&o.u==='each'?'0.5':'1'}" value="${+o.qty||0}" data-act="oqty" data-i="${oi}">${o.lib?libUnit(o.u):snackVal(o.snack).u==='g'?'g':'×'}</label>`:''}<span class="ml">${r0(+o.k||0)} kcal · P ${r1(+o.p||0)} · C ${r1(+o.c||0)} · F ${r1(+o.f||0)}</span><button class="x" data-act="odel" data-i="${oi}" aria-label="Remove">×</button></div>`).join('')
    +(D.off.length>1?`<div class="orow tot"><span>Total off plan</span>${macLine(ot)}</div>`:'');
  ['k','p','c','f'].forEach(m=>{$('#t-'+m).value=r0(+tg[m]);});
  {const {b,t}=pudBatch();const P=FOODS.pudding,sv=pudServe();
    Object.keys(PUD_DEFAULT).forEach(k=>{const el=$('#pd-'+k);if(document.activeElement!==el)el.value=+b[k];});
    $('#pudsum').innerHTML=`<b>Per 100g:</b> ${r0(P.k)} kcal · P ${r1(P.p)} · C ${r1(P.c)} · F ${r1(P.f)}<br>`+
      `<b>Whole batch:</b> ${r0(t.k)} kcal · P ${r1(t.p)} · C ${r1(t.c)} · F ${r1(t.f)}<br>`+
      `<b>Biggest serving:</b> ${sv}g (${r0(sv*P.k/100)} kcal · P ${r1(sv*P.p/100)} · C ${r1(sv*P.c/100)} · F ${r1(sv*P.f/100)})`;}
  renderLibForm();
  if(!$('#sn').options.length){$('#sn').innerHTML=SNACKS.map(x=>`<option value="${x.id}">${esc(x.n)}</option>`).join('');}
  $('#su').textContent=snackVal($('#sn').value).u==='g'?'Grams':'How many';
  $('#snackvals').innerHTML='<div class="sv"><span class="lbl">Per item / 100g</span><span class="lbl">kcal</span><span class="lbl">P</span><span class="lbl">C</span><span class="lbl">F</span>'+
    SNACKS.filter(x=>x.id!=='pudding').map(x=>{const v=snackVal(x.id);return `<span>${esc(x.n)}${x.u==='g'?' (per 100g)':''}${x.est&&!(S.snackOv||{})[x.id]?' <span class="est">estimate</span>':''}</span>`+
    ['k','p','c','f'].map(m=>`<input id="sv-${x.id}-${m}" type="number" inputmode="decimal" step="0.1" value="${v[m]}" data-act="sv" data-s="${x.id}" data-m="${m}" aria-label="${esc(x.n)} ${m}">`).join('');}).join('')+'</div>';
  persist();
}

/* ---------- food library on the day page (the library itself is in foods.js) ---------- */
const libUnit=u=>u==='each'?'×':u;
const libPer=u=>u==='each'?'per item':`per 100${u}`;
function libMac(o,qty){const m=o.u==='each'?qty:qty/100;return {k:o.per.k*m,p:o.per.p*m,c:o.per.c*m,f:o.per.f*m};}
/* what goes in a day's off-plan list: carries its own values, so it still works if the food is later changed or removed */
function libEntry(food,qty){const o={n:food.name,lib:food.id,u:food.unit,per:{k:food.k,p:food.p,c:food.c,f:food.f},qty};return Object.assign(o,libMac(o,qty));}
function libAdd(D,food,qty){
  const ex=D.off.find(o=>o.lib===food.id&&o.u===food.unit&&['k','p','c','f'].every(m=>o.per[m]===food[m]));
  if(ex){ex.qty+=qty;Object.assign(ex,libMac(ex,ex.qty));}else D.off.push(libEntry(food,qty));
}
const libDefault=u=>u==='each'?1:100;
/* Add a library food to any day (from the Foods page), then show that day. */
async function addFoodToDay(food,date,qty){
  if(!(qty>0)||!isDate(date))return false;
  if(!await loadDay(date))return false;
  S.cur=date;act(D=>libAdd(D,food,qty));go('day/'+date);
  return true;
}
function renderLibForm(){
  const sel=$('#ln');$('#libform').hidden=!LIB.length;$('#libnone').hidden=!!LIB.length;
  if(sel.dataset.v===String(LIBV))return;
  const keep=sel.value;sel.dataset.v=String(LIBV);
  const opt=f=>`<option value="${f.id}">${esc(f.name)} (${libPer(f.unit)})</option>`;
  const mine=LIB.filter(f=>f.mine), shared=LIB.filter(f=>!f.mine);
  sel.innerHTML=(mine.length?`<optgroup label="Your foods">${mine.map(opt).join('')}</optgroup>`:'')+
    (shared.length?`<optgroup label="Shared by others">${shared.map(opt).join('')}</optgroup>`:'');
  if(LIB.some(f=>String(f.id)===keep))sel.value=keep;
  libQtyLabel(keep!==sel.value);
}
function libQtyLabel(reset){const f=LIB.find(x=>String(x.id)===$('#ln').value);if(!f)return;
  $('#lu').textContent=f.unit==='each'?'How many':f.unit==='ml'?'Millilitres':'Grams';$('#lq').step=f.unit==='each'?'0.5':'1';
  if(reset)$('#lq').value=libDefault(f.unit);}

/* ---------- history view ---------- */
function dayStatus(s){
  const d=s.k-(s.targets&&s.targets.k||0);
  if(!s.targets||!s.targets.k) return {cls:'plan',sym:'·',txt:''};
  if(Math.abs(d)<=100) return {cls:'on',sym:'✓',txt:'on target'};
  return d>0?{cls:'over',sym:'▲',txt:`${r0(d)} kcal over`}:{cls:'under',sym:'▼',txt:`${r0(-d)} kcal under`};
}
function renderHistory(){
  $('#mtitle').textContent=fmtMonth(month);
  const first=parse(month), lead=(first.getDay()+6)%7, start=addDays(month,-lead), t=todayStr();
  const m=first.getMonth();
  let h=DAYS.map(d=>`<div class="dow" role="columnheader">${d}</div>`).join('');
  const cells=Math.ceil((lead+new Date(first.getFullYear(),m+1,0).getDate())/7)*7;
  for(let i=0;i<cells;i++){
    const d=addDays(start,i), s=SUMS[d], w=WEIGHTS[d], out=parse(d).getMonth()!==m;
    const st=s?dayStatus(s):null;
    const label=[fmtLong(d), s?`${r0(s.k)} kcal, ${r0(s.p)}g protein${st.txt?', '+st.txt:''}`:'not logged', w!=null?`weight ${w} kg`:''].filter(Boolean).join(', ');
    h+=`<button class="cell${out?' out':''}${d===t?' today':''}${s?' logged':''}" data-act="open" data-d="${d}" aria-label="${esc(label)}">
      <span class="dn">${parse(d).getDate()}<small>${((s&&s.type)||TYPE[i%7])==='R'?'Rest':'Train'}</small></span>
      ${s?`<span class="kc"><i class="dot ${st.cls}">${st.sym}</i>${r0(s.k)}</span><span class="pr">P ${r0(s.p)}g</span>`:''}
      ${w!=null?`<span class="wg">${w} kg</span>`:''}
    </button>`;
  }
  $('#cal').innerHTML=h;
  /* month summary */
  const end=addDays(addDays(month,32).slice(0,7)+'-01',-1);
  const ds=Object.values(SUMS).filter(s=>s.date>=month&&s.date<=end);
  const ws=Object.keys(WEIGHTS).filter(d=>d>=month&&d<=end).sort();
  const avg=k=>ds.length?ds.reduce((a,s)=>a+s[k],0)/ds.length:0;
  const on=ds.filter(s=>dayStatus(s).cls==='on').length;
  const wch=ws.length>1?WEIGHTS[ws[ws.length-1]]-WEIGHTS[ws[0]]:null;
  $('#msum').innerHTML=[
    ['Days logged',`${ds.length}`,''],
    ['On target',ds.length?`${on}/${ds.length}`:'–','within ±100 kcal'],
    ['Avg calories',ds.length?r0(avg('k')):'–','kcal a day'],
    ['Avg protein',ds.length?r0(avg('p'))+'g':'–',''],
    ['Weight change',wch!=null?`${wch>=0?'+':'−'}${Math.abs(wch).toFixed(1)} kg`:'–',ws.length?`${ws.length} weigh-in${ws.length>1?'s':''}`:''],
  ].map(([l,v,s])=>`<div class="stat"><span class="lbl">${l}</span><span class="num">${v}</span>${s?`<span class="sub">${s}</span>`:''}</div>`).join('');
}

/* ---------- weight view ---------- */
function rolling(entries){ /* 7-day average ending on each weigh-in */
  return entries.map(([d,kg],i)=>{const from=addDays(d,-6);let s=0,n=0;
    for(let j=i;j>=0&&entries[j][0]>=from;j--){s+=entries[j][1];n++;}return [d,s/n];});
}
function renderWeight(){
  if(!$('#w-date').value)$('#w-date').value=todayStr();
  $('#wrange').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.r===wRange)));
  const all=Object.entries(WEIGHTS).sort((a,b)=>a[0]<b[0]?-1:1);
  const avgAll=rolling(all);
  const from=wRange?addDays(todayStr(),-wRange+1):'0000';
  const idx=all.findIndex(e=>e[0]>=from); const pts=idx<0?[]:all.slice(idx), avg=idx<0?[]:avgAll.slice(idx);
  /* stats */
  const last=all[all.length-1], lastAvg=avgAll[avgAll.length-1];
  const ch=pts.length>1?pts[pts.length-1][1]-pts[0][1]:null;
  const lo=pts.length?Math.min(...pts.map(p=>p[1])):null;
  $('#wstats').innerHTML=[
    ['Latest',last?`${last[1].toFixed(1)}<i>kg</i>`:'–',last?fmtShort(last[0]):'No weigh-ins yet'],
    ['7-day average',lastAvg?`${lastAvg[1].toFixed(1)}<i>kg</i>`:'–',''],
    ['Change',ch!=null?`${ch>=0?'+':'−'}${Math.abs(ch).toFixed(1)}<i>kg</i>`:'–',wRange?`last ${wRange} days`:'all time'],
    ['Lowest',lo!=null?`${lo.toFixed(1)}<i>kg</i>`:'–',wRange?`last ${wRange} days`:'all time'],
  ].map(([l,v,s])=>`<div class="stat"><span class="lbl">${l}</span><span class="num">${v}</span>${s?`<span class="sub">${s}</span>`:''}</div>`).join('');
  drawChart(pts,avg);
  /* list */
  $('#wlist').innerHTML=all.length?all.slice().reverse().map(([d,kg],i,arr)=>{
    const prev=arr[i+1];const c=prev?kg-prev[1]:null;
    return `<div class="wrow"><a href="#day/${d}">${esc(parse(d).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'}))}</a>
      <span class="kg">${kg.toFixed(1)} kg</span><span class="ch">${c==null?'':(c>=0?'+':'−')+Math.abs(c).toFixed(1)}</span>
      <button class="x" data-act="wdel" data-d="${d}" aria-label="Delete weight for ${esc(fmtLong(d))}">×</button></div>`;}).join('')
    :'<p class="empty">Log your first weigh-in above, or on any day in the Food Tracker.</p>';
}
function drawChart(pts,avg){
  const box=$('#chart');
  if(!pts.length){box.innerHTML='<p class="emptyc">No weigh-ins in this range.</p>';return;}
  const W=Math.max(300,box.clientWidth||600), H=Math.round(Math.min(320,Math.max(220,W*0.42)));
  const m={l:40,r:12,t:12,b:26};
  const t0=parse(pts[0][0]).getTime(), t1=Math.max(t0+86400000,parse(pts[pts.length-1][0]).getTime());
  const vals=pts.map(p=>p[1]).concat(avg.map(p=>p[1]));
  let lo=Math.min(...vals), hi=Math.max(...vals); const pad=Math.max(0.5,(hi-lo)*0.15); lo-=pad; hi+=pad;
  const step=[0.5,1,2,5,10,20].find(s=>(hi-lo)/s<=5)||50;
  lo=Math.floor(lo/step)*step; hi=Math.ceil(hi/step)*step;
  const x=d=>m.l+(parse(d).getTime()-t0)/(t1-t0)*(W-m.l-m.r);
  const y=v=>m.t+(hi-v)/(hi-lo)*(H-m.t-m.b);
  let g='<g class="grid">';
  for(let v=lo;v<=hi+1e-9;v+=step) g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
  g+='</g><g class="axis">';
  for(let v=lo;v<=hi+1e-9;v+=step) g+=`<text x="${m.l-6}" y="${y(v)+4}" text-anchor="end">${step<1?v.toFixed(1):v}</text>`;
  const ticks=pts.length===1?[pts[0][0]]:[pts[0][0],ymd(new Date((t0+t1)/2)),pts[pts.length-1][0]];
  ticks.forEach((d,i)=>{g+=`<text x="${x(d)}" y="${H-6}" text-anchor="${pts.length===1?'middle':['start','middle','end'][i]}">${esc(fmtShort(d))}</text>`;});
  g+='</g>';
  const line=avg.length>1?`<path class="avg" d="${avg.map((p,i)=>(i?'L':'M')+x(p[0]).toFixed(1)+' '+y(p[1]).toFixed(1)).join('')}"/>`:'';
  const dots=pts.map(p=>`<circle class="pt" cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="3"/>`).join('');
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight from ${esc(fmtShort(pts[0][0]))} to ${esc(fmtShort(pts[pts.length-1][0]))}">${g}${dots}${line}
    <line class="cross" id="cx" y1="${m.t}" y2="${H-m.b}" visibility="hidden"/><circle class="hi" id="ch" r="5" visibility="hidden"/>
    <rect id="hit" x="${m.l}" y="0" width="${W-m.l-m.r}" height="${H}" fill="transparent"/></svg><div class="tip" id="tip" hidden></div>`;
  const svg=box.querySelector('svg'), tip=$('#tip'), cx=$('#cx'), chh=$('#ch');
  const move=e=>{
    const r=svg.getBoundingClientRect(), px=(e.clientX-r.left)*W/r.width;
    let best=0;pts.forEach((p,i)=>{if(Math.abs(x(p[0])-px)<Math.abs(x(pts[best][0])-px))best=i;});
    const p=pts[best], a=avg[best], X=x(p[0]), Y=y(p[1]);
    cx.setAttribute('x1',X);cx.setAttribute('x2',X);cx.setAttribute('visibility','visible');
    chh.setAttribute('cx',X);chh.setAttribute('cy',Y);chh.setAttribute('visibility','visible');
    tip.hidden=false;tip.innerHTML=`<b>${esc(fmtShort(p[0]))}</b> · ${p[1].toFixed(1)} kg<br>7-day avg ${a[1].toFixed(1)} kg`;
    tip.style.left=Math.min(Math.max(X*r.width/W,70),r.width-70)+'px';tip.style.top=(Y*r.height/H)+'px';
  };
  const leave=()=>{tip.hidden=true;cx.setAttribute('visibility','hidden');chh.setAttribute('visibility','hidden');};
  $('#hit').addEventListener('pointermove',move);$('#hit').addEventListener('pointerdown',move);$('#hit').addEventListener('pointerleave',leave);
}
async function setWeight(date,kg){
  if(kg==null){await api('DELETE','/api/weights/'+date);delete WEIGHTS[date];}
  else{await api('PUT','/api/weights/'+date,{kg});WEIGHTS[date]=Math.round(kg*100)/100;}
}

/* ---------- routing: #day/2026-10-15, #history/2026-10, #weight, #gym/…, #foods/…, #admin ---------- */
const VIEWS=['day','history','weight','gym','foods','admin'];
function route(){
  const [v,arg,...more]=location.hash.replace(/^#/,'').split('/');
  view=VIEWS.includes(v)&&(v!=='admin'||isAdmin)?v:'day';
  document.querySelectorAll('.views a').forEach(a=>{if(a.dataset.view===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  VIEWS.forEach(n=>{$('#v-'+n).hidden=n!==view;});
  $('#acct').open=false;
  if(view==='day'){openDay(isDate(arg)?arg:S.cur);}
  else if(view==='history'){if(/^\d{4}-\d{2}$/.test(arg||''))month=arg+'-01';renderHistory();}
  else if(view==='admin'){renderAdmin();}
  else if(view==='gym'){renderGym(arg?[arg,...more]:[]);}
  else if(view==='foods'){renderFoods(arg?[arg]:[]);}
  else renderWeight();
}
function go(hash){if(location.hash==='#'+hash)route();else location.hash=hash;}

/* ---------- actions (calculator) ---------- */
function act(fn,opts){const D=day();const held=new Set();fn(D,held);
  D.meals.forEach(m=>{if(m.dirty)BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>held.add(i)));}); /* unsaved meals stay as you left them */
  solve(D,held,opts||{});render();}
/* edits inside a meal wait for 'Save meal' – nothing else moves until then */
function editMeal(mi,box,fn){const D=day();const m=D.meals[mi];
  if(!m._snap)m._snap=clone({p:m.p,c:m.c,x:m.x||[]});
  fn(D,m);m.dirty=true;if(box==='p')m.dirtyProt=true;render();}
function saveMeal(mi){const D=day();const m=D.meals[mi];const held=new Set();
  BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>{i.lock=true;i.a=i.g;held.add(i);}));
  const protect=!m.dirtyProt;delete m._snap;delete m.dirty;delete m.dirtyProt;
  D.meals.forEach(o=>{if(o.dirty)BOXES.forEach(([b])=>(o[b]||[]).forEach(i=>held.add(i)));});
  solve(D,held,{protect});render();}
function undoMeal(mi){const D=day();const m=D.meals[mi];if(m._snap)Object.assign(m,clone(m._snap));
  delete m._snap;delete m.dirty;delete m.dirtyProt;render();}

document.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]'); if(!b||b.tagName==='INPUT'||b.tagName==='SELECT')return;
  const a=b.dataset.act;
  if(a!=='reset'&&resetArmed){resetArmed=false;}
  if(a==='day'||a==='open'){go('day/'+b.dataset.d);}
  else if(a==='prev'){go('day/'+addDays(S.cur,-1));}
  else if(a==='next'){go('day/'+addDays(S.cur,1));}
  else if(a==='today'){go('day/'+todayStr());}
  else if(a==='mprev'||a==='mnext'){const d=parse(month);d.setMonth(d.getMonth()+(a==='mprev'?-1:1));go('history/'+ymd(d).slice(0,7));}
  else if(a==='mtoday'){go('history/'+todayStr().slice(0,7));}
  else if(a==='savenow'){saveNow();}
  else if(a==='unlog'){unlogDay();}
  else if(a==='retry'){clearTimeout(saveTimer);saveState='pending';flush();}
  else if(a==='wdel'){const d=b.dataset.d;if(confirm(`Delete the weigh-in for ${fmtLong(d)}?`))setWeight(d,null).then(renderWeight,err=>{if(!err.signedOut)alert(err.message);});}
  else if(a==='bf'){act(D=>{if(D.bf===b.dataset.v)return;D.bf=b.dataset.v;const p=planFor(wd(),D.bf,D.pie);D.meals[0]=p[0];D.base[0]=clone(p[0]);});}
  else if(a==='del'){editMeal(+b.dataset.m,b.dataset.b,(D,m)=>{m[b.dataset.b].splice(+b.dataset.i,1);});}
  else if(a==='save'){saveMeal(+b.dataset.m);}
  else if(a==='undo'){undoMeal(+b.dataset.m);}
  else if(a==='odel'){act(D=>{D.off.splice(+b.dataset.i,1);});}
  else if(a==='reset'){if(!resetArmed){resetArmed=true;render();return;}resetArmed=false;S.days[S.cur]=freshDay(wd());render();}
});
/* pack weights: update the portion as you type, without re-rendering under your fingers */
function setPack(el){const D=day(),f=el.dataset.f;D.packs=D.packs||{};const p=D.packs[f]=D.packs[f]||{};
  const v=el.value.trim();if(v===''||!(+v>=0))delete p[el.dataset.k];else p[el.dataset.k]=+v;
  if(!Object.keys(p).length)delete D.packs[f];if(!Object.keys(D.packs).length)delete D.packs;
  return {f,pk:p};}
document.addEventListener('input',e=>{const el=e.target;if(el.dataset.act!=='pack')return;
  const {f,pk}=setPack(el);
  document.querySelectorAll(`[data-packout="${f}"]`).forEach(o=>{o.innerHTML=packOut({g:+o.dataset.g},pk,FOODS[f]);});
  persist();});
document.addEventListener('change',e=>{
  const el=e.target, a=el.dataset.act;
  if(a==='pack'){setPack(el);render();return;}
  const get=D=>D.meals[+el.dataset.m][el.dataset.b][+el.dataset.i];
  if(a==='lock'){const D=day();get(D).lock=el.checked;render();}
  else if(a==='amt'){editMeal(+el.dataset.m,el.dataset.b,D=>{const i=get(D);i.g=Math.max(0,+el.value||0);i.a=i.g;});}
  else if(a==='swap'){editMeal(+el.dataset.m,el.dataset.b,D=>{const h=new Set();const i=get(D),box=D.meals[+el.dataset.m][el.dataset.b];const mac=el.dataset.b==='p'?'p':el.dataset.b==='x'?'f':'c';
      const need=FOODS[i.f][mac]*i.g/100;placeMatched(box,el.value,mac,need,h,i);});}
  else if(a==='pie'){act(D=>{D.pie=el.checked;D.meals=planFor(wd(),D.bf,D.pie);D.base=clone(D.meals);D.targets={...(D.pie?PIE_TARGETS:COACH.S)};});}
  else if(a==='auto'){act(D=>{D.auto=el.checked;});}
  else if(el.dataset.add){const mi=+el.dataset.m,box=el.dataset.add,f=el.value;if(!f||!FOODS[f])return;
      editMeal(mi,box,(D,m)=>{const n=it(f,FOODS[f].min||(FOODS[f].step>=5?50:10));(m[box]=m[box]||[]).push(n);});}
  else if(a==='oqty'){act(D=>{const o=D.off[+el.dataset.i];o.qty=Math.max(0,+el.value||0);Object.assign(o,o.lib?libMac(o,o.qty):snackMac(o.snack,o.qty));});}
  else if(a==='sv'){S.snackOv=S.snackOv||{};const id=el.dataset.s;S.snackOv[id]={...(S.snackOv[id]||{}),[el.dataset.m]:+el.value||0};
      act(D=>{D.off.forEach(o=>{if(o.snack===id)Object.assign(o,snackMac(id,o.qty));});});}
  else if(el.id==='ln'){libQtyLabel(true);}
  else if(el.id==='sn'){const g=snackVal(el.value).u==='g';$('#su').textContent=g?'Grams':'How many';$('#sq').value=g?20:1;}
  else if(el.id&&el.id.startsWith('t-')){act(D=>{D.targets[el.id.slice(2)]=+el.value||0;});}
  else if(el.dataset.pud){S.pud={...PUD_DEFAULT,...(S.pud||{}),[el.dataset.pud]:Math.max(0,+el.value||0)};recalcPudding();
      Object.values(S.days).forEach(D=>D.off.forEach(o=>{if(o.snack==='pudding')Object.assign(o,snackMac('pudding',o.qty));}));
      act(()=>{});}
  else if(el.id==='datepick'){if(isDate(el.value))go('day/'+el.value);}
  else if(el.id==='wt'){const v=el.value.trim(),date=S.cur;const kg=v===''?null:+v;
      if(kg!=null&&!(kg>=20&&kg<=400)){alert('Enter a weight between 20 and 400 kg.');renderWeightInline();return;}
      setWeight(date,kg).then(renderWeightInline,err=>{if(!err.signedOut)alert('Couldn’t save weight: '+err.message);renderWeightInline();});}
});
$('#snackform').addEventListener('submit',e=>{
  e.preventDefault();const id=$('#sn').value,q=+$('#sq').value||0;if(!q)return;
  act(D=>{const ex=D.off.find(o=>o.snack===id);
    if(ex){ex.qty+=q;Object.assign(ex,snackMac(id,ex.qty));}
    else D.off.push({n:snackVal(id).n,snack:id,qty:q,...snackMac(id,q)});});
});
$('#libform').addEventListener('submit',e=>{
  e.preventDefault();const f=LIB.find(x=>String(x.id)===$('#ln').value),q=+$('#lq').value||0;if(!f||!(q>0))return;
  act(D=>libAdd(D,f,q));
});
$('#offform').addEventListener('submit',async e=>{
  e.preventDefault();const v=id=>$('#'+id).value;
  const o={n:v('o-n').trim()||'Off-plan food',k:+v('o-k')||0,p:+v('o-p')||0,c:+v('o-c')||0,f:+v('o-f')||0};
  if(!o.k&&!o.p&&!o.c&&!o.f)return;
  let food=null;
  if($('#o-save').checked){   /* keep it in the food library as one item, to add again on other days */
    try{food=await api('POST','/api/foods',{name:o.n,unit:'each',k:o.k,p:o.p,c:o.c,f:o.f});LIB.push(food);LIB.sort((a,b)=>a.name.localeCompare(b.name));LIBV++;}
    catch(err){if(!err.signedOut)alert('Couldn’t save it to your food library: '+err.message);return;}
  }
  act(D=>{if(food)libAdd(D,food,1);else D.off.push(o);});
  ['o-n','o-k','o-p','o-c','o-f'].forEach(id=>$('#'+id).value='');$('#o-save').checked=false;
});
$('#coach').addEventListener('click',()=>act(D=>{D.targets={...(D.pie?PIE_TARGETS:COACH[TYPE[wd()]])};}));

/* ---------- weight view & account ---------- */
$('#wform').addEventListener('submit',async e=>{
  e.preventDefault();const d=$('#w-date').value,kg=+$('#w-kg').value;
  if(!isDate(d)||!(kg>=20&&kg<=400)){alert('Enter a date and a weight between 20 and 400 kg.');return;}
  try{await setWeight(d,kg);$('#w-kg').value='';renderWeight();}catch(err){if(!err.signedOut)alert(err.message);}
});
$('#wrange').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;wRange=+b.dataset.r;renderWeight();});
let rz;window.addEventListener('resize',()=>{clearTimeout(rz);rz=setTimeout(()=>{if(view==='weight')renderWeight();},150);});
window.addEventListener('hashchange',route);
$('#logout').addEventListener('click',async()=>{
  if(pending.size){clearTimeout(saveTimer);await flush();}
  try{await api('POST','/auth/logout',{});}catch{}
  location.href='/login';
});
$('#pwform').addEventListener('submit',async e=>{
  e.preventDefault();const msg=$('#pwmsg');msg.textContent='';
  try{await api('POST','/auth/password',{current:$('#pw-cur').value,next:$('#pw-new').value});
    msg.textContent='Password updated.';$('#pw-cur').value=$('#pw-new').value='';$('#pwcur').hidden=false;}
  catch(err){msg.textContent=err.message;}
});
document.addEventListener('click',e=>{const d=$('#acct');if(d.open&&!d.contains(e.target))d.open=false;});

/* ---------- start ---------- */
(async()=>{
  try{
    const me=await api('GET','/api/me');csrf=me.csrf;ME=me.email;
    $('#who').textContent=me.name||me.email;$('#who').title=me.email;
    if(!me.hasPassword){$('#pwcur').hidden=true;$('#pwbox').querySelector('summary').textContent='Set a password';}
    isAdmin=!!me.admin;$('#adminlink').hidden=!isAdmin;
    const [settings,sums,weights,defs,lib]=await Promise.all([api('GET','/api/settings'),api('GET','/api/days'),api('GET','/api/weights'),api('GET','/api/defaults'),api('GET','/api/foods')]);
    LIB=(lib&&lib.foods)||[];LIBV++;
    applyDefaults(defs);
    S.pud={...PUD_DEFAULT,...((settings||{}).pud||{})};S.snackOv=(settings||{}).snackOv||{};
    SAVED.settings=JSON.stringify({pud:S.pud,snackOv:S.snackOv});
    (sums||[]).forEach(s=>{SUMS[s.date]=s;LOGGED.add(s.date);});
    (weights||[]).forEach(w=>{WEIGHTS[w.date]=w.kg;});
    recalcPudding();
    restoreStash();
  }catch(e){if(!e.signedOut){$('#loading').textContent='Couldn’t load your data: '+e.message;}return;}
  showLoading(false);
  route();
})();
