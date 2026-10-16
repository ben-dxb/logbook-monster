'use strict';
/* Timeline view: pick any day and a card pops up with everything from it – what you ate, your weight, the latest
   photos at the time, your supplement regime and gym sets – and a trend chart of macros, weight, strength
   (Epley estimated one-rep max), volume and the supplements you follow ("Trend" in the supplements module),
   each metric switched on and off, with an AI read of how they relate.
   The Timeline tab of History: #history/timeline, #history/timeline/2026-10-15 (that day's card). The numbers come from /api/timeline (server/timeline.js).
   Uses helpers from app.js, gym.js (gEmpty) and photos.js (pThumb, pPoseName). */

const T_KEY='logbook-monster-timeline';
let TL=null, tTok=0, tAi=null, tAiErr='', tAiBusy=false, tCardDate=null, tCardTok=0;
let tRange=90, tSmooth=true, tOn=new Set(['k','p','kg','str']);
try{const st=JSON.parse(localStorage.getItem(T_KEY)||'null');
  if(st){if([30,90,365,0].includes(st.range))tRange=st.range;if(typeof st.smooth==='boolean')tSmooth=st.smooth;if(Array.isArray(st.on))tOn=new Set(st.on.filter(k=>typeof k==='string'));}}catch{}
function tKeep(){try{localStorage.setItem(T_KEY,JSON.stringify({range:tRange,smooth:tSmooth,on:[...tOn]}));}catch{}}

/* a fixed colour for the built-in metrics; exercises and supplements take the rest in turn */
const T_COL={k:0,p:1,c:2,f:3,kg:4,str:5,vol:6};
function tColours(){let n=7;const m={};(TL?TL.series:[]).forEach(s=>{m[s.key]=T_COL[s.key]!=null?T_COL[s.key]:(n++%12);});return m;}
const tNum=(v,u)=>{const a=Math.abs(v);const t=a>=1000?Math.round(v).toLocaleString():a>=100?String(Math.round(v)):String(Math.round(v*10)/10);return u==='%'?t+'%':u?`${t} ${u}`:t;};
const tAgo=n=>n===0?'that day':n===1?'the day before':`${n} days before`;
const tFrom=()=>tRange?addDays(TL?TL.to:todayStr(),-tRange+1):null;

async function renderTimeline(args){
  if(view!=='timeline')return;
  const [d]=args||[], box=$('#t-body');
  if(!box.dataset.ready){box.innerHTML=tPage();box.dataset.ready='1';}
  if(!isDate(d||''))tCloseCard(true);
  if(!TL||!isDate(d||''))await tLoad();
  if(view==='timeline'&&isDate(d||''))tOpen(d);
}
async function tLoad(){
  const tok=++tTok;
  $('#t-chart').innerHTML='<p class="emptyc">Loading…</p>';
  try{
    const from=tRange?addDays(todayStr(),-tRange+1):'';
    const r=await api('GET',`/api/timeline/trends?to=${todayStr()}${from?'&from='+from:''}`);
    if(tok!==tTok||view!=='timeline')return;
    TL=r;renderTrends();
  }catch(e){if(!e.signedOut&&tok===tTok)$('#t-chart').innerHTML=`<p class="emptyc">Couldn’t load your trends: ${esc(e.message)}</p>`;}
}

