'use strict';
/* AI reads that run in the background (server/jobs.js): a meal plan, workout plan or supplement regime file is sent
   with ?bg=1 and the server carries on reading it, so you can go to another page – or close the app – meanwhile.
   While one runs this asks /api/jobs every few seconds; a finished read opens by itself if you're still on the page
   you started it from, otherwise a note at the bottom of the screen (and a browser notification, if allowed) says
   it's ready. Each page fills in J_OPEN (put a finished read where it's checked) and J_BUSY (show that one is running). */
let JOBS=[], jTimer=null;
const J_OPEN={}, J_BUSY={};
/* a finished read open on its page, per kind: it stays unseen on the server until the person adds or drops it (jobSeen),
   so reloading before then lists it again to reopen */
const J_HELD={};
const J_KIND={plan:{name:'meal plan',page:'account'},workout:{name:'workout plan',page:'gym'},supps:{name:'supplement regime',page:'supps/lib'}};
const jobBusy=kind=>JOBS.some(j=>j.kind===kind&&j.status==='running');
/* the first n characters as people see them: an emoji or accented letter is never cut in two */
const jCut=(s,n)=>{try{return Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(s),x=>x.segment).slice(0,n).join('');}catch{return Array.from(s).slice(0,n).join('');}};
const jWhat=j=>`${J_KIND[j.kind].name}${j.label?` (${j.label})`:''}`;

/* Send the file; resolves once the server has started reading it. */
async function jobStart(url,kind,file){
  if('Notification' in window&&Notification.permission==='default'){try{Notification.requestPermission();}catch{}}
  let r;
  try{r=await fetch(url+(url.includes('?')?'&':'?')+'bg=1',{method:'POST',credentials:'same-origin',body:file,
    headers:{'content-type':file.type||'application/pdf','x-csrf-token':csrf,...TZH,'x-file-name':encodeURIComponent(jCut(file.name,120))}});}
  catch{throw new Error('Can’t reach the server – is it still running?');}
  if(r.status===401){setTimeout(toLogin,0);const e=new Error('You were signed out');e.signedOut=true;throw e;}
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);
  JOBS.unshift({...j.job,here:true});
  jChanged(kind);jPoll(3000);
  return j.job;
}

function jPoll(ms){clearTimeout(jTimer);jTimer=setTimeout(jRefresh,ms);}
async function jRefresh(){
  clearTimeout(jTimer);jTimer=null;
  let r;
  try{r=await api('GET','/api/jobs');}catch(e){if(!e.signedOut)jPoll(15000);return;}
  if(!r)return;
  const before=new Map(JOBS.map(j=>[j.id,j]));
  JOBS=r.jobs.filter(j=>J_KIND[j.kind]&&!Object.values(J_HELD).includes(j.id)).map(j=>({...j,here:!!(before.get(j.id)||{}).here}));
  const kinds=new Set();
  for(const j of JOBS){const b=before.get(j.id);if(b&&b.status==='running'&&j.status!=='running'){kinds.add(j.kind);jFinished(j);}}
  kinds.forEach(jChanged);jRender();
  if(JOBS.some(j=>j.status==='running'))jPoll(document.hidden?10000:3000);
}

/* Still where you started it: open it as if you'd waited. Anywhere else: the note, plus a browser notification. */
function jFinished(j){
  if(j.here&&location.hash==='#'+J_KIND[j.kind].page&&!document.hidden){jOpen(j.id);return;}
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  try{
    const n=new Notification(j.status==='done'?`Your ${J_KIND[j.kind].name} is ready`:`The AI couldn’t read your ${J_KIND[j.kind].name}`,
      {body:j.status==='done'?`${j.label?j.label+' – ':''}open Logbook Monster to check it.`:(j.error||''),tag:'lm-job-'+j.id,icon:'/icon.svg'});
    n.onclick=()=>{window.focus();n.close();jOpen(j.id);};
  }catch{}
}

/* Show a finished read on its page and take it off the list. */
async function jOpen(id){
  let full;
  try{full=await api('GET','/api/jobs/'+id);}catch(e){if(!e.signedOut)alert('Couldn’t open it: '+e.message);return;}
  JOBS=JOBS.filter(j=>j.id!==id);jRender();
  if(!full||!J_KIND[full.kind]||full.status==='running'){jSeen(id);return;}
  const k=J_KIND[full.kind];
  jobSeen(full.kind);                                   /* the one it replaces on that page */
  if(full.status==='done')J_HELD[full.kind]=id;else jSeen(id);
  if(location.hash!=='#'+k.page)go(k.page);
  J_OPEN[full.kind](full);
  jChanged(full.kind);
}
function jSeen(id){api('POST',`/api/jobs/${id}/seen`,{}).catch(()=>{});}
/* the page is done with its open read (added, dropped or replaced) */
function jobSeen(kind){const id=J_HELD[kind];if(id==null)return;delete J_HELD[kind];jSeen(id);}
function jDismiss(id){JOBS=JOBS.filter(j=>j.id!==id);jRender();jSeen(id);}
function jChanged(kind){jRender();if(J_BUSY[kind])J_BUSY[kind]();}

/* unopened results are kept 30 days (server/jobs.js) */
const jKeep=j=>j.expires&&/^\d{4}-\d\d-\d\d$/.test(j.expires)?` <span class="sub">Kept until ${esc(fmtShort(j.expires))}.</span>`:'';
function jRender(){
  const box=$('#jobs');if(!box)return;
  box.hidden=!JOBS.length;
  box.innerHTML=JOBS.map(j=>j.status==='running'
    ?`<div class="job"><p><span class="jspin" aria-hidden="true">✦</span> Reading your ${esc(jWhat(j))}… <span class="sub">You can carry on – you’ll be told when it’s ready.</span></p></div>`
    :j.status==='done'
    ?`<div class="job ok"><p>✦ Your ${esc(jWhat(j))} is ready to check.${jKeep(j)}</p><span class="jacts"><button class="btn" type="button" data-job="open" data-id="${j.id}">Open</button><button class="x" type="button" data-job="drop" data-id="${j.id}" aria-label="Dismiss">×</button></span></div>`
    :`<div class="job bad"><p>The AI couldn’t read your ${esc(jWhat(j))}: ${esc(j.error||'')}</p><span class="jacts"><button class="x" type="button" data-job="drop" data-id="${j.id}" aria-label="Dismiss">×</button></span></div>`).join('');
}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-job]');if(!b)return;
  if(b.dataset.job==='open')jOpen(+b.dataset.id);else jDismiss(+b.dataset.id);
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&JOBS.some(j=>j.status==='running'))jRefresh();});
/* After sign-in (app.js): anything still running or finished while you were away. */
function jobsInit(){jRefresh();}
