'use strict';
/* Dashboard (#dash, the landing page): the daily checklist for a day of the last week, then a card per module –
   today's food against its targets, weight, gym, the supplement regime and the latest progress photo – each
   linking to its page. #dash/2026-10-15 opens that day's checklist.
   The checklist's items are the account's own (Account admin › Daily checklist, server/checklist.js). Items with an
   automatic tick count as done on a day the app already has a weight, a supplement or a gym set logged, so the
   supplement regime doesn't need logging dose by dose – "Supplements taken" is enough.
   Uses helpers from app.js (api, esc, todayStr, addDays…), admin.js (mineOn, typeOn, tnameOn), supps.js (SUPPS, sLoad, sDose) and photos.js (pThumb). */

let CL=null;                     /* {items, custom, updated} */
let dTicks={}, dAuto={supps:new Set(),gym:new Set()}, dGym=[], dPhotos=null, dPhotoN=0, dDate=todayStr(), dTok=0, dErr={};
/* the feeds as last read, kept while nothing has been written and the tab hasn't been away (WGEN, app.js) on the same day */
let dFeeds=null, dFeedKey='';

/* Is this day template a training one? "T" (what plan imports call training) or a name with "train" in it. */
const dIsTraining=(id,name)=>id==='T'||/train/i.test(name||'');
/* the day's template: as kept on the day, else its weekday's in the plan then in effect */
function dTplOn(date){const D=S.days[date],s=SUMS[date];return (D&&D.type)||(s&&s.type)||typeOn(date);}
function dShows(it,date){
  if(it.show==='all')return true;
  const v=mineOn(date), tpls=(v&&v.templates)||[], t=dTplOn(date);
  if(it.show==='training'){if(!tpls.length||!t)return true;return dIsTraining(t,tnameOn(date,t));}
  return it.show==='tpl:'+t;
}
const dItems=date=>(CL?CL.items:[]).filter(it=>dShows(it,date));
function dAutoDone(it,date){
  return it.auto==='weight'?WEIGHTS[date]!=null:it.auto==='supps'?dAuto.supps.has(date):it.auto==='gym'?dAuto.gym.has(date):false;
}
const dDone=(it,date)=>(dTicks[date]||[]).includes(it.id)||dAutoDone(it,date);

async function renderDash(args){
  if(view!=='dash')return;
  const tok=++dTok, box=$('#d-body'), t=todayStr(), [a]=args||[];
  dDate=isDate(a)&&a<=t&&a>=addDays(t,-6)?a:t;
  try{
    if(!CL){box.innerHTML='<p class="note">Loading…</p>';}
    const from=addDays(t,-6);
    /* each feed on its own: one that fails shows its own message, the rest of the page still loads */
    const one=p=>Promise.resolve(p).then(v=>({v}),e=>({e}));
    const key=`${WGEN}|${t}`;
    const feeds=dFeedKey===key&&dFeeds?dFeeds:await Promise.all([CL||api('GET','/api/checklist'),api('GET',`/api/checklist/days?from=${from}&to=${t}`),
      api('GET',`/api/supps/log?from=${from}&to=${t}`),api('GET','/api/gym/sessions?limit=60'),api('GET','/api/photos?latest=1&to='+t),SUPPS?null:sLoad()].map(one));
    if(tok!==dTok||view!=='dash')return;
    if(!feeds.some(r=>r.e)){dFeeds=feeds;dFeedKey=key;}
    const [cl,days,slog,gym,ph,sp]=feeds;
    const out=[cl,days,slog,gym,ph,sp].find(r=>r.e&&r.e.signedOut);if(out)throw out.e;
    const msg=r=>r.e?r.e.message||'Something went wrong':'';
    dErr={checklist:msg(cl)||msg(days),auto:[slog.e&&'supplements',gym.e&&'gym sets'].filter(Boolean).join(' and '),gym:msg(gym),photos:msg(ph),supps:msg(sp)};
    if(cl.v)CL=cl.v;dTicks=(days.v&&days.v.days)||{};
    for(const [d,q] of Object.entries(dQ))dTicks[d]=dApply(dTicks[d]||[],q.local);   /* ticks still on their way stay */
    dAuto.supps=new Set(((slog.v&&slog.v.entries)||[]).map(e=>e.date));
    dGym=gym.v||[];dAuto.gym=new Set(dGym.map(s=>s.date));
    dPhotos=ph.v?ph.v.photos||[]:null;dPhotoN=ph.v?ph.v.count||0:0;   /* only the newest of each pose, and how many in all */
    box.innerHTML=dPage();
  }catch(e){if(!e.signedOut&&tok===dTok)box.innerHTML=`<p class="note">Couldn’t load your dashboard: ${esc(e.message)}</p>`;}
}