function tPage(){
  const rng=[[30,'30 days'],[90,'90 days'],[365,'1 year'],[0,'All']].map(([r,l])=>`<button type="button" data-ta="range" data-r="${r}" aria-pressed="${r===tRange}">${l}</button>`).join('');
  return `<div class="gbar"><h2>Timeline</h2></div>
    <p class="fintro">Pick any day to see everything from it – what you ate, your weight, your latest photos at the time, your supplements and your gym sets. Tap a point on the chart to open that day.</p>
    <form id="t-pick" class="panel tpick">
      <label class="f"><span class="lbl">Go to a day</span><input type="date" id="t-date" value="${todayStr()}" max="${addDays(todayStr(),366)}"></label>
      <button class="btn" type="submit">Show that day</button>
      <button class="ghost" type="button" data-ta="go" data-d="${todayStr()}">Today</button>
      <button class="ghost" type="button" data-ta="go" data-d="${addDays(todayStr(),-1)}">Yesterday</button>
      <button class="ghost" type="button" data-ta="go" data-d="${addDays(todayStr(),-7)}">A week ago</button>
    </form>
    <section class="panel" aria-labelledby="t-th">
      <div class="charthead"><h2 id="t-th">Trends</h2><div class="seg" role="group" aria-label="Range" id="t-range">${rng}</div></div>
      <div id="t-metrics" class="tmetrics"></div>
      <div class="ttools"><label class="tog"><input type="checkbox" id="t-smooth"${tSmooth?' checked':''}> 7-day average</label><span class="sub" id="t-scale"></span></div>
      <div id="t-chart" class="chart tchart"></div>
    </section>
    <section class="panel" aria-labelledby="t-aih">
      <div class="charthead"><h2 id="t-aih">AI summary</h2><button class="btn" type="button" data-ta="ai" id="t-aibtn">Summarise the metrics shown</button></div>
      <div id="t-ai"></div>
    </section>`;
}

