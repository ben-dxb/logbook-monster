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
/* a real date (not 2026-02-31) from 2000 to a year from today – what the server stores (server/dates.js) */
const lastDate=()=>{const d=new Date();d.setFullYear(d.getFullYear()+1);return ymd(d);};
const isDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&ymd(parse(s))===s&&s>='2000-01-01'&&s<=lastDate();
const fmtLong=s=>parse(s).toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
const fmtShort=s=>parse(s).toLocaleDateString(undefined,{day:'numeric',month:'short'});
const fmtMonth=s=>parse(s).toLocaleDateString(undefined,{month:'long',year:'numeric'});

/* ---------- state ---------- */
let S={days:{},cur:todayStr()};            /* days: loaded day documents by date; pud & snackOv are account settings */
const SUMS={};                              /* date -> saved day summary (for calendar and week strip) */
const WEIGHTS={};                           /* date -> kg */
const SAVED={days:{},settings:null};        /* last JSON stored on the server, to spot what changed */
const LOGGED=new Set();                     /* dates stored on the server */
const VER={};                               /* date -> the server's `updated` of the copy this tab has, sent with each save */
const CONFLICT=new Set();                   /* dates changed in another tab or device since: this tab's edit stays on screen, unsaved */
let view='day', month=todayStr().slice(0,7)+'-01', csrf='', ME='';
let resetArmed=false, isAdmin=false, aiOn=false, planFiles=true;
let LIB=[], LIBV=0;                         /* the food library (yours and shared), and a version to spot changes */

/* ---------- server ---------- */
/* ver: the version (`updated`) of the record this change was made on, null for none yet; a newer one on the server
   answers 409 (e.conflict) and nothing is saved (server/version.js) */
async function api(method,url,body,ver,again){
  let r;
  try{r=await fetch(url,{method,credentials:'same-origin',
    headers:{...(body!==undefined?{'content-type':'application/json'}:{}),'x-csrf-token':csrf,...(ver!==undefined?{'x-version':ver==null?'none':ver}:{})},
    body:body!==undefined?JSON.stringify(body):undefined});}
  catch{throw new Error('Can’t reach the server – is it still running?');}
  if(r.status===401){setTimeout(toLogin,0);const e=new Error('You were signed out');e.signedOut=true;throw e;}
  if(r.status===404&&method==='GET') return null;
  const j=await r.json().catch(()=>({}));
  if(!r.ok){
    /* a sensitive change on an older sign-in: password or code again, then the same request once more */
    if(r.status===403&&j.recheck&&!again&&await recheck())return api(method,url,body,ver,true);
    if(r.status===403&&j.setup2fa)setTimeout(tfShow,0);
    const e=new Error(j.error||`HTTP ${r.status}`);e.conflict=r.status===409&&ver!==undefined;throw e;}
  return j;
}
function recheck(){
  const d=$('#recheck');if(d.open)return Promise.resolve(false);
  return new Promise(res=>{
    $('#rc-in').value='';$('#rc-msg').textContent='';
    const done=v=>{d.onclose=null;if(d.open)d.close();res(v);};
    $('#rc-form').onsubmit=async e=>{e.preventDefault();const v=$('#rc-in').value,c=v.replace(/\s/g,'');
      try{await api('POST','/api/recheck',/^\d{6}$/.test(c)?{code:c}:{password:v},undefined,true);done(true);}
      catch(err){$('#rc-msg').textContent=err.message;}};
    $('#rc-cancel').onclick=()=>done(false);d.onclose=()=>done(false);
    d.showModal();$('#rc-in').focus();
  });
}

/* Signed out with changes still waiting: keep them in this browser, under your account id, and send them after you sign back in
   (wherever you sign in). Each change keeps the server copy it was made on; it is sent only if the server still has that copy. */
const STASH='logbook-monster-unsaved', STASH_DAYS=14;
let UID=null, stashOut=false;
const stashKey=()=>STASH+':'+UID;
function toLogin(){
  if(pending.size&&UID!=null){try{localStorage.setItem(stashKey(),JSON.stringify({at:Date.now(),
    jobs:[...pending.entries()].map(([k,j])=>[k,j,k==='@settings'?SAVED.settings:LOGGED.has(k)?SAVED.days[k]:null])}));}catch{}}
  pending.clear();location.href='/login'+location.hash;   /* come back to the same day after signing in */
}
function dropStash(){stashOut=false;try{localStorage.removeItem(stashKey());}catch{}}
/* returns what wasn't put back because it changed elsewhere since */
async function restoreStash(){
  let st=null;
  try{   /* stashes older than STASH_DAYS go, whoever they belong to; older ones are keyed by email */
    for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(!/^(logbook-monster|mealswap)-unsaved/.test(k))continue;
      let o=null;try{o=JSON.parse(localStorage.getItem(k));}catch{}
      if(!o||!(Date.now()-o.at<=STASH_DAYS*86400000))localStorage.removeItem(k);}
    st=JSON.parse(localStorage.getItem(stashKey())||'null');
    for(const k of [STASH,'mealswap-unsaved']){const o=JSON.parse(localStorage.getItem(k)||'null');if(o&&o.email===ME){if(!st)st=o;localStorage.removeItem(k);}}
  }catch{}
  const jobs=(st&&Array.isArray(st.jobs)?st.jobs:[]).filter(x=>Array.isArray(x)&&typeof x[1]==='string');
  const srv={};   /* the server's copy of each stashed day, read before anything changes (a failure leaves the stash for next time) */
  for(const [k] of jobs)if(isDate(k)&&LOGGED.has(k))try{srv[k]=await api('GET','/api/days/'+k);if(srv[k])VER[k]=srv[k].updated;}catch(e){if(e.signedOut)throw e;return [];}
  const keep=[],skipped=[],utc=s=>s?Date.parse(s.replace(' ','T')+'Z'):0;
  for(const job of jobs){
    try{
      const [key,j]=job,old=job.length<3,v=JSON.parse(j);
      if(key==='@settings'){
        if(j===SAVED.settings)continue;
        if(!old&&job[2]!==SAVED.settings){skipped.push('your settings');continue;}
        S.pud={...PUD_DEFAULT,...(v.pud||{})};S.snackOv=v.snackOv||{};S.pBasis=v.pBasis==='direct'?'direct':'total';recalcPudding();
      }else if(isDate(key)&&v&&Array.isArray(v.meals)){
        const r=srv[key],sj=r?JSON.stringify(r.data):null;
        if(sj===j)continue;   /* already saved */
        const same=old?!r||utc(r.updated)<st.at:job[2]===sj||(!!r&&job[2]===JSON.stringify(migrate(r.data)));
        if(!same){skipped.push(fmtLong(key));continue;}
        const D=migrate(v);S.days[key]=D;SAVED.days[key]=sj;
      }else continue;
      pending.set(key,j);keep.push([key,j,key==='@settings'?SAVED.settings:SAVED.days[key]]);
    }catch{}   /* a broken entry is dropped */
  }
  if(keep.length){try{localStorage.setItem(stashKey(),JSON.stringify({at:st.at,jobs:keep}));}catch{}stashOut=true;}
  else if(st)dropStash();
  return skipped;
}

