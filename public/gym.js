'use strict';
/* Gym view: workouts (lists of exercises with a target), the exercise library and the sets you log.
   #gym, #gym/w/3, #gym/w/3/edit, #gym/new, #gym/e/5 (an exercise's sets), #gym/s/9 (edit a set),
   #gym/sessions, #gym/d/2026-10-15, #gym/x (all exercises). Uses helpers from app.js. */

let GY=null;                     /* {exercises:[{id,name,notes,parts,sets,last}], workouts:[{id,name,description,items}], parts:[{id,name}], ai} */
const GSETS={};                  /* exercise id -> its sets, oldest first */
const GDAY={};                   /* date -> sets that day */
let gSessions=null, gArgs=[], gTok=0, gTimer=null, gBackE='#gym';
let gCsv=null;                    /* a history CSV being checked: {file, text, res, dateOrder, unit, busy, done, total} */
let gDraft=null, gAi=null, gMsg='', gReorder=false, gTab='sets', gShow=30, gQuick=null;
let gPick={q:'',part:''}, gTagBusy='', gTagMsg='', gExOpen=false;   /* the exercise picker's search and body-part filter; AI tagging */

/* ---------- helpers ---------- */
const exById=id=>GY&&GY.exercises.find(e=>e.id===id);
const exName=id=>{const e=exById(id);return e?e.name:'Deleted exercise';};
const nowAt=()=>{const d=new Date();return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;};
const atMs=a=>{const [d,t]=a.split('T');const [h,m,s]=t.split(':').map(Number);const x=parse(d);x.setHours(h,m,s||0);return x.getTime();};
/* Epley, as the Timeline counts it: a set with no weight or over 20 reps says little about a one-rep max, so it gives none (0) */
const e1rm=s=>s.kg>0&&s.reps>=1&&s.reps<=20?(s.reps===1?s.kg:s.kg*(1+s.reps/30)):0;
const kgTxt=k=>String(Math.round(k*100)/100);
const fmtDur=ms=>{const s=Math.max(0,Math.round(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?`${h}:${pad(m)}:${pad(s%60)}`:`${m}:${pad(s%60)}`;};
function ago(d){if(!d)return '';const n=Math.round((parse(todayStr())-parse(d))/86400000);
  return n===0?'Today':n===1?'Yesterday':n>1&&n<7?`${n} days ago`:fmtShort(d);}
function dayLabel(d){const t=todayStr();if(d===t)return 'Today';if(d===addDays(t,-1))return 'Yesterday';
  return parse(d).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',...(d.slice(0,4)!==t.slice(0,4)?{year:'numeric'}:{})});}
const gEmpty=t=>`<p class="empty">${esc(t)}</p>`;   /* plain text */
/* ---------- body parts: chips, the filter bar, AI tagging ---------- */
const partName=id=>{const p=(GY.parts||[]).find(x=>x.id===id);return p?p.name:id;};
const gPartChips=ids=>ids.length?`<span class="gpts">${ids.map(id=>`<span class="chip gpart">${esc(partName(id))}</span>`).join('')}</span>`:'';
const gHasPart=(e,p)=>!p||(p==='none'?!e.parts.length:e.parts.includes(p));
/* with a part picked, exercises that train it most (listed first) come first */
const gByPart=list=>!gPick.part||gPick.part==='none'?list:list.slice().sort((a,b)=>a.parts.indexOf(gPick.part)-b.parts.indexOf(gPick.part));
function gPartBar(){
  const used=new Set(GY.exercises.flatMap(e=>e.parts));
  if(!used.size)return '';
  const n=p=>GY.exercises.filter(e=>gHasPart(e,p)).length;
  const opts=[['','All'],...GY.parts.filter(p=>used.has(p.id)).map(p=>[p.id,p.name]),...(n('none')?[['none','Not tagged']]:[])];
  return `<div class="seg gparts" role="group" aria-label="Body part">${opts.map(([id,name])=>`<button type="button" data-g="part" data-p="${id}" aria-pressed="${gPick.part===id}">${esc(name)} <small>${n(id)}</small></button>`).join('')}</div>`;
}
function gTagRow(){
  const n=GY.exercises.filter(e=>!e.parts.length).length;
  return `${n&&GY.ai?`<button type="button" class="ghost gtag" data-g="aitag"${gTagBusy?' disabled':''}>✦ ${gTagBusy?`Tagging body parts with AI ${esc(gTagBusy)}`:`Tag ${n} exercise${n===1?'':'s'} with body parts using AI`}</button>`:''}
    <p id="g-tagmsg" class="sub" role="status">${esc(gTagMsg)}</p>`;
}
async function gTagAi(ids){
  if(gTagBusy||!ids.length)return;
  let tagged=0;gTagMsg='';
  try{
    for(let i=0;i<ids.length;i+=40){
      gTagBusy=ids.length>40?`${i} of ${ids.length}`:'…';renderGym();
      const r=await api('POST','/api/gym/exercises/ai-parts',{ids:ids.slice(i,i+40)});
      GY.exercises=r.exercises;tagged+=r.tagged;
    }
    gTagMsg=ids.length===1?(tagged?'Tagged by AI – change the ticks if it got something wrong.':'The AI couldn’t tell – tick the body parts yourself.')
      :`Tagged ${tagged} of ${ids.length} exercises.${tagged<ids.length?' The AI couldn’t tell for the rest – set them in each exercise’s settings.':''}`;
  }catch(e){if(e.signedOut)return;gTagMsg='AI tagging stopped: '+e.message;}
  gTagBusy='';renderGym();
}
function gHead(back,title,extra){return `<div class="gbar"><a class="nav" href="${esc(back)}" aria-label="Back">‹</a><h2>${esc(title)}</h2>${extra||''}</div>`;}

async function gLoad(){const ai=GY?GY.ai:false;GY=await api('GET','/api/gym');if(GY.ai==null)GY.ai=ai;}
async function gSetsOf(id){if(!GSETS[id])GSETS[id]=(await api('GET','/api/gym/sets?exercise='+id))||[];return GSETS[id];}
async function gSetsOn(d){if(!GDAY[d])GDAY[d]=(await api('GET','/api/gym/sets?date='+d))||[];return GDAY[d];}
/* after a set changes: counts on the list pages and the per-day caches are out of date */
function gChanged(){gSessions=null;Object.keys(GDAY).forEach(k=>delete GDAY[k]);}

/* Per exercise: sets by day, which sets beat the best estimated 1RM so far, which days beat the best volume. */
function gAnalyse(sets){
  const days=new Map(), pr=new Set(), volPr=new Set();let best=-1,bestVol=-1;
  sets.forEach(s=>{const d=s.at.slice(0,10);if(!days.has(d))days.set(d,[]);days.get(d).push(s);
    const v=e1rm(s);if(v>0){if(best>=0&&v>best+1e-9)pr.add(s.id);best=Math.max(best,v);}});
  for(const [d,ss] of days){const v=ss.reduce((a,s)=>a+s.reps*s.kg,0);if(bestVol>=0&&v>bestVol+1e-9)volPr.add(d);bestVol=Math.max(bestVol,v);}
  return {days,pr,volPr};
}

/* ---------- routing ---------- */
async function renderGym(args){
  if(args){gArgs=args;if(!gTagBusy)gTagMsg='';}
  if(view!=='gym')return;
  const tok=++gTok, box=$('#g-body'), [p,a,b]=gArgs;
  clearInterval(gTimer);gTimer=null;
  document.querySelectorAll('#g-tabs a').forEach(x=>{const on=x.dataset.g===(p==='sessions'||p==='d'?'sessions':p==='x'?'x':'');
    if(on)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current');});
  if(p!=='e'&&p!=='s')gBackE='#'+['gym',...gArgs].join('/');
  if(p!=='e'){gQuick=null;gExOpen=false;}
  if(p!=='new'&&!(p==='w'&&b==='edit'))gDraft=null;
  try{
    if(!GY){box.innerHTML='<p class="note">Loading…</p>';await gLoad();}
    let html;
    if(p==='new'||(p==='w'&&b==='edit'))html=gEditPage(p==='new'?null:+a);
    else if(p==='w')html=await gWorkoutPage(+a);
    else if(p==='e')html=await gExercisePage(+a);
    else if(p==='s')html=await gSetPage(+a);
    else if(p==='sessions'){if(!gSessions)gSessions=await api('GET','/api/gym/sessions');html=gSessionsPage();}
    else if(p==='d')html=await gDayPage(a);
    else if(p==='x')html=gExercisesPage();
    else html=gHomePage();
    if(tok!==gTok)return;                    /* you moved on while this loaded */
    box.innerHTML=html;
    if(p==='e')gAfterExercise(+a);
  }catch(e){if(tok===gTok&&!e.signedOut)box.innerHTML=`<p class="note">Couldn’t load this: ${esc(e.message)}</p>`;}
}

/* ---------- workouts list ---------- */
function gHomePage(){
  const ws=GY.workouts;
  const gAiBusy=jobBusy('workout'), aiRow=GY.ai
    ?`<label class="grow gadd gfile${gAiBusy?' off':''}"><span>✦ ${gAiBusy?'Reading your plan – this can take a minute or two. You can leave this page; you’ll be told when it’s ready.':'Read a workout plan with AI (PDF or photo)…'}</span>
        <input id="g-aifile" type="file" accept=".pdf,application/pdf,image/png,image/jpeg,image/webp"${gAiBusy?' disabled':''}></label>`
    :`<div class="grow gadd off"><span>✦ Read a workout plan with AI – ${isAdmin?'add an OpenRouter key on the <a href="#admin">Super admin page</a> to turn this on':'the super admin needs to add an OpenRouter key first'}</span></div>`;
  return `<div class="gbar"><h2>My workouts</h2>${ws.length>1?`<button class="ghost" type="button" data-g="reorder" aria-pressed="${gReorder}">${gReorder?'Done':'Reorder'}</button>`:''}</div>
    <div class="glist">
      <a class="grow gadd" href="#gym/new"><span>+ New workout…</span></a>
      ${aiRow}
      ${gCsvRow()}
      <a class="grow" href="#gym/x"><span class="gt"><b>My exercises</b></span><span class="gc">${GY.exercises.length}</span><i class="gch">›</i></a>
      ${ws.map((w,i)=>gReorder
        ?`<div class="grow"><span class="gt"><b>${esc(w.name)}</b></span><span class="gmv"><button class="ghost" type="button" data-g="wup" data-i="${i}" aria-label="Move ${esc(w.name)} up"${i?'':' disabled'}>↑</button><button class="ghost" type="button" data-g="wdown" data-i="${i}" aria-label="Move ${esc(w.name)} down"${i<ws.length-1?'':' disabled'}>↓</button></span></div>`
        :`<a class="grow" href="#gym/w/${w.id}"><span class="gt"><b>${esc(w.name)}</b>${w.description?`<small>${esc(w.description)}</small>`:''}</span><span class="gc">${w.items.length}</span><i class="gch">›</i></a>`).join('')}
    </div>
    ${ws.length?'':'<p class="note">Make a workout for each training day – or read your coach’s plan with AI – then tap an exercise to log your sets.</p>'}
    <div id="g-msg" role="status">${gMsg?`<p class="admsg">${esc(gMsg)}</p>`:''}</div>
    ${gAi?gAiPreview():''}${gCsvPanel()}`;
}
function gAiPreview(){
  const n=gAi.workouts.filter(w=>w.on).length;
  return `<section class="panel gai" aria-labelledby="g-aih"><h2 id="g-aih">From ${esc(gAi.file)}</h2>
    <p>Check what the AI found. Exercises marked <span class="chip ok">yours</span> already have history and keep it; the rest are added to My exercises. You can change anything afterwards with Edit.</p>
    ${gAi.workouts.map((w,i)=>`<div class="gaiw"><label class="tog"><input type="checkbox" id="g-aion-${i}" data-g="aion" data-i="${i}"${w.on?' checked':''}> <b>${esc(w.name)}</b> <span class="sub">${w.exercises.length} exercises</span></label>
      ${w.description?`<p>${esc(w.description)}</p>`:''}
      <ol>${w.exercises.map(x=>`<li><b>${esc(x.name)}</b>${x.existing?' <span class="chip ok">yours</span>':' <span class="chip info">new</span>'}${x.parts&&x.parts.length?' '+gPartChips(x.parts):''}${x.target?` <span class="sub">${esc(x.target)}</span>`:''}</li>`).join('')}</ol></div>`).join('')}
    ${gAi.notes.length?`<details class="adnotes" open><summary>What the AI wasn’t sure about (${gAi.notes.length})</summary><ul>${gAi.notes.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></details>`:''}
    <div class="gactions"><button class="btn" type="button" data-g="aiadd"${n?'':' disabled'}>Add ${n} workout${n===1?'':'s'}</button><button class="ghost" type="button" data-g="aidrop">Discard</button></div>
  </section>`;
}

/* ---------- one workout ---------- */
async function gWorkoutPage(id){
  const w=GY.workouts.find(x=>x.id===id);
  if(!w)return gHead('#gym','Workout')+gEmpty('This workout doesn’t exist any more.');
  const today=await gSetsOn(todayStr());
  return gHead('#gym',w.name,`<a class="ghost" href="#gym/w/${w.id}/edit">Edit</a>`)
    +(w.description?`<p class="gdesc">${esc(w.description)}</p>`:'')
    +`<div class="glist">${w.items.map(i=>{const e=exById(i.e), n=today.filter(s=>s.e===i.e).length;
      return `<a class="grow" href="#gym/e/${i.e}"><span class="gt"><b>${esc(e.name)}</b>${i.target?`<small>${esc(i.target)}</small>`:''}</span>
        ${n?`<span class="chip ok">✓ ${n} today</span>`:`<span class="gwhen">${esc(ago(e.last&&e.last.slice(0,10)))}</span>`}<i class="gch">›</i></a>`;}).join('')
      ||'<p class="empty grow">No exercises yet – tap Edit to add some.</p>'}</div>`;
}

/* ---------- new / edit workout ---------- */
function gEditPage(id){
  const w=id==null?null:GY.workouts.find(x=>x.id===id);
  if(id!=null&&!w)return gHead('#gym','Workout')+gEmpty('This workout doesn’t exist any more.');
  if(!gDraft||gDraft.id!==id){gDraft=w?{id,ver:w.updated,name:w.name,description:w.description,items:w.items.map(i=>({e:i.e,target:i.target||''}))}:{id:null,name:'',description:'',items:[]};gPick.q='';gTagMsg='';}
  const D=gDraft, back=w?`#gym/w/${w.id}`:'#gym';
  return gHead(back,w?'Edit workout':'New workout')+`<section class="panel">
    <label class="f"><span class="lbl">Name</span><input id="g-wname" data-g="wf" data-k="name" value="${esc(D.name)}" maxlength="80" placeholder="e.g. Monday — Upper"></label>
    <label class="f"><span class="lbl">Description (optional)</span><textarea id="g-wdesc" data-g="wf" data-k="description" rows="3" maxlength="1000">${esc(D.description)}</textarea></label>
    <h3 class="lbl">Exercises</h3>
    <div class="gedit">${gEditItems()}</div>
    <section class="gpick" aria-labelledby="g-pickh"><h3 class="lbl" id="g-pickh">Add exercises</h3>
      <form id="g-addex" class="gaddex"><input id="g-exname" type="search" value="${esc(gPick.q)}" maxlength="80" autocomplete="off" placeholder="Search, or type a new name" aria-label="Search exercises or type a new name"><button class="btn" type="submit">Add</button></form>
      ${gPartBar()}
      <div class="glist gpicklist" id="g-picklist" aria-label="Your exercises – tap one to add it">${gPickList()}</div>
      ${gTagRow()}
    </section>
    <div class="gactions"><button class="btn" type="button" data-g="wsave">Save workout</button>${w?'<button class="ghost" type="button" data-g="wdel">Delete workout</button>':''}</div>
    <p id="g-emsg" class="sub" role="alert"></p>
  </section>`;
}
function gEditItems(){
  const D=gDraft;
  return D.items.map((i,ix)=>`<div class="gerow"><span class="gi">${ix+1}</span><b class="gen">${esc(i.e?exName(i.e):i.name)}${i.e?'':' <span class="chip info">new</span>'}</b>
        <input id="g-wt-${ix}" class="gtarget" data-g="wt" data-i="${ix}" value="${esc(i.target)}" maxlength="200" placeholder="Target, e.g. 3 × 8–12" aria-label="Target for ${esc(i.e?exName(i.e):i.name)}">
        <span class="gmv"><button class="ghost" type="button" data-g="iup" data-i="${ix}" aria-label="Move up"${ix?'':' disabled'}>↑</button><button class="ghost" type="button" data-g="idown" data-i="${ix}" aria-label="Move down"${ix<D.items.length-1?'':' disabled'}>↓</button>
        <button class="x" type="button" data-g="idel" data-i="${ix}" aria-label="Remove">×</button></span></div>`).join('')||gEmpty('No exercises yet – pick some below.');
}
/* the picker: your exercises that match the search and body part; tap one to add it (again for a second slot) */
function gPickList(){
  const inW=new Map();gDraft.items.forEach(i=>{if(i.e)inW.set(i.e,(inW.get(i.e)||0)+1);});
  const t=gPick.q.replace(/\s+/g,' ').trim(), tl=t.toLowerCase();
  const list=gByPart(GY.exercises.filter(e=>gHasPart(e,gPick.part)&&(!tl||e.name.toLowerCase().includes(tl))));
  const exact=tl&&GY.exercises.some(e=>e.name.toLowerCase()===tl);
  return (t&&!exact?`<button type="button" class="grow gprow gadd" data-g="picknew"><span class="gt"><b>+ Add “${esc(t)}” as a new exercise</b></span></button>`:'')
    +list.map(e=>{const k=inW.get(e.id);return `<button type="button" class="grow gprow" data-g="pick" data-id="${e.id}" aria-label="Add ${esc(e.name)}"><span class="gt"><b>${esc(e.name)}</b>${gPartChips(e.parts)}</span>
      ${k?`<span class="chip ok">✓${k>1?' ×'+k:''}</span>`:''}<span class="gplus" aria-hidden="true">+</span></button>`;}).join('')
    +(list.length||t?'':`<p class="empty grow">${GY.exercises.length?'No exercises match.':'No exercises yet – type a name above to add one.'}</p>`);
}
/* after picking: redraw the workout's list and the picker without losing the picker's scroll */
function gPickRefresh(){
  const ed=$('#g-body .gedit'), pl=$('#g-picklist');if(!ed||!pl){renderGym();return;}
  const top=pl.scrollTop;ed.innerHTML=gEditItems();pl.innerHTML=gPickList();pl.scrollTop=top;
}
async function gSaveDraft(){
  const D=gDraft, msg=$('#g-emsg');
  if(!D.name.trim()){msg.textContent='Give the workout a name.';$('#g-wname').focus();return;}
  try{
    for(const i of D.items){if(!i.e){const e=await api('POST','/api/gym/exercises',{name:i.name});i.e=e.id;delete i.name;}}
    const body={name:D.name,description:D.description,items:D.items.map(i=>({e:i.e,target:i.target}))};
    const r=D.id==null?await api('POST','/api/gym/workouts',body):await api('PUT','/api/gym/workouts/'+D.id,body,D.ver);
    gDraft=null;await gLoad();go('gym/w/'+r.id);
  }catch(e){if(!e.signedOut){await gLoad().catch(()=>{});msg.textContent=e.message;}}
}

/* ---------- one exercise: sets, chart, records, and the bar to log a set ---------- */
async function gExercisePage(id){
  const e=exById(id);
  if(!e)return gHead(gBackE,'Exercise')+gEmpty('This exercise doesn’t exist any more.');
  const sets=await gSetsOf(id), A=gAnalyse(sets), last=sets[sets.length-1];
  if(!gQuick||gQuick.e!==id)gQuick={e:id,reps:last?last.reps:8,kg:last?last.kg:20,note:''};
  const tabs=[['sets','Sets'],['chart','Chart'],['records','Records']].map(([t,n])=>`<button type="button" data-g="tab" data-t="${t}" aria-pressed="${gTab===t}">${n}</button>`).join('');
  let body;
  if(gTab==='chart')body=`<section class="panel"><h2>Estimated 1 rep max</h2><div class="clegend"><span><i class="sw line"></i>Best estimated 1RM of the day</span><span><i class="sw dots"></i>Heaviest weight</span></div><div class="chart" id="g-chart"></div><p class="sub">From weighted sets of 1–20 reps (Epley), as on the Timeline.</p></section>`;
  else if(gTab==='records')body=gRecords(sets,A);
  else{
    const days=[...A.days.keys()].reverse();
    body=days.length?`<div class="gdays">${days.slice(0,gShow).map((d,di)=>{const ss=A.days.get(d), prev=A.days.get(days[di+1]);
      const cmp=(v,ix,k)=>{const p=prev&&prev[ix];return !p||v===p[k]?'':v>p[k]?' up':' down';};
      return `<section class="gday"><h3><a href="#gym/d/${d}">${esc(dayLabel(d))} ›</a>${A.volPr.has(d)?'<span class="chip gvol">🏆 Volume</span>':''}</h3>
        ${ss.map((s,ix)=>{const isPr=A.pr.has(s.id);return `<a class="gset" href="#gym/s/${s.id}"><span class="gi">${ix+1}</span>
          <span class="gtm">${ix?`<span class="grest">+${fmtDur(atMs(s.at)-atMs(ss[ix-1].at))}</span>`:esc(s.at.slice(11,16))}${isPr?' <span class="gtro" title="Best estimated 1RM so far">🏆</span>':''}</span>
          <span class="gnum${isPr?' pr':cmp(s.reps,ix,'reps')}">${s.reps}<small>rep</small></span><span class="gnum${isPr?' pr':cmp(s.kg,ix,'kg')}">${kgTxt(s.kg)}<small>kg</small></span><i class="gch">›</i>
          ${s.note?`<span class="gnote">${esc(s.note)}</span>`:''}</a>`;}).join('')}</section>`;}).join('')}
      ${days.length>gShow?`<button class="ghost" type="button" data-g="more">Show older sets</button>`:''}</div>`
      :gEmpty('No sets yet – log your first one below.');
  }
  const Q=gQuick;
  return gHead(gBackE,e.name)+`<div class="seg" role="group" aria-label="Show">${tabs}</div>
    ${gPartChips(e.parts)}<label class="tog gtrend" title="Chart this exercise’s estimated 1RM on the Timeline"><input type="checkbox" data-g="trend" data-id="${e.id}"${e.trend?' checked':''}> Trend – show its e1RM on the <a href="#history/timeline">Timeline</a></label>${e.notes?`<p class="gdesc">${esc(e.notes)}</p>`:''}${body}
    <form id="g-quick" class="gquick" aria-label="Log a set">
      <div class="gqf"><label class="gqin"><input id="g-reps" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${Q.reps}" aria-label="Reps"><em>rep</em></label>
        <span class="gstep"><button type="button" data-g="adj" data-f="reps" data-d="-1" aria-label="One rep less">−</button><button type="button" data-g="adj" data-f="reps" data-d="1" aria-label="One rep more">+</button></span></div>
      <div class="gqf"><label class="gqin"><input id="g-kg" type="number" inputmode="decimal" min="-500" max="2000" step="any" value="${kgTxt(Q.kg)}" aria-label="Weight in kg"><em>kg</em></label>
        <span class="gstep two"><button type="button" data-g="adj" data-f="kg" data-d="-1" aria-label="1 kg less">−1</button><button type="button" data-g="adj" data-f="kg" data-d="1" aria-label="1 kg more">+1</button>
          <button type="button" data-g="adj" data-f="kg" data-d="-5" aria-label="5 kg less">−5</button><button type="button" data-g="adj" data-f="kg" data-d="5" aria-label="5 kg more">+5</button></span></div>
      <div class="gqrow"><input id="g-note" value="${esc(Q.note)}" maxlength="300" placeholder="Add note" aria-label="Note"><span id="g-rest" class="sub" aria-live="off"></span>
        <button class="btn gok" type="submit">✓ Log set</button></div>
    </form>
    <details class="panel gexset"${gExOpen?' open':''}><summary>Exercise settings</summary>
      <form id="g-exform" class="gexform"><label class="f"><span class="lbl">Name</span><input id="g-exn" value="${esc(e.name)}" maxlength="80" required></label>
        <label class="f"><span class="lbl">Notes (seat height, grip…)</span><textarea id="g-exnotes" rows="2" maxlength="1000">${esc(e.notes||'')}</textarea></label>
        <fieldset class="gpartset"><legend class="lbl">Body parts it trains</legend>
          ${GY.parts.map(p=>`<label class="tog"><input type="checkbox" name="g-part" value="${p.id}"${e.parts.includes(p.id)?' checked':''}> ${esc(p.name)}</label>`).join('')}
          ${GY.ai?`<button class="ghost" type="button" data-g="aitag1" data-id="${e.id}"${gTagBusy?' disabled':''}>✦ ${gTagBusy?'Asking AI…':'Ask AI'}</button>`:''}</fieldset>
        <p class="sub" role="status">${esc(gTagMsg)}</p>
        <div class="gactions"><button class="btn" type="submit">Save</button><button class="ghost" type="button" data-g="exdel">Delete exercise and its ${sets.length} set${sets.length===1?'':'s'}</button></div>
        <p id="g-exmsg" class="sub" role="status"></p></form>
    </details>`;
}
function gAfterExercise(id){
  if(gTab==='chart')gChart(GSETS[id]||[]);
  const last=(GSETS[id]||[]).slice(-1)[0], el=$('#g-rest');
  if(!last||!el)return;
  const tick=()=>{const ms=Date.now()-atMs(last.at);if(!document.body.contains(el)||ms<0||ms>3*3600000){el.textContent='';return;}el.textContent='Rest '+fmtDur(ms);};
  tick();gTimer=setInterval(tick,1000);
}
function gRecords(sets,A){
  if(!sets.length)return gEmpty('No sets yet.');
  const max=f=>sets.reduce((b,s)=>(f(s)>f(b)?s:b),sets[0]);
  const when=s=>`${s.reps} × ${kgTxt(s.kg)} kg · ${fmtShort(s.at.slice(0,10))}`;
  const b1=max(e1rm), bk=max(s=>s.kg*10000+s.reps), br=max(s=>s.reps*10000+s.kg), bv=max(s=>s.reps*s.kg);
  let bd=null,bdv=-1;for(const [d,ss] of A.days){const v=ss.reduce((a,s)=>a+s.reps*s.kg,0);if(v>bdv){bdv=v;bd=d;}}
  const reps=[];for(let r=1;r<=15;r++){const ok=sets.filter(s=>s.reps>=r);if(ok.length)reps.push([r,ok.reduce((b,s)=>(s.kg>b.kg?s:b),ok[0])]);}
  return `<div class="wstats">${[
    e1rm(b1)>0?['Est. 1 rep max',`${kgTxt(Math.round(e1rm(b1)*10)/10)}<i>kg</i>`,when(b1)]:['Est. 1 rep max','–','needs a weighted set of 1–20 reps'],
    ['Heaviest',`${kgTxt(bk.kg)}<i>kg</i>`,when(bk)],
    ['Most reps',`${br.reps}<i>reps</i>`,when(br)],
    ['Best set volume',`${kgTxt(Math.round(bv.reps*bv.kg))}<i>kg</i>`,when(bv)],
    ['Best day volume',`${kgTxt(Math.round(bdv))}<i>kg</i>`,fmtShort(bd)],
    ['Logged',`${sets.length}<i>sets</i>`,`on ${A.days.size} day${A.days.size===1?'':'s'}`],
  ].map(([l,v,s])=>`<div class="stat"><span class="lbl">${l}</span><span class="num">${v}</span><span class="sub">${esc(s)}</span></div>`).join('')}</div>
  <section class="panel"><h2>Rep maxes</h2><p>The heaviest weight you’ve moved for at least that many reps.</p>
    <div class="greps">${reps.map(([r,s])=>`<span class="lbl">${r} rep${r>1?'s':''}</span><b>${kgTxt(s.kg)} kg</b><span class="sub">${esc(fmtShort(s.at.slice(0,10)))}${s.reps>r?` (${s.reps} reps)`:''}</span>`).join('')}</div></section>`;
}
function gChart(sets){
  const box=$('#g-chart');if(!box)return;
  const days=new Map();sets.forEach(s=>{const d=s.at.slice(0,10),o=days.get(d)||{d,e:0,k:-Infinity};o.e=Math.max(o.e,e1rm(s));o.k=Math.max(o.k,s.kg);days.set(d,o);});
  const pts=[...days.values()];
  if(pts.length<2){box.innerHTML='<p class="emptyc">Log this exercise on two different days to see a trend.</p>';return;}
  const W=Math.max(300,box.clientWidth||600), H=Math.round(Math.min(320,Math.max(220,W*0.42))), m={l:44,r:12,t:12,b:26};
  const t0=parse(pts[0].d).getTime(), t1=parse(pts[pts.length-1].d).getTime();
  const vals=pts.flatMap(p=>p.e>0?[p.e,p.k]:[p.k]);let lo=Math.min(...vals),hi=Math.max(...vals);const padv=Math.max(1,(hi-lo)*0.12);lo-=padv;hi+=padv;
  const step=[1,2,5,10,20,25,50,100,200].find(s=>(hi-lo)/s<=5)||500;lo=Math.floor(lo/step)*step;hi=Math.ceil(hi/step)*step;
  const x=d=>m.l+(parse(d).getTime()-t0)/Math.max(1,t1-t0)*(W-m.l-m.r), y=v=>m.t+(hi-v)/(hi-lo)*(H-m.t-m.b);
  let g='<g class="grid">';for(let v=lo;v<=hi+1e-9;v+=step)g+=`<line x1="${m.l}" x2="${W-m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
  g+='</g><g class="axis">';for(let v=lo;v<=hi+1e-9;v+=step)g+=`<text x="${m.l-6}" y="${y(v)+4}" text-anchor="end">${v}</text>`;
  [pts[0].d,pts[pts.length-1].d].forEach((d,i)=>{g+=`<text x="${x(d)}" y="${H-6}" text-anchor="${i?'end':'start'}">${esc(fmtShort(d))}</text>`;});
  g+='</g>';
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated 1 rep max from ${esc(fmtShort(pts[0].d))} to ${esc(fmtShort(pts[pts.length-1].d))}">${g}
    ${pts.map(p=>`<circle class="pt" cx="${x(p.d).toFixed(1)}" cy="${y(p.k).toFixed(1)}" r="3"><title>${esc(fmtShort(p.d))}: ${kgTxt(p.k)} kg</title></circle>`).join('')}
    <path class="avg" d="${pts.filter(p=>p.e>0).map((p,i)=>(i?'L':'M')+x(p.d).toFixed(1)+' '+y(p.e).toFixed(1)).join('')}"/></svg>`;
}

/* ---------- edit one set ---------- */
async function gSetPage(id){
  let s=null;for(const k in GSETS){s=GSETS[k].find(x=>x.id===id);if(s)break;}
  if(!s)s=await api('GET','/api/gym/sets/'+id);
  if(!s)return gHead(gBackE,'Edit set')+gEmpty('This set doesn’t exist any more.');
  return gHead('#gym/e/'+s.e,'Edit set')+`<form id="g-setform" class="panel gsetform" data-id="${s.id}">
    <label class="f"><span class="lbl">Exercise</span><select id="g-se">${GY.exercises.map(e=>`<option value="${e.id}"${e.id===s.e?' selected':''}>${esc(e.name)}</option>`).join('')}</select></label>
    <div class="g2"><label class="f"><span class="lbl">Reps</span><input id="g-sr" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${s.reps}" required></label>
      <label class="f"><span class="lbl">Weight kg</span><input id="g-sk" type="number" inputmode="decimal" min="-500" max="2000" step="any" value="${kgTxt(s.kg)}" required></label></div>
    <label class="f"><span class="lbl">Notes</span><input id="g-sn" value="${esc(s.note)}" maxlength="300" placeholder="Comment"></label>
    <div class="g2"><label class="f"><span class="lbl">Date</span><input id="g-sd" type="date" value="${s.at.slice(0,10)}" required></label>
      <label class="f"><span class="lbl">Time</span><input id="g-st" type="time" step="1" value="${s.at.slice(11,19)}" required></label></div>
    <div class="gactions"><button class="btn" type="submit">Save</button><button class="ghost gdel" type="button" data-g="sdel" data-id="${s.id}" data-e="${s.e}">Delete set</button></div>
    <p id="g-smsg" class="sub" role="alert"></p></form>`;
}

/* ---------- sessions: every day you trained ---------- */
function gSessionsPage(){
  const rows=gSessions||[];
  return `<div class="gbar"><h2>Sessions</h2></div>`+(rows.length?`<div class="glist">${rows.map(r=>{const names=r.ex.map(exName);
    return `<a class="grow" href="#gym/d/${r.date}"><span class="gt"><b>${esc(dayLabel(r.date))}</b>
      <small>${r.sets} set${r.sets===1?'':'s'} · ${r.ex.length} exercise${r.ex.length===1?'':'s'} · ${r.volume.toLocaleString()} kg${r.sets>1?` · ${fmtDur(atMs(r.last)-atMs(r.first))}`:''}</small>
      <small>${esc(names.join(', '))}</small></span><i class="gch">›</i></a>`;}).join('')}</div>`
    :'<p class="note">No sessions yet. Open a workout or an exercise and log a set.</p>');
}
async function gDayPage(d){
  if(!isDate(d))return gHead('#gym/sessions','Session')+gEmpty('That isn’t a date.');
  const sets=await gSetsOn(d), by=new Map();
  sets.forEach(s=>{if(!by.has(s.e))by.set(s.e,[]);by.get(s.e).push(s);});
  const vol=sets.reduce((a,s)=>a+s.reps*s.kg,0);
  return gHead('#gym/sessions',dayLabel(d))+`<p class="gdesc">${esc(fmtLong(d))}${sets.length?` · ${sets.length} sets · ${Math.round(vol).toLocaleString()} kg${sets.length>1?` · ${fmtDur(atMs(sets[sets.length-1].at)-atMs(sets[0].at))}`:''}`:''}</p>`
    +(sets.length?[...by].map(([e,ss])=>`<section class="gday"><h3><a href="#gym/e/${e}">${esc(exName(e))} ›</a></h3>
      ${ss.map((s,ix)=>`<a class="gset" href="#gym/s/${s.id}"><span class="gi">${ix+1}</span><span class="gtm">${esc(s.at.slice(11,16))}</span><span class="gnum">${s.reps}<small>rep</small></span><span class="gnum">${kgTxt(s.kg)}<small>kg</small></span><i class="gch">›</i>${s.note?`<span class="gnote">${esc(s.note)}</span>`:''}</a>`).join('')}</section>`).join('')
    :gEmpty('Nothing logged on this day.'));
}

/* ---------- exercise library ---------- */
function gExercisesPage(){
  return `<div class="gbar"><h2>My exercises</h2></div>
    <form id="g-newex" class="gaddex"><label class="f"><span class="lbl">Find or add</span><input id="g-find" maxlength="80" autocomplete="off" placeholder="e.g. Hack squat"></label><button class="btn" type="submit">Add</button></form>
    <div class="glist">${gCsvRow()}</div>${gCsvPanel()}
    ${gPartBar()}${gTagRow()}
    <div class="glist" id="g-exlist">${gByPart(GY.exercises.filter(e=>gHasPart(e,gPick.part))).map(e=>`<a class="grow" href="#gym/e/${e.id}" data-n="${esc(e.name.toLowerCase())}"><span class="gt"><b>${esc(e.name)}</b>${gPartChips(e.parts)}<small>${e.sets?`${e.sets} set${e.sets===1?'':'s'}`:'No sets yet'}${e.trend?' · on the Timeline':''}</small></span><span class="gwhen">${esc(ago(e.last&&e.last.slice(0,10)))}</span><i class="gch">›</i></a>`).join('')
      ||`<p class="empty grow">${GY.exercises.length?'No exercises for that body part.':'No exercises yet. Add one above, or make a workout.'}</p>`}</div>`;
}

/* ---------- history from Setgraph (or another tracker) as CSV ---------- */
function gCsvRow(){
  const busy=gCsv&&gCsv.busy;
  return `<label class="grow gadd gfile${busy?' off':''}"><span>⇪ ${busy?'Importing…':'Import history from Setgraph (CSV)…'}</span>
    <input id="g-csvfile" type="file" accept=".csv,.txt,text/csv,text/plain"${busy?' disabled':''}></label>`;
}
function gCsvRead(){
  try{gCsv.res=GymCsv.readHistory(gCsv.text,{dateOrder:gCsv.dateOrder,unit:gCsv.unit});gCsv.err='';
    gCsv.dateOrder=gCsv.res.dateOrder;gCsv.unit=gCsv.res.unit;}
  catch(e){gCsv.res=null;gCsv.err=e.message;}
}
function gCsvPanel(){
  if(!gCsv)return '';
  const C=gCsv, R=C.res;
  if(C.done)return `<section class="panel gai" aria-labelledby="g-csvh"><h2 id="g-csvh">Imported ${esc(C.file)}</h2><p class="admsg" role="status">${esc(C.done)}</p>
    <div class="gactions"><button class="ghost" type="button" data-g="csvdrop">Close</button></div></section>`;
  if(!R)return `<section class="panel gai" aria-labelledby="g-csvh"><h2 id="g-csvh">${esc(C.file)}</h2><ul class="aderr" role="alert"><li>${esc(C.err)}</li></ul>
    <div class="gactions"><button class="ghost" type="button" data-g="csvdrop">Close</button></div></section>`;
  const mine=new Set(GY.exercises.map(e=>e.name.toLowerCase())), fresh=R.names.filter(n=>!mine.has(n.toLowerCase()));
  const colNames={exercise:'Exercise',date:'Date',time:'Time',reps:'Reps',weight:'Weight',unit:'Unit',note:'Notes',label:'Label',order:'Set order'};
  const fmtAt=a=>`${fmtShort(a.slice(0,10))} ${a.slice(0,4)} ${a.slice(11,16)}`;
  return `<section class="panel gai" aria-labelledby="g-csvh"><h2 id="g-csvh">From ${esc(C.file)}</h2>
    <p><b>${R.sets.length.toLocaleString()} sets</b> of ${R.names.length} exercise${R.names.length===1?'':'s'}${R.from?`, ${esc(fmtShort(R.from))} ${R.from.slice(0,4)} to ${esc(fmtShort(R.to))} ${R.to.slice(0,4)}`:''}.
      ${R.names.length-fresh.length} match${R.names.length-fresh.length===1?'es':''} exercises you have; ${fresh.length} will be added. Sets you already have are skipped, so importing the same file again is safe.</p>
    <p class="sub">Columns used: ${Object.entries(R.columns).map(([k,v])=>`${colNames[k]} ← “${esc(v)}”`).join(' · ')}</p>
    ${R.dateOrderAsk||C.dateOrderAsked?`<label class="f gcsvopt"><span class="lbl">Dates like 03/04/2026 are</span><select id="g-csvorder"><option value="dmy"${C.dateOrder==='dmy'?' selected':''}>day/month (3 April)</option><option value="mdy"${C.dateOrder==='mdy'?' selected':''}>month/day (March 4)</option></select></label>`:''}
    ${R.unitAsk||C.unitAsked?`<label class="f gcsvopt"><span class="lbl">The file doesn’t say – weights are in</span><select id="g-csvunit"><option value="kg"${C.unit==='kg'?' selected':''}>kg</option><option value="lb"${C.unit==='lb'?' selected':''}>lb (converted to kg)</option></select></label>`:''}
    ${R.noTime?'<p class="sub">The file has dates but no times, so sets are placed at midday in file order.</p>':''}
    ${R.sets.length?`<div class="gcsvtab" role="table" aria-label="Latest sets in the file">${R.sets.slice(-6).reverse().map(s=>`<span role="cell">${esc(fmtAt(s.at))}</span><b role="cell">${esc(s.name)}</b><span role="cell">${s.reps} × ${kgTxt(s.kg)} kg</span>`).join('')}</div><p class="sub">The latest ${Math.min(6,R.sets.length)} sets, as they will be saved.</p>`:''}
    ${R.skipped.length?`<details class="adnotes"><summary>${R.skipped.length} row${R.skipped.length===1?'':'s'} left out</summary><ul>${R.skipped.slice(0,30).map(x=>`<li>Line ${x.line}: ${esc(x.why)}</li>`).join('')}${R.skipped.length>30?`<li>…and ${R.skipped.length-30} more</li>`:''}</ul></details>`:''}
    <div class="gactions">${C.busy?`<span class="chip info" role="status">Importing ${C.sent.toLocaleString()} of ${R.sets.length.toLocaleString()}…</span>`
      :`<button class="btn" type="button" data-g="csvgo"${R.sets.length?'':' disabled'}>Import ${R.sets.length.toLocaleString()} sets</button><button class="ghost" type="button" data-g="csvdrop">Discard</button>`}</div>
    ${C.err?`<ul class="aderr" role="alert"><li>${esc(C.err)}</li></ul>`:''}
  </section>`;
}
async function gCsvImport(){
  const C=gCsv, batches=GymCsv.importBatches(C.res.sets);
  C.busy=true;C.sent=0;C.err='';renderGym();
  let added=0,skipped=0,fresh=0;
  try{
    for(const b of batches){const r=await api('POST','/api/gym/import-sets',{sets:b});added+=r.added;skipped+=r.skipped;fresh+=r.newExercises;C.sent+=b.length;renderGym();}
    const out=C.res.skipped;
    C.done=`Added ${added.toLocaleString()} set${added===1?'':'s'}${skipped?` (${skipped.toLocaleString()} you already had ${skipped===1?'was':'were'} skipped)`:''}${fresh?` and ${fresh} new exercise${fresh===1?'':'s'}`:''}.`
      +(out.length?` ${out.length.toLocaleString()} row${out.length===1?' of the file was':'s of the file were'} left out: ${out.slice(0,3).map(x=>`line ${x.line}, ${x.why}`).join('; ')}${out.length>3?'; …':''}.`:'');
  }catch(e){if(e.signedOut)return;C.err=`Stopped after ${C.sent.toLocaleString()} sets: ${endStop(e.message)} Import the file again to carry on – sets already added are skipped.`;}
  C.busy=false;Object.keys(GSETS).forEach(k=>delete GSETS[k]);gChanged();
  try{await gLoad();}catch{}
  renderGym();
}

/* ---------- actions ---------- */
async function gLogSet(){
  const Q=gQuick, reps=+$('#g-reps').value, kg=+$('#g-kg').value, note=$('#g-note').value.trim();
  if(!Number.isInteger(reps)||reps<0||reps>1000){alert('Reps must be a whole number.');return;}
  if(!Number.isFinite(kg)||$('#g-kg').value===''){alert('Enter a weight (0 for bodyweight).');return;}
  const btn=$('#g-quick .gok');btn.disabled=true;
  try{
    const s=await api('POST','/api/gym/sets',{exercise:Q.e,reps,kg,note,at:nowAt()});
    (GSETS[Q.e]=GSETS[Q.e]||[]).push(s);
    const e=exById(Q.e);if(e){e.sets++;e.last=s.at;}
    Object.assign(Q,{reps,kg,note:''});gChanged();
    if(gTab!=='sets')gTab='sets';
    await renderGym();
  }catch(err){btn.disabled=false;if(!err.signedOut)alert('Couldn’t log the set: '+err.message);}
}
async function gAiRead(file){
  if(file.size>10*1024*1024){gMsg='That file is over 10 MB.';renderGym();return;}
  gMsg='';gAi=null;jobSeen('workout');
  try{await jobStart('/api/gym/ai-import','workout',file);}   /* read in the background: jobs.js brings the result to J_OPEN.workout */
  catch(err){if(err.signedOut)return;gMsg='The AI couldn’t read that: '+err.message;}
  renderGym();
}
J_BUSY.workout=()=>{if(view==='gym'&&!gArgs[0])renderGym();};
J_OPEN.workout=job=>{
  if(job.status!=='done'){gAi=null;gMsg='The AI couldn’t read that: '+(job.error||'Something went wrong');}
  else{const j=job.result;gMsg='';gAi={file:job.label||'your plan',notes:j.notes||[],workouts:j.workouts.map(w=>({...w,on:true}))};}
  renderGym();
};
async function gAiAdd(){
  const list=gAi.workouts.filter(w=>w.on).map(w=>({name:w.name,description:w.description,exercises:w.exercises.map(x=>({name:x.name,target:x.target,parts:x.parts||[]}))}));
  try{const r=await api('POST','/api/gym/import',{workouts:list});GY={...r,parts:GY.parts,ai:GY.ai};
    gMsg=`Added ${list.length} workout${list.length===1?'':'s'}.`;gAi=null;jobSeen('workout');renderGym();}
  catch(err){if(!err.signedOut){gMsg='Couldn’t add them: '+err.message;renderGym();}}
}

document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-g]');if(!b||view!=='gym'||b.tagName==='INPUT'||b.tagName==='TEXTAREA'||b.tagName==='A')return;
  const g=b.dataset.g, i=+b.dataset.i;
  if(g==='tab'){gTab=b.dataset.t;renderGym();}
  else if(g==='more'){gShow+=30;renderGym();}
  else if(g==='adj'){const el=$(b.dataset.f==='reps'?'#g-reps':'#g-kg');const v=Math.max(b.dataset.f==='reps'?0:-500,(+el.value||0)+ +b.dataset.d);
    el.value=b.dataset.f==='reps'?Math.round(v):kgTxt(v);gQuick[b.dataset.f]=+el.value;}
  else if(g==='reorder'){gReorder=!gReorder;renderGym();}
  else if(g==='wup'||g==='wdown'){const ws=GY.workouts.slice(),j=g==='wup'?i-1:i+1;if(j<0||j>=ws.length)return;[ws[i],ws[j]]=[ws[j],ws[i]];
    try{await api('PUT','/api/gym/order',{ids:ws.map(w=>w.id)});GY.workouts=ws;renderGym();}catch(err){if(!err.signedOut)alert(err.message);}}
  else if(g==='iup'||g==='idown'){const it=gDraft.items,j=g==='iup'?i-1:i+1;if(j<0||j>=it.length)return;[it[i],it[j]]=[it[j],it[i]];renderGym();}
  else if(g==='idel'){gDraft.items.splice(i,1);renderGym();}
  else if(g==='wsave'){once(b,gSaveDraft);}
  else if(g==='wdel'){if(!confirm(`Delete the workout “${gDraft.name}”? Your exercises and sets stay.`))return;
    try{await api('DELETE','/api/gym/workouts/'+gDraft.id);gDraft=null;await gLoad();go('gym');}catch(err){if(!err.signedOut)alert(err.message);}}
  else if(g==='sdel'){if(!confirm('Delete this set?'))return;const id=+b.dataset.id,ex=+b.dataset.e;
    try{await api('DELETE','/api/gym/sets/'+id);delete GSETS[ex];gChanged();await gLoad();go('gym/e/'+ex);}catch(err){if(!err.signedOut)alert(err.message);}}
  else if(g==='exdel'){const id=+gArgs[1],ex=exById(id);if(!ex||!confirm(`Delete ${ex.name} and all ${ex.sets} of its sets? This can’t be undone.`))return;
    try{await api('DELETE','/api/gym/exercises/'+id);delete GSETS[id];gChanged();await gLoad();go('gym/x');}catch(err){if(!err.signedOut)alert(err.message);}}
  else if(g==='aiadd'){once(b,gAiAdd);}
  else if(g==='part'){gPick.part=b.dataset.p===gPick.part?'':b.dataset.p;renderGym();}
  else if(g==='pick'&&gDraft){gDraft.items.push({e:+b.dataset.id,target:''});gPickRefresh();}
  else if(g==='picknew'&&gDraft){const v=gPick.q.replace(/\s+/g,' ').trim();if(!v)return;gDraft.items.push({e:null,name:v,target:''});gPick.q='';$('#g-exname').value='';gPickRefresh();}
  else if(g==='aitag'){gTagAi(GY.exercises.filter(x=>!x.parts.length).map(x=>x.id));}
  else if(g==='aitag1'){gExOpen=true;gTagAi([+b.dataset.id]);}
  else if(g==='csvgo'){if(gCsv&&!gCsv.busy)gCsvImport();}
  else if(g==='csvdrop'){gCsv=null;renderGym();}
  else if(g==='aidrop'){gAi=null;gMsg='';jobSeen('workout');renderGym();}
});
document.addEventListener('input',e=>{
  const el=e.target;if(view!=='gym')return;
  if(el.dataset.g==='wf'&&gDraft)gDraft[el.dataset.k]=el.value;
  else if(el.dataset.g==='wt'&&gDraft)gDraft.items[+el.dataset.i].target=el.value;
  else if(gQuick&&el.id==='g-reps')gQuick.reps=+el.value;
  else if(gQuick&&el.id==='g-kg')gQuick.kg=+el.value;
  else if(gQuick&&el.id==='g-note')gQuick.note=el.value;
  else if(el.id==='g-exname'&&gDraft){gPick.q=el.value;const pl=$('#g-picklist');if(pl){pl.innerHTML=gPickList();pl.scrollTop=0;}}
  else if(el.id==='g-find'){const t=el.value.trim().toLowerCase();document.querySelectorAll('#g-exlist .grow[data-n]').forEach(r=>{r.hidden=!!t&&!r.dataset.n.includes(t);});}
});
document.addEventListener('change',e=>{
  const el=e.target;if(view!=='gym')return;
  if(el.id==='g-csvfile'){const f=el.files&&el.files[0];el.value='';if(!f||(gCsv&&gCsv.busy))return;
    if(f.size>20*1024*1024){gCsv={file:f.name,res:null,err:'That file is over 20 MB.'};renderGym();return;}
    f.text().then(t=>{gCsv={file:f.name,text:t};gCsvRead();renderGym();},()=>{gCsv={file:f.name,res:null,err:'Couldn’t read that file.'};renderGym();});}
  else if(el.id==='g-csvorder'&&gCsv){gCsv.dateOrder=el.value;gCsv.dateOrderAsked=true;gCsvRead();renderGym();}
  else if(el.id==='g-csvunit'&&gCsv){gCsv.unit=el.value;gCsv.unitAsked=true;gCsvRead();renderGym();}
  else if(el.id==='g-aifile'){const f=el.files&&el.files[0];el.value='';if(f&&!jobBusy('workout'))gAiRead(f);}
  else if(el.dataset.g==='aion'&&gAi){gAi.workouts[+el.dataset.i].on=el.checked;renderGym();}
  else if(el.dataset.g==='trend')gTrend(el);
});
/* "Trend": follow the exercise's e1RM on the Timeline's chart (switched on there too, so it shows straight away) */
async function gTrend(el){
  const id=+el.dataset.id, on=el.checked;el.disabled=true;
  try{
    const x=await api('PUT',`/api/gym/exercises/${id}/trend`,{on});const e=exById(id);if(e)e.trend=x.trend;
    if(typeof tOn!=='undefined'){const k='ex:'+id;if(x.trend)tOn.add(k);else tOn.delete(k);tKeep();TL=null;}
  }catch(err){el.checked=!on;if(!err.signedOut)alert(err.message);}
  el.disabled=false;
}
document.addEventListener('submit',async e=>{
  const f=e.target;if(view!=='gym'||!f.id||!f.id.startsWith('g-'))return;
  e.preventDefault();
  if(f.id==='g-quick')return gLogSet();   /* its button is off while it saves; sets logged back to back are meant */
  if(f.id!=='g-addex')return once(f,()=>gSubmit(f));
  const v=$('#g-exname').value.replace(/\s+/g,' ').trim();if(!v)return;
  const ex=GY.exercises.find(x=>x.name.toLowerCase()===v.toLowerCase());
  gDraft.items.push(ex?{e:ex.id,target:''}:{e:null,name:v,target:''});gPick.q='';await renderGym();$('#g-exname').focus();
});
async function gSubmit(f){
  if(f.id==='g-newex'){const v=$('#g-find').value.replace(/\s+/g,' ').trim();if(!v)return;
    try{const ex=await api('POST','/api/gym/exercises',{name:v});await gLoad();go('gym/e/'+ex.id);}catch(err){if(!err.signedOut)alert(err.message);}}
  else if(f.id==='g-exform'){const id=+gArgs[1];
    const ticked=[...f.querySelectorAll('input[name=g-part]:checked')].map(x=>x.value), had=(exById(id)||{parts:[]}).parts;
    const parts=[...had.filter(p=>ticked.includes(p)),...ticked.filter(p=>!had.includes(p))];
    try{await api('PUT','/api/gym/exercises/'+id,{name:$('#g-exn').value,notes:$('#g-exnotes').value,parts});gTagMsg='';gExOpen=false;await gLoad();renderGym();}
    catch(err){if(!err.signedOut)$('#g-exmsg').textContent=err.message;}}
  else if(f.id==='g-setform'){const id=+f.dataset.id, t=$('#g-st').value;
    const body={exercise:+$('#g-se').value,reps:+$('#g-sr').value,kg:+$('#g-sk').value,note:$('#g-sn').value,at:`${$('#g-sd').value}T${t.length===5?t+':00':t}`};
    try{const old=Object.keys(GSETS).find(k=>GSETS[k].some(s=>s.id===id));const s=await api('PUT','/api/gym/sets/'+id,body);
      if(old)delete GSETS[old];delete GSETS[s.e];gChanged();await gLoad();go('gym/e/'+s.e);}
    catch(err){if(!err.signedOut)$('#g-smsg').textContent=err.message;}}
}