function dPage(){
  const t=todayStr();
  return `<div class="dgrid">
    <section class="panel dcheck" aria-labelledby="d-ch">${dChecklist()}</section>
    ${dFood(t)}${dWeight(t)}${dGymCard(t)}${dSupps()}${dPhoto()}
  </div>`;
}

/* ---------- the checklist ---------- */
const dFailed=(what,m)=>`<p class="note" role="alert">Couldn’t load ${what}: ${esc(endStop(m))} Reload the page to try again.</p>`;
function dChecklist(){
  if(dErr.checklist)return `<div class="dhead"><h2 id="d-ch">Daily checklist</h2></div>${dFailed('your checklist',dErr.checklist)}`;
  const t=todayStr(), items=dItems(dDate), n=items.filter(it=>dDone(it,dDate)).length;
  const week=Array.from({length:7},(_,i)=>addDays(t,i-6)).map(d=>{
    const its=dItems(d), k=its.filter(it=>dDone(it,d)).length, all=its.length&&k===its.length;
    const lbl=parse(d).toLocaleDateString(undefined,{weekday:'short'});
    return `<a href="#dash/${d}" class="dday${all?' all':''}"${d===dDate?' aria-current="date"':''} aria-label="${esc(fmtLong(d))}: ${k} of ${its.length} done"><span>${esc(d===t?'Today':lbl)}</span><b>${k}/${its.length}</b></a>`;
  }).join('');
  const title=dDate===t?'Today':dDate===addDays(t,-1)?'Yesterday':parse(dDate).toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'short'});
  const tpl=dTplOn(dDate), tname=tpl?tnameOn(dDate,tpl):'';
  return `<div class="dhead"><h2 id="d-ch">Daily checklist – ${esc(title)}</h2><span class="chip${n===items.length&&n?' ok':''}">${n} of ${items.length} done</span>${tname?`<span class="sub">${esc(tname)} day</span>`:''}</div>
    <nav class="dweek" aria-label="Last 7 days">${week}</nav>
    ${items.length?`<ul class="dlist">${items.map(it=>{
      const auto=dAutoDone(it,dDate), done=auto||(dTicks[dDate]||[]).includes(it.id);
      return `<li><label class="dtick${done?' done':''}"><input type="checkbox" data-dk="${esc(it.id)}"${done?' checked':''}${auto?' disabled':''}> <span>${esc(it.label)}</span>${auto?`<span class="sub">${it.auto==='weight'?'weight logged':it.auto==='supps'?'logged':'sets logged'}</span>`:''}</label></li>`;}).join('')}</ul>`
      :'<p>Nothing on your checklist for this day. Set it up on <a href="#account">Account admin</a>.</p>'}
    ${dErr.auto?`<p class="sub">Your ${esc(dErr.auto)} couldn’t load, so their automatic ticks may be missing.</p>`:''}
    <p class="sub"><a href="#account">Change the checklist</a></p>`;
}
/* A tick shows at once. Per day one request is in flight; ticks made meanwhile wait in q.local (item -> wanted) and go when it
   returns, so a slow reply never undoes a later tick. srv is the day's ticks as the server last said. */
const dQ={};
const dApply=(list,local)=>{const s=new Set(list);for(const [k,v] of local){if(v)s.add(k);else s.delete(k);}return [...s];};
function dRedraw(date){
  if(view!=='dash'||date!==dDate)return;
  const c=$('#d-body .dcheck');if(!c)return;
  const f=document.activeElement&&c.contains(document.activeElement)?document.activeElement.dataset.dk:null;
  c.innerHTML=dChecklist();
  if(f!=null){const x=c.querySelector(`[data-dk="${CSS.escape(f)}"]`);if(x)x.focus();}   /* keyboard users stay on the box they ticked */
}
function dTick(el){dSet(dDate,el.dataset.dk,el.checked);}
function dSet(date,item,done){
  const q=dQ[date]||(dQ[date]={local:new Map(),srv:new Set(dTicks[date]||[]),busy:false});
  q.local.set(item,done);dTicks[date]=dApply(dTicks[date]||[],[[item,done]]);
  dRedraw(date);dSend(date);
}
async function dSend(date){
  const q=dQ[date];if(q.busy)return;q.busy=true;
  try{
    for(let e;(e=[...q.local].find(([k,v])=>q.srv.has(k)!==v));){
      const [item,done]=e, r=await api('PUT','/api/checklist/days/'+date,{item,done});
      q.srv=new Set(r.done);if(q.local.get(item)===done)q.local.delete(item);
    }
    delete dQ[date];dTicks[date]=[...q.srv];dRedraw(date);
  }catch(e){
    const lost=[...q.local];delete dQ[date];dTicks[date]=[...q.srv];dRedraw(date);
    if(e.signedOut)return;
    const [item]=lost[lost.length-1]||[];
    noteBy(view==='dash'&&date===dDate?$(`#d-body [data-dk="${CSS.escape(item||'')}"]`):null,
      `Couldn’t save ${lost.length===1?'that tick':'those ticks'}: ${endStop(e.message)}`,()=>lost.forEach(([k,v])=>dSet(date,k,v)));
  }
}