/* Older saves have no chosen amounts: take them from the plan */
function migrate(D){
  D.meals.forEach((m,mi)=>['p','c','x'].forEach(b=>(m[b]||(m[b]=[])).forEach(i=>{
    if(i.a==null){const bm=D.base&&D.base[mi];const bi=bm&&bm.id===m.id?(bm[b]||[]).find(x=>x.f===i.f):null;i.a=bi?bi.g:i.g;}})));
  D.off=D.off||[];
  libLoad(D);
  return D;
}
const pending=new Map(); let saveTimer=null, saveState='idle', saveErr='', inFlight=false;
const settingsJson=()=>JSON.stringify({pud:S.pud,snackOv:S.snackOv||{},pBasis:S.pBasis||'total'});
function summaryOf(date,D){useDefs(date);const t=dayTotals(D),type=D.type||typeOn(date);return {...t,targets:{...D.targets},type,tname:templateName(type)};}

/* Called after every render: anything that differs from what the server has gets queued. */
function persist(){
  for(const [date,D] of Object.entries(S.days)){
    libSync(D);
    if(CONFLICT.has(date))continue;
    const j=JSON.stringify(D);
    if(SAVED.days[date]===undefined){SAVED.days[date]=j;continue;}   /* first sight of an unsaved plan: baseline */
    if(SAVED.days[date]!==j) pending.set(date,j);
  }
  const sj=settingsJson();
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
      let r;
      try{r=await api('PUT','/api/days/'+key,{data:D,summary},VER[key]??null);}
      catch(e){if(!e.conflict)throw e;CONFLICT.add(key);pending.delete(key);continue;}   /* kept on screen; reload to see the other copy */
      VER[key]=r.updated;SAVED.days[key]=j;LOGGED.add(key);SUMS[key]={date:key,...summary};
    }
    saveState=pending.size?'pending':'saved';saveErr='';
    if(pending.size)saveTimer=setTimeout(flush,600);else if(stashOut)dropStash();
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
      if(r&&!S.days[date]){S.days[date]=migrate(r.data);SAVED.days[date]=JSON.stringify(S.days[date]);VER[date]=r.updated;}
    }catch(e){showLoading(false);if(!e.signedOut)alert('Couldn’t load that day: '+e.message);return false;}
    showLoading(false);
  }
  if(!S.days[date]){S.days[date]=freshOn(date);if(SAVED.days[date]===undefined)SAVED.days[date]=JSON.stringify(S.days[date]);}
  return true;
}
async function openDay(date){
  const was=S.cur;S.cur=date;
  if(!await loadDay(date))return;
  if(S.cur!==date)return;
  try{render();}catch(e){S.cur=was;render();alert('Couldn’t show that day: '+e.message);}   /* never leave another day on screen */
}
async function saveNow(){                    /* log a plan you haven't changed */
  const date=S.cur;pending.set(date,JSON.stringify(day()));await flush();
}
async function unlogDay(){
  const date=S.cur;
  if(!confirm(`Remove ${fmtLong(date)} from your history? This can’t be undone.`))return;
  try{await api('DELETE','/api/days/'+date);}catch(e){alert(e.message);return;}
  LOGGED.delete(date);delete SUMS[date];pending.delete(date);delete VER[date];CONFLICT.delete(date);
  S.days[date]=freshOn(date);SAVED.days[date]=JSON.stringify(S.days[date]);
  render();
}

/* ---------- rendering helpers ---------- */
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const r0=x=>Math.round(x), r1=x=>(Math.round(x*10)/10).toFixed(1);
/* the day on the Daily Tracker; a saved day is never started again from the plan before it has loaded (openDay loads it) */
const dayReady=()=>!!S.days[S.cur]||!LOGGED.has(S.cur);
function day(){useDefs(S.cur);if(!S.days[S.cur]){if(!dayReady())throw new Error('That day hasn’t loaded yet');S.days[S.cur]=freshDay(wdOf(S.cur));}return S.days[S.cur];}
/* a day's template name, short enough for the week strip and the calendar */
function tplLabel(d){const D=S.days[d],s=SUMS[d];return (s&&s.tname)||tnameOn(d,(D&&D.type)||(s&&s.type)||typeOn(d));}
const wd=()=>wdOf(S.cur);
function showLoading(on){$('#loading').hidden=!on;}

/* ---------- number boxes ----------
   A box the browser can't read ("80e", "abc") has the value '' – which used to save as 0, or delete a weight. Such a typo, or a
   number outside the box's min / max, never reaches the page's own listeners: the box goes back to the value it had and says so.
   Only a box really left empty counts as empty. */
const NUM_WAS=new WeakMap(), NUM_LIVE=new WeakSet();
const numBox=el=>el instanceof HTMLInputElement&&el.type==='number'&&!el.readOnly&&!el.disabled;
function numWhy(el){const v=el.validity;if(v.badInput)return 'That isn’t a number';if(!v.rangeUnderflow&&!v.rangeOverflow)return '';
  return el.min!==''&&el.max!==''?`Enter a number from ${el.min} to ${el.max}`:el.min!==''?`Enter ${el.min} or more`:`Enter ${el.max} or less`;}
let numTimer=0;
function numNote(text){let n=$('#numnote');
  if(!n){n=document.createElement('p');n.id='numnote';n.className='numnote';n.setAttribute('role','alert');document.body.appendChild(n);}
  n.textContent=text;n.hidden=false;clearTimeout(numTimer);numTimer=setTimeout(()=>{n.hidden=true;},4000);}
function numRefuse(el){const why=numWhy(el);if(!why)return false;
  const was=NUM_WAS.has(el)?NUM_WAS.get(el):el.defaultValue;el.value=was;
  numNote(`${why} – ${was===''?'left it empty':'kept '+was}.`);
  if(NUM_LIVE.has(el)){NUM_LIVE.delete(el);el.dispatchEvent(new Event('input',{bubbles:true}));}   /* pages that follow each keystroke go back too */
  return true;}