/* ---------- metrics and chart ---------- */
function renderTrends(){
  if(!TL||!$('#t-metrics'))return;
  const col=tColours(), groups=[];
  TL.series.forEach(s=>{let g=groups.find(x=>x.name===s.group);if(!g)groups.push(g={name:s.group,list:[]});g.list.push(s);});
  if(!groups.some(g=>g.name==='Supplements'))groups.push({name:'Supplements',list:[]});
  $('#t-metrics').innerHTML=groups.map(g=>`<div class="tgroup"><span class="lbl">${esc(g.name)}</span><div class="tchips">${g.list.map(s=>{
      const on=tOn.has(s.key), none=!s.points.length;
      return `<button type="button" class="tm tc${col[s.key]}${none?' none':''}" data-ta="metric" data-k="${esc(s.key)}" aria-pressed="${on}" title="${none?'No data in this range':esc(s.name)}"><i class="tsw tc${col[s.key]}"></i>${esc(s.name)}</button>`;}).join('')
    ||(g.name==='Supplements'?'<span class="sub">Tick “Trend” on a supplement in the <a href="#supps/lib">supplement library</a> to follow it here.</span>':'')}</div></div>`).join('');
  $('#t-aibtn').disabled=!TL.ai||tAiBusy;
  renderAi();
  drawTrends();
}
/* 7-day trailing average; for supplements a missing day counts as none */
function tSmoothed(s,from,to){
  if(s.zero){
    const m=new Map(s.points);const out=[];let start=s.points.length?s.points[0][0]:to;if(from&&start<from)start=from;
    for(let d=start;d<=to;d=addDays(d,1)){let t=0;for(let i=0;i<7;i++)t+=m.get(addDays(d,-i))||0;out.push([d,t/7]);}
    return out;
  }
  return s.points.map(([d],i)=>{const a=addDays(d,-6);let t=0,n=0;for(let j=i;j>=0&&s.points[j][0]>=a;j--){t+=s.points[j][1];n++;}return [d,t/n];});
}
function tRaw(s,from,to){
  if(!s.zero)return s.points;
  const m=new Map(s.points);const out=[];let start=s.points.length?s.points[0][0]:to;if(from&&start<from)start=from;
  for(let d=start;d<=to;d=addDays(d,1))out.push([d,m.get(d)||0]);
  return out;
}
function tVisible(){
  const from=tFrom(), to=TL.to;
  return TL.series.filter(s=>tOn.has(s.key)&&s.points.length).map(s=>{
    const pts=(tSmooth?tSmoothed(s,from,to):tRaw(s,from,to)).filter(p=>!from||p[0]>=from);
    return {...s,pts};
  }).filter(s=>s.pts.length);
}
function drawTrends(){
  const box=$('#t-chart');if(!box||!TL)return;
  const col=tColours(), vis=tVisible();
  $('#t-scale').textContent=vis.length>1?'Each line has its own scale – hover or tap for the values.':'';
  if(!vis.length){box.innerHTML=`<p class="emptyc">${tOn.size?'No data for the metrics you picked in this range.':'Pick a metric above to chart it.'}</p>`;return;}
  const W=Math.max(300,box.clientWidth||600), H=Math.round(Math.min(340,Math.max(230,W*0.45)));
  const one=vis.length===1, m={l:one?46:12,r:12,t:14,b:26};
  let x0=tFrom()||vis.reduce((a,s)=>s.pts[0][0]<a?s.pts[0][0]:a,TL.to);
  const t0=parse(x0).getTime(), t1=Math.max(t0+86400000,parse(TL.to).getTime());
  const x=d=>m.l+(parse(d).getTime()-t0)/(t1-t0)*(W-m.l-m.r);
  const ph=H-m.t-m.b;
  /* each series on its own scale, with a little room above and below */
  vis.forEach(s=>{const v=s.pts.map(p=>p[1]);let lo=Math.min(...v),hi=Math.max(...v);
    if(one){const pad=Math.max((hi-lo)*0.12,Math.abs(hi)*0.02,0.5);lo-=pad;hi+=pad;}
    else if(hi===lo){lo-=1;hi+=1;}else{const pad=(hi-lo)*0.08;lo-=pad;hi+=pad;}
    s.lo=lo;s.hi=hi;s.y=val=>m.t+(hi-val)/(hi-lo)*ph;});
  let g='<g class="grid">';
  for(let i=0;i<=4;i++){const yy=m.t+ph*i/4;g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${yy}" y2="${yy}"/>`;}
  g+='</g><g class="axis">';
  if(one){const s=vis[0];for(let i=0;i<=4;i++){const v=s.hi-(s.hi-s.lo)*i/4;g+=`<text x="${m.l-6}" y="${m.t+ph*i/4+4}" text-anchor="end">${esc(tNum(v,''))}</text>`;}}
  const mid=ymd(new Date((t0+t1)/2));
  [[x0,'start'],[mid,'middle'],[TL.to,'end']].forEach(([d,a])=>{g+=`<text x="${x(d)}" y="${H-6}" text-anchor="${a}">${esc(fmtShort(d))}</text>`;});
  g+='</g>';
  const lines=vis.map(s=>{const c='tc'+col[s.key];
    const path=s.pts.length>1?`<path class="tl ${c}" d="${s.pts.map((p,i)=>(i?'L':'M')+x(p[0]).toFixed(1)+' '+s.y(p[1]).toFixed(1)).join('')}"/>`:'';
    const dots=!tSmooth&&!s.zero&&s.pts.length<=120||s.pts.length===1?s.pts.map(p=>`<circle class="td ${c}" cx="${x(p[0]).toFixed(1)}" cy="${s.y(p[1]).toFixed(1)}" r="2.5"/>`).join(''):'';
    return path+dots;}).join('');
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(vis.map(s=>s.name).join(', '))} from ${esc(fmtShort(x0))} to ${esc(fmtShort(TL.to))}">${g}${lines}
    <line class="cross" id="t-cx" y1="${m.t}" y2="${H-m.b}" visibility="hidden"/>
    <rect id="t-hit" x="${m.l}" y="0" width="${W-m.l-m.r}" height="${H}" fill="transparent"/></svg><div class="tip ttip" id="t-tip" hidden></div>`;
  const svg=box.querySelector('svg'), tip=$('#t-tip'), cx=$('#t-cx');
  const dates=[...new Set(vis.flatMap(s=>s.pts.map(p=>p[0])))].sort();
  const at=new Map(vis.map(s=>[s.key,new Map(s.pts)]));
  /* the value on that day, or the latest in the 7 days before it (weigh-ins aren't daily) */
  const valAt=(s,d)=>{const m=at.get(s.key);for(let i=0;i<7;i++){const k=addDays(d,-i);if(m.has(k))return [m.get(k),k];}return null;};
  let cur=null;
  const pick=e=>{const r=svg.getBoundingClientRect(), px=(e.clientX-r.left)*W/r.width;
    let best=dates[0];for(const d of dates)if(Math.abs(x(d)-px)<Math.abs(x(best)-px))best=d;return {d:best,r};};
  const move=e=>{const {d,r}=pick(e);cur=d;const X=x(d);
    cx.setAttribute('x1',X);cx.setAttribute('x2',X);cx.setAttribute('visibility','visible');
    tip.hidden=false;
    tip.innerHTML=`<b>${esc(parse(d).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'}))}</b>`+vis.map(s=>{const v=valAt(s,d);
      return `<span><i class="tsw tc${col[s.key]}"></i>${esc(s.name)}: ${v==null?'–':esc(tNum(v[0],s.unit))+(v[1]!==d?` <small>(${esc(fmtShort(v[1]))})</small>`:'')}</span>`;}).join('')+'<small>Tap to open this day</small>';
    const w=tip.offsetWidth||180;tip.style.left=Math.min(Math.max(X*r.width/W,w/2),r.width-w/2)+'px';};
  const leave=()=>{tip.hidden=true;cx.setAttribute('visibility','hidden');};
  const hit=$('#t-hit');
  hit.addEventListener('pointermove',move);hit.addEventListener('pointerleave',leave);
  hit.addEventListener('click',e=>{move(e);if(cur)go('history/timeline/'+cur);});
}