/* ---------- the module cards ---------- */
const dCard=(href,title,body,cls)=>`<a class="panel dcard${cls?' '+cls:''}" href="${href}"><h2>${esc(title)} <i class="gch">›</i></h2>${body}</a>`;
function dFood(t){
  const s=SUMS[t], tpl=dTplOn(t), tg=(s&&s.targets&&s.targets.k)?s.targets:(tpl&&COACH[tpl])||null;
  if(!s&&!TEMPLATES.length)return dCard('#day','Food today','<p>No meal plan yet – set one up on Account admin, or log food on the Daily Tracker.</p>');
  const row=(k,l,u)=>{const v=s?Math.round(s[k]):0, g=tg?Math.round(tg[k]):0;
    return `<div class="dmac"><span>${l}</span><b>${v}${u}</b>${g?`<span class="sub">of ${g}${u}</span><progress class="dbar${v>g*1.05?' over':''}" max="${g}" value="${Math.min(v,g)}" aria-label="${l}: ${v} of ${g}${u}"></progress>`:''}</div>`;};
  return dCard('#day','Food today',(s?'':'<p>Nothing saved for today yet.</p>')+`<div class="dmacs">${row('k','Calories',' kcal')}${row('p','Protein','g')}${row('c','Carbs','g')}${row('f','Fat','g')}</div>`);
}
function dWeight(t){
  const ds=Object.keys(WEIGHTS).filter(d=>d<=t).sort();
  if(!ds.length)return dCard('#day','Weight','<p>No weigh-ins yet – add today’s on the Daily Tracker.</p>');
  const last=ds[ds.length-1], kg=WEIGHTS[last];
  const ref=ds.filter(d=>d<=addDays(last,-7)).pop();
  const ch=ref?Math.round((kg-WEIGHTS[ref])*10)/10:null;
  return dCard('#history/timeline','Weight',`<div class="dbig"><b>${kg}</b> kg</div>
    <p>${last===t?'Weighed in today':'Last weigh-in '+esc(fmtLong(last))}${ch!=null?` · <b>${ch>0?'+':''}${ch} kg</b> on a week before`:''}</p>`);
}
function dGymCard(t){
  if(dErr.gym)return dCard('#gym','Gym',dFailed('your gym sessions',dErr.gym));
  if(!dGym.length)return dCard('#gym','Gym','<p>No sets logged yet.</p>');
  const last=dGym.reduce((a,b)=>b.date>a.date?b:a), wk=dGym.filter(s=>s.date>addDays(t,-7)).length;
  return dCard('#gym','Gym',`<div class="dbig"><b>${wk}</b> session${wk===1?'':'s'} in the last 7 days</div>
    <p>Last: ${last.date===t?'today':esc(fmtLong(last.date))} – ${last.sets} set${last.sets===1?'':'s'}${last.volume?`, ${Math.round(last.volume).toLocaleString()} kg volume`:''}</p>`);
}
function dSupps(){
  if(dErr.supps&&!SUPPS)return dCard('#supps/lib','Supplement regime',dFailed('your supplements',dErr.supps));
  const mine=(SUPPS||[]).filter(s=>s.mine);
  if(!mine.length)return dCard('#supps/lib','Supplement regime','<p>No supplements yet – add them in the library, or read your regime from a PDF with AI.</p>');
  const show=mine.slice(0,8);
  return dCard('#supps/lib','Supplement regime',`<ul class="dsupps">${show.map(s=>`<li><span>${esc(s.name)}</span>${s.amount!=null?`<b>${esc(sDose(s.amount,s.unit))}</b>`:''}</li>`).join('')}</ul>
    ${mine.length>show.length?`<p>…and ${mine.length-show.length} more</p>`:''}<p>Tick “Supplements taken” on the checklist – no need to log each one.</p>`);
}
function dPhoto(){
  if(dErr.photos)return dCard('#photos','Progress photos',dFailed('your photos',dErr.photos));
  if(!dPhotos||!dPhotos.length)return dCard('#photos','Progress photos','<p>No progress photos yet.</p>');
  const t=todayStr(), past=dPhotos.filter(x=>x.date<=t), p=(past.length?past:dPhotos).reduce((a,b)=>b.date>a.date||(b.date===a.date&&b.id>a.id)?b:a);   /* not one dated ahead */
  return dCard('#photos','Progress photos',`<div class="dphoto"><img src="${pThumb(p)}" alt="Latest progress photo, ${esc(p.pose)}" loading="lazy"><p>Latest: ${esc(fmtLong(p.date))}<br>${dPhotoN} photo${dPhotoN===1?'':'s'} in all</p></div>`);
}

document.addEventListener('change',e=>{if(view==='dash'&&e.target.dataset.dk!=null)dTick(e.target);});