document.addEventListener('focusin',e=>{const el=e.target;if(numBox(el)&&!numWhy(el)){NUM_WAS.set(el,el.value);NUM_LIVE.delete(el);}},true);
document.addEventListener('input',e=>{const el=e.target;if(!numBox(el))return;
  if(el.validity.badInput)e.stopImmediatePropagation();else NUM_LIVE.add(el);},true);
document.addEventListener('change',e=>{const el=e.target;if(!numBox(el))return;
  if(numRefuse(el))e.stopImmediatePropagation();else{NUM_WAS.set(el,el.value);NUM_LIVE.delete(el);}},true);
document.addEventListener('focusout',e=>{const el=e.target;if(numBox(el)&&el.validity.badInput)numRefuse(el);},true);   /* "abc" typed into an empty box fires no change */

/* One tap, one save: while a button's (or form's) request runs, more clicks on it are ignored and its buttons are disabled; for a
   moment after, a second click still counts as the same tap (a double-click adds once). */
const ONCE=new WeakSet();
async function once(el,fn){
  if(ONCE.has(el))return;ONCE.add(el);
  const bs=(el.tagName==='FORM'?[...el.querySelectorAll('button')]:[el]).filter(b=>!b.disabled);
  bs.forEach(b=>{b.disabled=true;});
  try{return await fn();}
  finally{bs.forEach(b=>{b.disabled=false;});setTimeout(()=>ONCE.delete(el),400);}
}

function baseAmount(D,mi,box,f){const m=D.base[mi];if(!m||m.id!==D.meals[mi].id)return null;
  const b=(m[box]||[]).filter(i=>i.f===f);return b.length?b.reduce((s,i)=>s+i.g,0):null;}
function deltaTag(D,mi,box,i){
  const b=baseAmount(D,mi,box,i.f);const u=FOODS[i.f].unit||'g';
  if(b==null) return '<span class="delta new">new</span>';
  const d=Math.round(i.g-b); if(!d) return '<span class="delta"></span>';
  return `<span class="delta ${d>0?'up':'down'}">${d>0?'+':'−'}${Math.abs(d)}${esc(u)}</span>`;
}
function itemRow(D,mi,box,ii,i){
  const F=FOODS[i.f], id=`${S.cur}-${mi}-${box}-${ii}`, u=F.unit||'g', ro=D.meals[mi].eaten?' disabled':'';
  const list=box==='p'?PROTEIN_SWAPS:box==='x'?FAT_SWAPS:CARB_SWAPS;
  const opts=(list.includes(i.f)?list:[i.f,...list]).map(f=>`<option value="${esc(f)}"${f===i.f?' selected':''}>${esc(FOODS[f].n)}</option>`).join('');
  return `<div class="row${i.lock?' locked':''}${i.g===0?' zero':''}">
    <label class="lock" title="Lock this amount"><input type="checkbox" id="l-${id}" data-act="lock" data-m="${mi}" data-b="${box}" data-i="${ii}"${i.lock?' checked':''}${ro}><span>${i.lock?'Locked':'Lock'}</span></label>
    <select id="s-${id}" data-act="swap" data-m="${mi}" data-b="${box}" data-i="${ii}" aria-label="Food"${ro}>${opts}</select>
    <span class="amt"><input id="g-${id}" type="number" inputmode="decimal" min="0" step="${esc(F.step)}" value="${r0(i.g)}" data-act="amt" data-m="${mi}" data-b="${box}" data-i="${ii}" aria-label="Amount"${ro}><em>${esc(u)}</em></span>
    ${deltaTag(D,mi,box,i)}
    ${ro?'<span class="x"></span>':`<button class="x" data-act="del" data-m="${mi}" data-b="${box}" data-i="${ii}" aria-label="Remove">×</button>`}
  </div>`;
}
/* Delivered meat (foods with a daily order) comes in sauce: weigh the pack, get the amount to put on your plate */
function packOut(i,pk,F){const m=pk.m!=null?pk.m:F.order, g=packPortion(i.g,+pk.w,+m);
  return g==null?'Weigh the pack to get your portion':`Weigh out <b>${r0(g)}g</b> of the pack${i.g>m?' – more than one pack':''}`;}