/* ---------- AI summary ---------- */
function renderAi(){
  const el=$('#t-ai');if(!el||!TL)return;
  if(!TL.ai){el.innerHTML='<p class="sub">AI isn’t set up – the super admin can add an OpenRouter API key on the Super admin page.</p>';return;}
  if(tAiBusy){el.innerHTML='<p class="note">Reading your numbers…</p>';return;}
  if(tAiErr){el.innerHTML=`<p class="aderr" role="alert">${esc(tAiErr)}</p>`;return;}
  if(!tAi){el.innerHTML='<p class="sub">Switch on the metrics you want compared above, then ask for a summary of how they relate – for example calories against weight, or protein and volume against strength.</p>';return;}
  el.innerHTML=`<p class="sub">${esc(tAi.about)}</p>${tAi.headline?`<p class="tahead">${esc(tAi.headline)}</p>`:''}
    <ul class="tains">${tAi.insights.map(i=>`<li>${i.title?`<b>${esc(i.title)}</b> `:''}${esc(i.text)}</li>`).join('')}</ul>
    ${tAi.caveats.length?`<details class="adhelp"><summary>What the data can’t show</summary><ul>${tAi.caveats.map(c=>`<li>${esc(c)}</li>`).join('')}</ul></details>`:''}
    <p class="sub">AI estimate (${esc(tAi.model||'AI')}) – not medical advice.</p>`;
}
async function tSummarise(){
  if(!TL||tAiBusy)return;
  const vis=tVisible();
  if(!vis.length){tAi=null;tAiErr='Switch on at least one metric with data first.';renderAi();return;}
  tAiBusy=true;tAiErr='';$('#t-aibtn').disabled=true;renderAi();
  const about=`${vis.map(s=>s.name).join(', ')} · ${tRange?`last ${tRange} days`:'all time'}`;
  try{
    const r=await api('POST','/api/timeline/summary',{from:tFrom()||'',to:TL.to,metrics:vis.map(s=>s.key)});
    tAi={...r,about};
  }catch(e){if(e.signedOut)return;tAi=null;tAiErr=e.message;}
  tAiBusy=false;const b=$('#t-aibtn');if(b)b.disabled=!TL.ai;renderAi();
}