function packHtml(D,mi,i){
  const F=FOODS[i.f], pk=(D.packs||{})[i.f]||{}, id=esc(`pk-${S.cur}-${mi}-${i.f}`), fa=esc(i.f), ro=D.meals[mi].eaten?' disabled':'';
  const name=esc(F.n.replace(/^Health Road /,''));
  return `<div class="pack"><label class="pf"><span class="lbl">Pack with sauce</span><span class="amt"><input id="${id}-w" type="number" inputmode="decimal" min="0" step="1" value="${pk.w!=null?esc(pk.w):''}" placeholder="weigh" data-act="pack" data-f="${fa}" data-k="w"${ro}><em>g</em></span></label>
    <label class="pf"><span class="lbl">${name} in it</span><span class="amt"><input id="${id}-m" type="number" inputmode="decimal" min="0" step="1" value="${esc(pk.m!=null?pk.m:F.order)}" data-act="pack" data-f="${fa}" data-k="m"${ro}><em>g</em></span></label>
    <span class="pout" data-packout="${fa}" data-g="${esc(i.g)}" aria-live="polite">${packOut(i,pk,F)}</span></div>`;
}
function macLine(t){return `<span class="ml"><b>${r0(t.k)}</b> kcal · P ${r1(t.p)} · C ${r1(t.c)} · F ${r1(t.f)}</span>`;}
function boxHtml(D,mi,box,label){
  const items=D.meals[mi][box]||(D.meals[mi][box]=[]);const t=sum(items.map(i=>macOf(i.f,i.g)));
  return `<div class="box"><div class="bh"><span class="lbl">${label}</span>${items.length?macLine(t):''}</div>
    ${items.map((i,ii)=>itemRow(D,mi,box,ii,i)).join('')||'<p class="empty">Nothing here</p>'}
    ${box==='p'?items.filter(i=>i.g>0&&FOODS[i.f].order!=null).map(i=>packHtml(D,mi,i)).join(''):''}
    ${D.meals[mi].eaten?'':`<div class="add"><select id="a-${S.cur}-${mi}-${box}" data-add="${box}" data-m="${mi}" aria-label="Add a food"><option value="">+ Add a food…</option>${(box==='x'?FAT_SWAPS:Object.keys(FOODS).filter(f=>!FAT_SWAPS.includes(f)&&planFood(f))).map(f=>`<option value="${esc(f)}">${esc(FOODS[f].n)}</option>`).join('')}${libOptions()}</select></div>`}
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
    return `<button class="tab${d===S.cur?' on':''}${d===t?' today':''}${LOGGED.has(d)?' logged':''}" data-act="day" data-d="${d}" aria-pressed="${d===S.cur}" aria-label="${esc(fmtLong(d))}${LOGGED.has(d)?', saved':''}"><small>${n}</small><b>${parse(d).getDate()}</b><small class="tn">${esc(tplLabel(d))}</small></button>`;}).join('');
}
function renderStatus(){
  if(view!=='day')return;
  const date=S.cur, logged=LOGGED.has(date), p=pending.has(date);
  let h;
  const cd=CONFLICT.has(date)?date:CONFLICT.values().next().value;
  if(cd) h=`<span class="chip bad">Not saved</span> ${cd===date?'This day':esc(fmtLong(cd))} changed in another tab or device – reload to see it. Your change here isn’t saved. <button class="ghost" data-act="reload">Reload</button>`;
  else if(saveState==='error'&&(p||pending.size)) h=`<span class="chip bad">Not saved</span> ${esc(saveErr)} Retrying… <button class="ghost" data-act="retry">Retry now</button>`;
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
/* the protein-basis buttons (Daily Tracker and Account admin) show the account setting */
function pbSync(){document.querySelectorAll('[data-act="pbasis"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===(pKey()==='d'?'direct':'total'))));}
function render(){
  if(view!=='day'||!dayReady())return;
  const D=day(), T=dayTotals(D), tg=D.targets, t=D.type||TYPE[wd()], td=todayStr();
  $('#dtitle').textContent=S.cur===td?'Today':S.cur===addDays(td,-1)?'Yesterday':S.cur===addDays(td,1)?'Tomorrow':parse(S.cur).toLocaleDateString(undefined,{weekday:'long'});
  $('#dsub').textContent=fmtLong(S.cur)+(templateName(t)?` · ${templateName(t)}`:'');
  $('#todaybtn').hidden=S.cur===td;
  const dp=$('#datepick');dp.min='2000-01-01';dp.max=lastDate();dp.value=S.cur;
  renderWeek();
  renderWeightInline();
  const names={k:'Calories',p:'Protein min',c:'Carbs',f:'Fat max'};
  const dir=pKey()==='d';if(dir)names.p='Direct protein min';
  const val=m=>m==='p'&&dir?T.d:T[m];
  $('#sum').innerHTML=MAC.map(m=>`<div class="stat"><span class="lbl">${names[m]}</span>
      <span class="num">${r0(val(m))}<i>/ ${r0(tg[m])}${m==='k'?'':'g'}</i></span>${chip(m,val(m),+tg[m])}
      ${m==='p'?`<span class="sub">${dir?`total ${r0(T.p)}g`:`direct ${r0(T.d)}g`}</span>`:''}</div>`).join('');
  pbSync();
  const left={k:tg.k-T.k,p:tg.p-T.p,c:tg.c-T.c,f:tg.f-T.f};
  $('#left').innerHTML=D.auto?'':`<b>Left to spend off plan:</b> ${r0(Math.max(0,left.k))} kcal · P ${r1(Math.max(0,left.p))} · C ${r1(Math.max(0,left.c))} · F ${r1(Math.max(0,left.f))}`;
  $('#left').hidden=D.auto;
  const w=warnings(D);
  $('#warn').innerHTML=w.map(x=>`<li>${esc(x)}</li>`).join(''); $('#warn').hidden=!w.length;
  /* the day template this day follows: the weekday's, or another one picked for this day */
  $('#opts').innerHTML=`
    ${TEMPLATES.length>1?`<label class="tog dtpl"><span class="lbl">Day template</span><select id="dtpl" data-act="dtpl" aria-label="Day template">${TEMPLATES.map(x=>`<option value="${esc(x.id)}"${x.id===t?' selected':''}>${esc(x.name)}${x.id===TYPE[wd()]?' (this weekday)':''}</option>`).join('')}${hasTemplate(t)?'':'<option value="" selected>(no longer in your plan)</option>'}</select></label>`:''}
    <label class="tog"><input type="checkbox" id="auto" data-act="auto"${D.auto?' checked':''}> Auto-balance the day</label>
    <button class="ghost" data-act="reset">${resetArmed?'Tap again to reset':'Reset day to plan'}</button>`;
  $('#meals').innerHTML=(!TEMPLATES.length&&!D.meals.length?`<section class="panel noplan"><h2>No meal plan yet</h2>
      <p>Your meal plan is your own: your foods, day templates (training day, rest day…), targets and which days you train. Set it up on the
      <a href="#account">Account admin</a> page – upload your coach's plan (CSV, JSON or a PDF read with AI) or build it there. Until then you can still log food below.</p>
      <p><a class="btn" href="#account">Set up my meal plan</a></p></section>`:'')+D.meals.map((m,mi)=>{
    const mt=sum([...m.p,...m.c,...(m.x||[])].map(i=>macOf(i.f,i.g)));
    const all=[...m.p,...m.c,...(m.x||[])];const saved=!m.dirty&&all.length&&all.every(i=>i.lock);
    const eat=m.eaten?`<span class="chip ok">✓ Eaten</span><button class="ghost" data-act="uneat" data-m="${mi}">Undo eaten</button>`
      :`${saved?'<span class="chip ok">Locked</span>':''}<button class="ghost" data-act="eat" data-m="${mi}">Mark eaten</button>`;
    return `<section class="meal${m.dirty?' dirty':''}${m.eaten?' eaten':''}"><header><span class="mn">Meal ${esc(m.id)}</span><h2>${esc(m.name)}</h2>${macLine(mt)}${eat}</header>
      ${m.dirty?`<div class="savebar" role="status"><span>Changes not saved – the rest of the day won't move until you save.</span><label class="tog" title="The meal's other unlocked foods move to keep its calories – handy after changing protein or fats"><input type="checkbox" id="mc-${S.cur}-${mi}" data-act="mcalc" data-m="${mi}"${m.calc?' checked':''}> Balance this meal as I edit</label><span class="sb"><button class="ghost" data-act="undo" data-m="${mi}">Undo changes</button><button class="btn" data-act="save" data-m="${mi}">Save meal</button></span></div>`:''}
      ${m.note?`<p class="mnote">${esc(m.note)}</p>`:''}
      <div class="boxes">${BOXES.map(([b,l])=>boxHtml(D,mi,b,l)).join('')}</div></section>`;
  }).join('');
  const ot=sum(D.off.map(o=>({k:+o.k||0,p:+o.p||0,c:+o.c||0,f:+o.f||0})));
  $('#offlist').innerHTML=D.off.map((o,oi)=>`<div class="orow"><span>${esc(o.n||'Off-plan food')}</span>${o.snack||o.lib?`<label class="qty"><input id="oq-${S.cur}-${oi}" type="number" inputmode="decimal" min="0" step="${o.lib&&o.u==='each'?'0.5':'1'}" value="${+o.qty||0}" data-act="oqty" data-i="${oi}">${o.lib?esc(libUnit(o.u)):snackVal(o.snack).u==='g'?'g':'×'}</label>`:''}<span class="ml">${r0(+o.k||0)} kcal · P ${r1(+o.p||0)} · C ${r1(+o.c||0)} · F ${r1(+o.f||0)}</span><button class="x" data-act="odel" data-i="${oi}" aria-label="Remove">×</button></div>`).join('')
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
    ['k','p','c','f'].map(m=>`<input id="sv-${x.id}-${m}" type="number" inputmode="decimal" min="0" step="0.1" value="${esc(v[m])}" data-act="sv" data-s="${x.id}" data-m="${m}" aria-label="${esc(x.n)} ${m}">`).join('');}).join('')+'</div>';
  persist();
}

/* ---------- food library on the day page (the library itself is in foods.js) ---------- */
const libUnit=u=>u==='each'?'×':u;
const libPer=u=>u==='each'?'per item':`per 100${u}`;
function libMac(o,qty){const m=o.u==='each'?qty:qty/100;return {k:o.per.k*m,p:o.per.p*m,c:o.per.c*m,f:o.per.f*m};}
/* what goes in a day's off-plan list: carries its own values, so it still works if the food is later changed or removed */
function libEntry(food,qty){const o={n:food.name,lib:food.id,u:food.unit,per:{k:food.k,p:food.p,c:food.c,f:food.f},qty};if(food.free)o.free=food.free;return Object.assign(o,libMac(o,qty));}
function libAdd(D,food,qty){
  const ex=D.off.find(o=>o.lib===food.id&&o.u===food.unit&&(o.free||'')===(food.free||'')&&['k','p','c','f'].every(m=>o.per[m]===food[m]));
  if(ex){ex.qty+=qty;Object.assign(ex,libMac(ex,ex.qty));}else D.off.push(libEntry(food,qty));
}
const libDefault=u=>u==='each'?1:100;
/* Library foods inside meals. Each version of a food's values gets its own calculator id, L:<id>:<hash>
   (never a valid admin food id), and a day keeps a copy of the ones it uses in D.lib, so saved days still
   add up after a food is edited, unshared or deleted. Values are per 100 like every food; a per-item food
   counts its amount in items, so its values are stored ×100. */
const isLib=f=>typeof f==='string'&&f.startsWith('L:');
function libHash(food){let h=5381;for(const ch of [food.unit,food.k,food.p,food.c,food.f].concat(food.free?[food.free]:[]).join('|'))h=(h*33+ch.charCodeAt(0))>>>0;return h.toString(36);}
const libFid=food=>`L:${food.id}:${libHash(food)}`;
/* An AI-estimated food keeps its ⚑ in meals, and the day's copy remembers its type and which values were estimates. */
function libFoodRec(food){const m=food.unit==='each'?100:1;
  const F={n:food.name+(food.ai?' ⚑':''),kind:food.kind,ai:food.ai?food.ai.fields:undefined,k:food.k*m,p:food.p*m,c:food.c*m,f:food.f*m,d:0,step:food.unit==='each'?1:food.unit==='ml'?10:5};
  if(food.free)F.free=food.free;
  if(food.unit!=='g')F.unit=food.unit==='each'?'×':'ml';return F;}
function libLoad(D){for(const [fid,F] of Object.entries(D.lib||{}))if(isLib(fid)&&!FOODS[fid])FOODS[fid]={...F};planFill(D);}
/* A saved day can use a plan food the plan in effect on its date doesn't have (a plan change carried over without it,
   or one dated after the day was made): take it from your other plan changes, newest first, or show it with no values,
   so the day still opens. */
function planFill(D){
  const vs=(typeof DEFS!=='undefined'&&DEFS.myVersions)||[];
  allItems(D).forEach(({f})=>{if(FOODS[f])return;
    const v=!isLib(f)&&[...vs].reverse().find(x=>x.foods&&x.foods[f]&&typeof x.foods[f]==='object');
    FOODS[f]={...(v?planFoodRec(f,v.foods[f]):{n:`Unknown food (${f})`,k:0,p:0,c:0,f:0,d:0,step:1}),gone:true};});
}
/* After the library changes or the admin defaults are applied (which drop foods the calculator didn't ship with). */
function libRegister(){LIB.forEach(f=>{FOODS[libFid(f)]=libFoodRec(f);});Object.values(S.days).forEach(libLoad);LIBV++;}
function libSync(D){let lib=null;
  allItems(D).forEach(i=>{if(isLib(i.f)&&FOODS[i.f]){lib=lib||{};lib[i.f]=(D.lib&&D.lib[i.f])||{...FOODS[i.f]};}});
  if(lib)D.lib=lib;else delete D.lib;}
const libOptions=()=>[['meal','Library meals'],['ingredient','Library ingredients']].map(([k,l])=>{
  const list=LIB.filter(f=>(f.kind==='meal')===(k==='meal'));
  return list.length?`<optgroup label="${l}">${list.map(f=>`<option value="${esc(libFid(f))}">${esc(f.name)}${f.ai?' ⚑':''}</option>`).join('')}</optgroup>`:'';}).join('');
/* which box a library food goes in when added to a meal from the Foods page: where most of its calories come from */
function libBox(f){const p=f.p*4,c=f.c*4,x=f.f*9;return p>=c&&p>=x?'p':x>c?'x':'c';}
/* Add a library food to any day (from the Foods page): off plan, or into a meal (saved, so the rest of the day rebalances). */
async function addFoodToDay(food,date,qty,mi){
  if(!(qty>0)||!isDate(date))return false;
  if(!await loadDay(date))return false;
  S.cur=date;
  /* a food from your meal plan goes in as the plan's own food; a plan meal or library food as a library food */
  const D=day(), fid=food.fid||libFid(food);
  if(mi!=null&&D.meals[mi]&&D.meals[mi].eaten){alert(`Meal ${D.meals[mi].id} is marked eaten – undo that first to change it.`);go('day/'+date);return false;}
  if(!food.fid&&!FOODS[fid])FOODS[fid]=libFoodRec(food);
  if(mi!=null&&D.meals[mi]&&FOODS[fid]){const box=(food.fid&&foodGroup(food.fid))||libBox(food);
    editMeal(mi,box,(D,m)=>{(m[box]=m[box]||[]).push(it(fid,qty));});saveMeal(mi);}
  else act(D=>libAdd(D,food,qty));
  go('day/'+date);
  return true;
}
function renderLibForm(){
  const sel=$('#ln');$('#libform').hidden=!LIB.length;$('#libnone').hidden=!!LIB.length;
  if(sel.dataset.v===String(LIBV))return;
  const keep=sel.value;sel.dataset.v=String(LIBV);
  const opt=f=>`<option value="${esc(f.id)}">${esc(f.name)} (${esc(libPer(f.unit))})${f.ai?' ⚑':''}</option>`;
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
      <span class="dn">${parse(d).getDate()}<small>${esc(tplLabel(d))}</small></span>
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

/* ---------- weight ---------- */
async function setWeight(date,kg){
  if(kg==null){await api('DELETE','/api/weights/'+date);delete WEIGHTS[date];}
  else{await api('PUT','/api/weights/'+date,{kg});WEIGHTS[date]=Math.round(kg*100)/100;}
}

/* ---------- routing: #dash (the landing page), #day/2026-10-15, #history/2026-10, #history/timeline/…, #gym/…, #foods/…, #supps/…, #photos/…, #account, #admin ----------
   History has two tabs: Calendar (#history) and Timeline (#history/timeline, the 'timeline' view); old #timeline links still work, and old #weight links open the Timeline (weight is logged on the Daily Tracker).
   #account (account admin, anyone) and #admin (super admin; tabs #admin/ai, #admin/people, #admin/email) share the #v-admin page. */
const VIEWS=['dash','day','history','gym','foods','supps','photos','timeline','account','admin'];
const viewEl=n=>$('#v-'+(n==='account'?'admin':n));
/* a tab left open past midnight: whatever was on 'today' moves to the new today (the date of the action, not of the page load) */
let TODAY=todayStr();
function rollToday(){const t=todayStr(),was=TODAY;if(t===was)return;TODAY=t;
  if(S.cur===was)S.cur=t;
  if(month===was.slice(0,7)+'-01')month=t.slice(0,7)+'-01';
  if(typeof sDate==='string'&&sDate===was)sDate=t;   /* Supplements log day, photo upload date */
  if(typeof pDate==='string'&&pDate===was)pDate=t;
}
function route(){
  rollToday();
  if(/^#weight(\/|$)/.test(location.hash))history.replaceState(null,'','#history/timeline');
  if(/^#timeline(\/|$)/.test(location.hash))history.replaceState(null,'','#history/'+location.hash.slice(1));
  let [v,arg,...more]=location.hash.replace(/^#/,'').split('/');
  if(v==='history'&&arg==='timeline'){v='timeline';[arg,...more]=more;}
  view=VIEWS.includes(v)&&(v!=='admin'||isAdmin)?v:v?'day':'dash';
  const top=view==='timeline'?'history':view;
  document.querySelectorAll('.views a').forEach(a=>{if(a.dataset.view===top)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  document.querySelectorAll('.htabs a').forEach(a=>{if(a.dataset.h===(view==='timeline'?'timeline':'cal'))a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  VIEWS.forEach(n=>{viewEl(n).hidden=true;});viewEl(view).hidden=false;
  $('#acct').open=false;
  if(view==='dash'){renderDash(arg?[arg]:[]);}
  else if(view==='day'){openDay(isDate(arg)?arg:S.cur);}
  else if(view==='history'){if(/^\d{4}-\d{2}$/.test(arg||''))month=arg+'-01';renderHistory();}
  else if(view==='account'||view==='admin'){adRoute(arg);}
  else if(view==='gym'){renderGym(arg?[arg,...more]:[]);}
  else if(view==='foods'){renderFoods(arg?[arg]:[]);}
  else if(view==='supps'){renderSupps(arg?[arg,...more]:[]);}
  else if(view==='photos'){renderPhotos(arg?[arg,...more]:[]);}
  else renderTimeline(arg?[arg]:[]);
}
function go(hash){if(location.hash==='#'+hash)route();else location.hash=hash;}

/* ---------- actions (calculator) ---------- */
function act(fn,opts){if(!dayReady())return;const D=day();const held=new Set();fn(D,held);
  D.meals.forEach(m=>{if(m.dirty)BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>held.add(i)));}); /* unsaved meals stay as you left them */
  solve(D,held,opts||{});render();}
/* edits inside a meal wait for 'Save meal' – nothing else moves until then. With 'Balance this meal' ticked on the meal (m.calc,
   off for every new edit), the meal's other foods move as you edit to keep its calories; what you changed or added (i.ed) stays. */
function editMeal(mi,box,fn){if(!dayReady())return;const D=day();const m=D.meals[mi];
  if(m.eaten){render();return;}           /* an eaten meal is locked until you undo it */
  if(!m._snap)m._snap=clone({p:m.p,c:m.c,x:m.x||[]});
  const before=new Set(BOXES.flatMap(([b])=>m[b]||[]));
  fn(D,m);BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>{if(!before.has(i))i.ed=true;}));
  m.dirty=true;if(box==='p')m.dirtyProt=true;
  if(m.calc)balanceMeal(m);
  render();}
function saveMeal(mi){const D=day();const m=D.meals[mi];const held=new Set();
  BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>{i.lock=true;i.a=i.g;delete i.ed;delete i.g0;held.add(i);}));
  const protect=!m.dirtyProt;delete m._snap;delete m.dirty;delete m.dirtyProt;delete m.calc;
  D.meals.forEach(o=>{if(o.dirty)BOXES.forEach(([b])=>(o[b]||[]).forEach(i=>held.add(i)));});
  solve(D,held,{protect});render();}
/* Eaten: the whole meal is locked as it is (unsaved changes saved first) and the rest of the day balances around it.
   Undoing asks first. */
function eatMeal(mi){const D=day();const m=D.meals[mi];if(!m||m.eaten)return;
  if(m.dirty)saveMeal(mi);
  m.eaten=true;render();}
function uneatMeal(mi){const D=day();const m=D.meals[mi];if(!m||!m.eaten)return;
  if(!confirm(`Meal ${m.id} – ${m.name} is marked eaten. Undo that and unlock it for changes?`))return;
  delete m.eaten;render();}
const anyEaten=D=>D.meals.some(m=>m.eaten);
function undoMeal(mi){const D=day();const m=D.meals[mi];if(m._snap)Object.assign(m,clone(m._snap));
  delete m._snap;delete m.dirty;delete m.dirtyProt;delete m.calc;render();}
/* tick: balance the meal now; untick: the foods it moved go back to where you left them */
function calcMeal(mi,on){const m=day().meals[mi];if(!m.dirty)return;
  if(on){m.calc=true;balanceMeal(m);}
  else{delete m.calc;BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>{if(i.g0!=null){i.g=i.g0;delete i.g0;}}));}
  render();}

document.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]'); if(!b||b.tagName==='INPUT'||b.tagName==='SELECT')return;
  const a=b.dataset.act;
  if(b.closest('#v-day')&&!dayReady()&&!['prev','next','today'].includes(a))return;   /* still loading */
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
  else if(a==='reload')location.reload();
  else if(a==='del'){editMeal(+b.dataset.m,b.dataset.b,(D,m)=>{m[b.dataset.b].splice(+b.dataset.i,1);});}
  else if(a==='save'){saveMeal(+b.dataset.m);}
  else if(a==='undo'){undoMeal(+b.dataset.m);}
  else if(a==='eat'){eatMeal(+b.dataset.m);}
  else if(a==='uneat'){uneatMeal(+b.dataset.m);}
  else if(a==='odel'){act(D=>{D.off.splice(+b.dataset.i,1);});}
  else if(a==='pbasis'){if(S.pBasis!==b.dataset.v){S.pBasis=b.dataset.v;if(S.days[S.cur])act(()=>{});if(view!=='day'){pbSync();persist();}}}   /* a day not loaded takes it when it opens */
  else if(a==='reset'){if(!resetArmed){resetArmed=true;render();return;}resetArmed=false;
    if(anyEaten(day())&&!confirm('Some meals are marked eaten. Reset the whole day to the plan anyway? That undoes them.')){render();return;}
    S.days[S.cur]=freshOn(S.cur,day().type);render();}
});
/* pack weights: update the portion as you type, without re-rendering under your fingers */
function setPack(el){const D=day(),f=el.dataset.f;D.packs=D.packs||{};const p=D.packs[f]=D.packs[f]||{};
  const v=el.value.trim();if(v===''||!(+v>=0))delete p[el.dataset.k];else p[el.dataset.k]=+v;
  if(!Object.keys(p).length)delete D.packs[f];if(!Object.keys(D.packs).length)delete D.packs;
  return {f,pk:p};}
/* the Daily Tracker's own controls only (other views have ids like t-…) */
const onTracker=el=>!!el.closest('#v-day')&&dayReady();
document.addEventListener('input',e=>{const el=e.target;if(el.dataset.act!=='pack'||!onTracker(el))return;
  const {f,pk}=setPack(el);
  document.querySelectorAll(`[data-packout="${CSS.escape(f)}"]`).forEach(o=>{o.innerHTML=packOut({g:+o.dataset.g},pk,FOODS[f]);});
  persist();});
document.addEventListener('change',e=>{
  const el=e.target, a=el.dataset.act;
  if(!onTracker(el)&&el.id!=='datepick')return;
  if(a==='pack'){setPack(el);render();return;}
  const get=D=>D.meals[+el.dataset.m][el.dataset.b][+el.dataset.i];
  if(a==='lock'){const D=day();get(D).lock=el.checked;render();}
  else if(a==='amt'){editMeal(+el.dataset.m,el.dataset.b,D=>{const i=get(D);i.g=Math.max(0,+el.value||0);i.a=i.g;i.ed=true;});}
  else if(a==='swap'){editMeal(+el.dataset.m,el.dataset.b,D=>{const h=new Set();const i=get(D),box=D.meals[+el.dataset.m][el.dataset.b];const mac=el.dataset.b==='p'?'p':el.dataset.b==='x'?'f':'c';
      const need=FOODS[i.f][mac]*i.g/100;placeMatched(box,el.value,mac,need,h,i);h.forEach(x=>{x.ed=true;});});}
  else if(a==='dtpl'){const D=day();if(!el.value||el.value===D.type)return;
    if(anyEaten(D)){alert('Some meals are marked eaten – undo them first to switch this day to another template.');render();return;}
    if(D.meals.some(m=>m.dirty)&&!confirm('This day has unsaved meal changes. Switch template anyway? They’re dropped.')){render();return;}
    /* start the day again from that template; off-plan food and pack weights stay */
    const N=freshDay(wd(),el.value);N.off=D.off;if(D.packs)N.packs=D.packs;S.days[S.cur]=N;render();}
  else if(a==='auto'){act(D=>{D.auto=el.checked;});}
  else if(a==='mcalc'){calcMeal(+el.dataset.m,el.checked);}
  else if(el.dataset.add){const mi=+el.dataset.m,box=el.dataset.add,f=el.value;if(!f||!FOODS[f])return;
      const g=isLib(f)?(FOODS[f].unit==='×'?1:100):FOODS[f].min||(FOODS[f].step>=5?50:10);
      editMeal(mi,box,(D,m)=>{const n=it(f,g);(m[box]=m[box]||[]).push(n);});}
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
  once(e.target,()=>act(D=>{const ex=D.off.find(o=>o.snack===id);
    if(ex){ex.qty+=q;Object.assign(ex,snackMac(id,ex.qty));}
    else D.off.push({n:snackVal(id).n,snack:id,qty:q,...snackMac(id,q)});}));
});
$('#libform').addEventListener('submit',e=>{
  e.preventDefault();const f=LIB.find(x=>String(x.id)===$('#ln').value),q=+$('#lq').value||0;if(!f||!(q>0))return;
  once(e.target,()=>act(D=>libAdd(D,f,q)));
});
$('#offform').addEventListener('submit',e=>{e.preventDefault();once(e.target,offAdd);});
async function offAdd(){
  const v=id=>$('#'+id).value;
  const o={n:v('o-n').trim()||'Off-plan food',k:+v('o-k')||0,p:+v('o-p')||0,c:+v('o-c')||0,f:+v('o-f')||0};
  if(!o.k&&!o.p&&!o.c&&!o.f)return;
  let food=null;
  if($('#o-save').checked){   /* keep it in the food library as one item, to add again on other days */
    try{food=await api('POST','/api/foods',{name:o.n,unit:'each',k:o.k,p:o.p,c:o.c,f:o.f});LIB.push(food);LIB.sort((a,b)=>a.name.localeCompare(b.name));libRegister();}
    catch(err){if(!err.signedOut)alert('Couldn’t save it to your food library: '+err.message);return;}
  }
  act(D=>{if(food)libAdd(D,food,1);else D.off.push(o);});
  ['o-n','o-k','o-p','o-c','o-f'].forEach(id=>$('#'+id).value='');$('#o-save').checked=false;
}
$('#coach').addEventListener('click',()=>act(D=>{const t=hasTemplate(D.type)?D.type:TYPE[wd()];D.targets={...(t?COACH[t]:{k:0,p:0,c:0,f:0})};}));

/* ---------- account ---------- */
window.addEventListener('hashchange',route);
$('#logout').addEventListener('click',async()=>{
  if(pending.size){clearTimeout(saveTimer);await flush();}
  const keep=[];try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith(STASH))keep.push([k,localStorage.getItem(k)]);}}catch{}
  try{await api('POST','/auth/logout',{});}catch{}
  /* sign-out clears this site's storage (Clear-Site-Data); put back changes still waiting to be sent (anyone's) */
  try{keep.forEach(([k,v])=>localStorage.setItem(k,v));}catch{}
  if(pending.size&&ME)toLogin();else location.href='/login';
});
$('#pwform').addEventListener('submit',async e=>{
  e.preventDefault();const msg=$('#pwmsg');msg.textContent='';
  try{const r=await api('POST','/auth/password',{current:$('#pw-cur').value,next:$('#pw-new').value,endLinks:$('#pw-links').checked});
    msg.textContent='Password updated.'+(r.signedOut?' Signed out everywhere else.':'')+(r.linksOff?` ${r.linksOff} coach link${r.linksOff>1?'s':''} switched off.`:'');$('#pw-cur').value=$('#pw-new').value='';$('#pwcur').hidden=false;}
  catch(err){msg.textContent=err.message;}
});
document.addEventListener('click',e=>{const d=$('#acct');if(d.open&&!d.contains(e.target)&&!$('#recheck').contains(e.target))d.open=false;});

/* two-step sign-in: set up (key + otpauth link, confirmed with one code, then 10 recovery codes) and switch off */
let TF=null,tfNew=null,tfCodes=null;
async function tfLoad(){try{TF=await api('GET','/api/totp');}catch(e){TF=null;}tfRender();}
function tfRender(msg=''){
  const b=$('#tfbody');let h='';
  if(tfCodes)h=`<p class="sub">Two-step sign-in is on. Save these recovery codes somewhere safe – each one works once, if you lose your phone. They won’t be shown again.</p>
    <ul class="tfcodes" id="tf-codes">${tfCodes.map(c=>`<li>${esc(c)}</li>`).join('')}</ul><button class="ghost" type="button" data-tf="done">I’ve saved them</button>`;
  else if(TF&&TF.on)h=`<p class="sub">On: after your password you’re asked for a code from your authenticator app. ${TF.recoveryLeft} recovery code${TF.recoveryLeft===1?'':'s'} left.</p>
    <form data-tf="off" class="pwform"><label class="f"><span class="lbl">Password or code, to switch it off</span><input id="tf-offin" type="password" autocomplete="current-password"></label>
    <button class="ghost" type="submit">Switch off</button></form>`;
  else if(tfNew)h=`<p class="sub">Add this key to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) as a time-based key, or open the link on your phone:</p>
    <p class="tfsecret" id="tf-secret">${esc(tfNew.secret.replace(/(.{4})/g,'$1 ').trim())}</p><a class="ghost" href="${esc(tfNew.uri)}">Open in authenticator app</a>
    <form data-tf="on" class="pwform"><label class="f"><span class="lbl">The 6-digit code it shows</span><input id="tf-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7"></label>
    <button class="btn" type="submit">Turn on</button></form>`;
  else h=`<p class="sub">Ask for a code from an authenticator app on your phone after your password, so a leaked password alone can’t get in.</p>
    <button class="btn" type="button" data-tf="start">Set up</button>`;
  b.innerHTML=h+`<p class="sub" id="tfmsg" role="status">${esc(msg)}</p>`;
}
function tfShow(){$('#acct').open=true;$('#tfbox').open=true;tfLoad();}
$('#tfbox').addEventListener('toggle',()=>{if($('#tfbox').open&&!tfNew&&!tfCodes)tfLoad();});
$('#tfbody').addEventListener('click',async e=>{
  const a=e.target.closest('button[data-tf]');if(!a)return;
  if(a.dataset.tf==='start'){try{tfNew=await api('POST','/api/totp/setup',{});tfRender();$('#tf-code').focus();}catch(err){if(!err.signedOut)tfRender(err.message);}}
  else if(a.dataset.tf==='done'){tfCodes=null;tfLoad();}
});
$('#tfbody').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target.dataset.tf;
  if(f==='on'){try{const r=await api('POST','/api/totp/enable',{code:$('#tf-code').value.replace(/\s/g,'')});tfNew=null;tfCodes=r.codes;tfRender(r.signedOut?'Signed out everywhere else.':'');}
    catch(err){if(!err.signedOut)$('#tfmsg').textContent=err.message;}}
  else if(f==='off'){const v=$('#tf-offin').value,c=v.replace(/\s/g,'');
    try{await api('POST','/api/totp/disable',/^\d{6}$/.test(c)||/^[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}$/.test(c)?{code:c}:{password:v});TF=null;await tfLoad();$('#tfmsg').textContent='Two-step sign-in is off.';}
    catch(err){if(!err.signedOut)$('#tfmsg').textContent=err.message;}}
});

/* ---------- start ---------- */
(async()=>{
  let skipped=[];
  try{
    const me=await api('GET','/api/me');csrf=me.csrf;ME=me.email;UID=me.id;
    $('#who').textContent=me.name||me.email;$('#who').title=me.email;
    if(!me.hasPassword){$('#pwcur').hidden=true;$('#pwbox').querySelector('summary').textContent='Set a password';}
    isAdmin=!!me.admin;aiOn=!!me.ai;planFiles=me.planFiles!==false;$('#adminlink').hidden=!isAdmin;
    const [settings,sums,weights,defs,lib]=await Promise.all([api('GET','/api/settings'),api('GET','/api/days'),api('GET','/api/weights'),api('GET','/api/defaults'),api('GET','/api/foods')]);
    LIB=(lib&&lib.foods)||[];fAiOn=!!(lib&&lib.ai);
    setDefaults(defs);
    S.pud={...PUD_DEFAULT,...((settings||{}).pud||{})};S.snackOv=(settings||{}).snackOv||{};
    S.pBasis=(settings||{}).pBasis==='direct'?'direct':'total';
    SAVED.settings=settingsJson();
    (sums||[]).forEach(s=>{SUMS[s.date]=s;LOGGED.add(s.date);});
    (weights||[]).forEach(w=>{WEIGHTS[w.date]=w.kg;});
    recalcPudding();
    skipped=await restoreStash();
  }catch(e){if(!e.signedOut){$('#loading').textContent='Couldn’t load your data: '+e.message;}return;}
  showLoading(false);
  route();
  if(pending.size)flush();   /* changes kept from a sign-out go now, whatever page you land on */
  if(skipped.length)alert(`Changes you made before you were signed out weren’t put back, because ${skipped.join(', ')} changed on another device or tab since. The newer copy is kept.`);
  jobsInit();
})();