/* ---------- the day card ---------- */
function tOpen(d){
  const dlg=$('#t-card');tCardDate=d;const tok=++tCardTok;
  $('#t-cbody').innerHTML=tCardHead(d)+'<p class="note">Loading…</p>';
  if(!dlg.open)dlg.showModal();
  api('GET','/api/timeline/day/'+d).then(r=>{if(tok===tCardTok&&dlg.open)$('#t-cbody').innerHTML=tCardHead(d,r)+tCardBody(r);},
    e=>{if(tok===tCardTok&&!e.signedOut)$('#t-cbody').innerHTML=tCardHead(d)+gEmpty('Couldn’t load that day: '+esc(e.message));});
}
function tCloseCard(quiet){const dlg=$('#t-card');tCardDate=null;tCardTok++;if(dlg&&dlg.open){if(quiet)dlg.dataset.quiet='1';dlg.close();}}
function tCardHead(d,r){
  const s=r&&r.food&&r.food.summary, type=(s&&s.type)||typeOn(d);
  const t=todayStr(), rel=d===t?'Today':d===addDays(t,-1)?'Yesterday':'';
  return `<header class="tchead"><button class="nav" type="button" data-ta="cmove" data-n="-1" aria-label="Previous day">‹</button>
    <div class="dt"><h2 id="t-ctitle">${esc(fmtLong(d))}</h2><span class="sub">${rel?esc(rel)+' · ':''}${esc(TYPE_NAME[type]||'')}</span></div>
    <button class="nav" type="button" data-ta="cmove" data-n="1" aria-label="Next day">›</button>
    <button class="x tclose" type="button" data-ta="close" aria-label="Close">×</button></header>`;
}
const tFoodName=(D,f)=>(FOODS[f]&&FOODS[f].n)||(D.lib&&D.lib[f]&&D.lib[f].n)||f;
const tFoodUnit=(D,f)=>(FOODS[f]&&FOODS[f].unit)||(D.lib&&D.lib[f]&&D.lib[f].unit)||'g';
function tCardBody(r){
  const d=r.date, sec=(cls,title,body,link)=>`<section class="tcsec ${cls}"><h3 class="lbl">${title}</h3>${body}${link?`<a class="ghost tclink" href="${link[0]}">${link[1]}</a>`:''}</section>`;
  /* food */
  let food;
  if(r.food){
    const s=r.food.summary, D=r.food.data, tg=s.targets||{};
    const stat=(k,l,u)=>`<div class="stat"><span class="lbl">${l}</span><span class="num">${r0(s[k])}${tg[k]?`<i>/ ${r0(tg[k])}${u}</i>`:`<i>${u}</i>`}</span></div>`;
    const meals=(D.meals||[]).map(m=>{const items=['p','c','x'].flatMap(b=>m[b]||[]).filter(i=>i.g>0);
      return `<li><b>Meal ${esc(m.id)} · ${esc(m.name)}</b>${m.eaten?' <span class="chip ok">✓ Eaten</span>':''}<small>${items.map(i=>`${esc(tFoodName(D,i.f))} ${r0(i.g)}${esc(tFoodUnit(D,i.f))}`).join(' · ')||'Nothing in it'}</small></li>`;}).join('');
    const off=(D.off||[]).map(o=>`<li><b>${esc(o.n||'Off-plan food')}</b><small>${r0(+o.k||0)} kcal · P ${r1(+o.p||0)} · C ${r1(+o.c||0)} · F ${r1(+o.f||0)}</small></li>`).join('');
    food=`<div class="tcstats">${stat('k','Calories','')}${stat('p','Protein','g')}${stat('c','Carbs','g')}${stat('f','Fat','g')}</div>
      <ul class="tclist">${meals}</ul>${off?`<span class="lbl">Off plan</span><ul class="tclist">${off}</ul>`:''}`;
  }else food=gEmpty('Nothing saved in the Food Tracker for this day.');
  /* weight */
  const w=r.weight;
  const weight=w?`<p class="tbig">${w.kg.toFixed(1)}<i>kg</i></p><p class="sub">${w.ago?`Last weigh-in, ${esc(fmtShort(w.date))} (${tAgo(w.ago)})`:'Weighed in that day'}${w.avg7!=null&&!w.ago?` · 7-day average ${w.avg7.toFixed(1)} kg`:''}</p>`
    :gEmpty('No weigh-ins up to this day.');
  /* photos: the latest of each pose up to this day */
  const photos=r.photos.length?`<div class="tcphotos">${r.photos.map(p=>`<a class="ptile" href="#photos/${p.id}"><img src="${pThumb(p)}" alt="${esc(pPoseName(p.pose)+' photo, '+fmtLong(p.date))}" loading="lazy" decoding="async"><span>${esc(pPoseName(p.pose))} · ${esc(p.ago?fmtShort(p.date):'that day')}</span></a>`).join('')}</div>`
    :gEmpty('No progress photos up to this day.');
  /* supplements */
  const sp=r.supps;
  const supps=(sp.taken.length?`<ul class="tclist">${sp.taken.map(e=>`<li><b>${esc(e.name)}</b> <span>${esc(sDose(e.amount,e.unit))}</span>${e.note?`<small>${esc(e.note)}</small>`:''}</li>`).join('')}</ul>`:gEmpty('Nothing logged that day.'))
    +(sp.regime.length?`<span class="lbl">Regime – the 14 days to this one</span><ul class="tclist">${sp.regime.map(x=>`<li><b>${esc(x.name)}</b> <span class="sub">${x.days} of 14 days · usually ${esc(x.usual)}</span></li>`).join('')}</ul>`:'');
  /* gym */
  const g=r.gym;
  const gym=g.exercises.length?`<p class="sub">${g.sets} set${g.sets===1?'':'s'} · ${g.volume.toLocaleString()} kg volume</p><ul class="tclist">${g.exercises.map(x=>`<li><b>${esc(x.name)}</b>${x.best?` <span class="chip info">e1RM ${tNum(x.best,'kg')}</span>`:''}<small>${x.sets.map(s=>`${s.reps}×${s.kg}kg`).join(' · ')}</small></li>`).join('')}</ul>`
    :gEmpty(g.last?`No gym sets that day. Last session: ${esc(fmtShort(g.last))}.`:'No gym sets up to this day.');
  return `<div class="tcgrid">${sec('tcfood','Food',food,[`#day/${d}`,'Open in Food Tracker'])}
    ${sec('','Weight',weight,['#weight','Weight'])}
    ${sec('','Supplements',supps,[`#supps/${d}`,'Open supplements'])}
    ${sec('','Gym',gym,g.exercises.length?[`#gym/d/${d}`,'Open session']:g.last?[`#gym/d/${g.last}`,'Last session']:null)}
    ${sec('tcwide','Photos',photos,['#photos','All photos'])}</div>`;
}

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-ta]');if(!b||view!=='timeline')return;
  const a=b.dataset.ta;
  if(a==='range'){tRange=+b.dataset.r;tKeep();document.querySelectorAll('[data-ta=range]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));tLoad();}
  else if(a==='metric'){const k=b.dataset.k;if(tOn.has(k))tOn.delete(k);else tOn.add(k);tKeep();b.setAttribute('aria-pressed',String(tOn.has(k)));drawTrends();}
  else if(a==='ai')tSummarise();
  else if(a==='go')go('history/timeline/'+b.dataset.d);
  else if(a==='close')tCloseCard();
  else if(a==='cmove'&&tCardDate){const d=addDays(tCardDate,+b.dataset.n);history.replaceState(null,'','#history/timeline/'+d);tOpen(d);}
});
document.addEventListener('change',e=>{
  if(view!=='timeline')return;
  if(e.target.id==='t-smooth'){tSmooth=e.target.checked;tKeep();drawTrends();}
});
document.addEventListener('submit',e=>{
  if(e.target.id!=='t-pick')return;e.preventDefault();
  const d=$('#t-date').value;if(isDate(d))go('history/timeline/'+d);
});
/* closing the card (×, Esc, a tap outside it) goes back to #history/timeline without a new history entry */
$('#t-card').addEventListener('close',()=>{const dlg=$('#t-card');const quiet=dlg.dataset.quiet;delete dlg.dataset.quiet;tCardDate=null;
  if(!quiet&&/^#history\/timeline\//.test(location.hash))history.replaceState(null,'','#history/timeline');});
$('#t-card').addEventListener('click',e=>{if(e.target===e.currentTarget)tCloseCard();});
window.addEventListener('hashchange',()=>{if(view!=='timeline')tCloseCard(true);});
let tRz;window.addEventListener('resize',()=>{clearTimeout(tRz);tRz=setTimeout(()=>{if(view==='timeline')drawTrends();},150);});
