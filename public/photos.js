'use strict';
/* Progress photos: upload pictures, each with the date it was taken, a pose (front, left side, right side, back,
   other – 'side' is kept for older photos), a pose type (relaxed, front double biceps… or none) and an optional note, and look back through them by date or side by side.
   #photos (the catalog, newest day first: filter by pose or by bodyweight, jump to a date, pick two to compare),
   #photos/12 (one photo: view, change, delete), #photos/compare/12/34 (two photos side by side, older on the left).
   Pictures are shrunk to a JPEG in the browser before upload (which also drops the EXIF data, location
   included) and a small thumbnail is sent after it for the catalog. Many can go at once (up to P_MAX_TOTAL picked),
   each dated from its own data (ExifDate, exifdate.js) unless the person turns that off; the date picked is used for
   any without one. A middle size (P_MID) goes up too, for the photo and Compare pages – the full picture only when zoomed in or opened.
   Uses helpers from app.js and gym.js (gEmpty). */

let PHOTOS=null, PPOSES=[], PSTYLES=[], pReadAt=0;
let pPose='all', pDate=todayStr(), pUpPose='other', pMsg='', pTok=0, pBusy=false;
let pUpSay='', pUpErr='', pFocusAdd=false;   /* an upload's progress line and its error: kept here so leaving Photos and coming back still shows them */
let pSel=false, pPick=[];                          /* picking photos to compare, and the ones picked (up to 2) */
let pAi=false, pAiBusy=false, pAiSay='';         /* AI set up (an admin's OpenRouter key), a "Tag with AI" run going and how far it is */
let pStopUp=false, pStopAi=false;                 /* Stop pressed: the upload / AI run finishes the photos in flight, then stops */
let pAddOpen=null;                                /* the upload form shown ("Add photos"); null: shown while there are no photos */
let pDirty=false;                                 /* the photo page's form changed and not saved */
let pUseExif=true;                                /* date each photo from its own data (the date picked for any without one) */
let pNear=false, pNearKg='', pTol=1;              /* only days when you weighed about the same: around pNearKg (blank = your latest weigh-in), ± pTol kg */
const P_MAX=2000, P_MID=1000, P_THUMB=480;         /* longest side in pixels: the photo, its middle size, the thumbnail */
const P_MAX_TOTAL=5*1024**3, P_MAX_PHOTOS=3000;     /* most picked in one go (the originals; they're shrunk before upload), most an account keeps */
const P_PARALLEL=3;                                /* photos shrunk and uploaded at a time */
const P_NAME={front:'Front',left:'Side – Left',right:'Side – Right',side:'Side',back:'Back',other:'Other'}, P_TOLS=[0.5,1,2,3];
const P_STYLE={relaxed:'Relaxed',front_relaxed:'Front relaxed',back_relaxed:'Back relaxed',front_double_biceps:'Front double biceps',
  back_double_biceps:'Back double biceps',most_muscular:'Most muscular'};
const P_NEAR_DAYS=3;                               /* a day without a weigh-in takes the closest one this many days either side */

const pById=id=>PHOTOS&&PHOTOS.find(p=>p.id===id);
const pSrc=p=>`/api/photos/${p.id}/file?v=${encodeURIComponent(p.v)}`;
const pMid=p=>p.mv?`/api/photos/${p.id}/mid?v=${encodeURIComponent(p.mv)}`:pSrc(p);
const pThumb=p=>p.tv?`/api/photos/${p.id}/thumb?v=${encodeURIComponent(p.tv)}`:pMid(p);
/* a sentence's full stop, unless it ends with one already: a German short date is "17. Okt." (p5-photos S4) */
const pDot=t=>/[.!?…]$/.test(t)?t:t+'.';
const pPoseName=p=>P_NAME[p]||p;
const pStyleName=s=>P_STYLE[s]||s;
/* the pose type without the way the body faces when the pose already says it: Back · Double biceps, not Back · Back double biceps */
const pStyleIn=(pose,s)=>s.startsWith(pose+'_')?pStyleName(s).replace(/^\w+ (.)/,(m,c)=>c.toUpperCase()):pStyleName(s);
/* "Front · Most muscular", or just the pose when there's no pose type */
const pLabel=p=>pPoseName(p.pose)+(p.style?' · '+pStyleIn(p.pose,p.style):'');
function pSort(){if(PHOTOS)PHOTOS.sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);}
async function pLoad(){
  const [r,w]=await Promise.all([api('GET','/api/photos'),api('GET','/api/weights')]);
  PHOTOS=(r&&r.photos)||[];pReadAt=Date.now();if(r&&r.poses)PPOSES=r.poses;if(r&&r.styles)PSTYLES=r.styles;pAi=!!(r&&r.ai);pSort();
  if(w){Object.keys(WEIGHTS).forEach(d=>{delete WEIGHTS[d];});w.forEach(x=>{WEIGHTS[x.date]=x.kg;});}   /* the app's own copy, so a weigh-in cleared on the Daily Tracker is gone here too */
}
const pYmd=d=>parse(d).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
const pDayGap=(a,b)=>Math.round((parse(b)-parse(a))/864e5);

/* ---------- bodyweight ---------- */
/* every weigh-in, oldest first (WEIGHTS in app.js: refreshed when Photos loads, kept up to date by the Daily Tracker) */
function pWeights(){
  return Object.keys(WEIGHTS).filter(d=>WEIGHTS[d]!=null).sort().map(d=>({date:d,kg:WEIGHTS[d]}));
}
/* the weight on a day: that day's weigh-in, else the closest within P_NEAR_DAYS (marked near) */
function pWeightOn(d,ws){
  let best=null;
  for(const w of ws||pWeights()){
    const gap=Math.abs(pDayGap(d,w.date));
    if(gap<=P_NEAR_DAYS&&(!best||gap<best.gap))best={kg:w.kg,gap,date:w.date};
  }
  return best;
}
const pKgTxt=w=>w?`${w.gap?'≈ ':''}${w.kg} kg`:'';
const pKg=d=>pKgTxt(pWeightOn(d));
const pLatest=()=>{const ws=pWeights();return ws.length?ws[ws.length-1]:null;};
const pTarget=()=>{const n=parseFloat(pNearKg);if(n>0)return n;const l=pLatest();return l?l.kg:null;};

/* the photos the catalog shows: the pose filter, then the bodyweight one */
function pShown(){
  let list=PHOTOS.filter(p=>pPose==='all'||p.pose===pPose);
  const t=pTarget();
  if(pNear&&t!=null){
    const ws=pWeights(), ok={};
    list=list.filter(p=>{
      if(!(p.date in ok)){const w=pWeightOn(p.date,ws);ok[p.date]=!!w&&Math.abs(w.kg-t)<=pTol+1e-9;}
      return ok[p.date];
    });
  }
  return list;
}

async function renderPhotos(args){
  if(view!=='photos')return;
  const tok=++pTok, box=$('#p-body'), [a,x,y]=args||[];
  const cmp=a==='compare';
  const tabs=`<nav class="seg gtabs" aria-label="Progress photos"><a href="#photos"${cmp?'':' aria-current="page"'}>By date</a><a href="#photos/compare"${cmp?' aria-current="page"':''}>Compare</a></nav>`;
  try{
    if(!PHOTOS){box.innerHTML=tabs+'<p class="note">Loading…</p>';await pLoad();if(tok!==pTok||view!=='photos')return;}
    else if(isStale(pReadAt)&&!pBusy&&!pAiBusy){await pLoad();if(tok!==pTok||view!=='photos')return;}
    if(/^\d+$/.test(a||'')){
      let p=pById(+a);
      if(!p){await pLoad();if(tok!==pTok||view!=='photos')return;p=pById(+a);}   /* uploaded in another tab since? */
      pDirty=false;pDraft=null;
      box.innerHTML=p?pOnePage(p):pHead('Photo')+gEmpty('That photo isn’t here any more.');
      if(p){pSize(box);pMakeMid(p);}
      return;
    }
    if(cmp){box.innerHTML=tabs+pCmpPage(+x||0,+y||0);pSize(box);return;}
    box.innerHTML=tabs+pCatalogPage();renderPhotoList();
    if(pFocusAdd){pFocusAdd=false;const b=$('#p-addbtn');if(b)b.focus();}   /* the photo page it was on is gone */
  }catch(e){if(!e.signedOut&&tok===pTok)box.innerHTML=tabs+gEmpty('Couldn’t load your photos: '+e.message);}
}

/* back to this tab: the photos again, in case another tab or device added, changed or deleted some. Only the catalog is
   drawn again, and not while an upload or an AI run is going (they add to the list as they go). */
document.addEventListener('visibilitychange',()=>{
  if(document.hidden||!PHOTOS||pBusy||pAiBusy)return;
  const tok=pTok;
  pLoad().then(()=>{if(tok===pTok&&view==='photos'&&$('#p-list'))renderPhotoList();}).catch(()=>{});
});

/* ---------- the catalog: upload, then every day with photos, newest first ---------- */
function pPoseOptions(sel,withAi){
  const list=PPOSES.includes(sel)||!P_NAME[sel]?PPOSES:[...PPOSES,sel];   /* an older photo's "side" stays pickable on it */
  return (withAi&&pAi?`<option value="ai"${sel==='ai'?' selected':''}>Let AI tell</option>`:'')+
    list.map(v=>`<option value="${esc(v)}"${v===sel?' selected':''}>${esc(pPoseName(v))}</option>`).join('');
}
function pStyleOptions(sel){
  return `<option value=""${sel?'':' selected'}>None</option>`+PSTYLES.map(v=>`<option value="${esc(v)}"${v===sel?' selected':''}>${esc(pStyleName(v))}</option>`).join('');
}
/* the AI's pose for a photo; save stores it too, but only while the photo still has the pose it had when asked (seen) or the AI's */
/* the AI only ever gets the small version: a photo without one (from before thumbnails) gets one first */
async function pAskAi(id,save,seen){
  const p=(PHOTOS||[]).find(x=>x.id===id);
  if(p&&!p.tv){
    try{const b=await(await fetch(pSrc(p),{credentials:'same-origin'})).blob();
      const t=await pSend('PUT',`/api/photos/${id}/thumb`,await pShrink(b,P_THUMB,0.8));const i=PHOTOS.findIndex(x=>x.id===id);if(i>=0)PHOTOS[i]=t;}
    catch(e){if(e.signedOut)throw e;}
  }
  return api('POST',`/api/photos/${id}/ai-pose`,{save,...(seen?{if:{pose:seen.pose,style:seen.style||''}}:{})});
}
const P_AI_NOTE='The AI looks at the small version of each photo, sent to the AI service set up for this app; nothing else about you goes with it.';
/* the upload form is behind "Add photos" (so on a phone the first photos are on the first screen), open while there are none
   yet, or an upload is running or stopped short */
const pFormOpen=()=>pBusy||(pAddOpen==null?!PHOTOS.length||!!pUpErr:pAddOpen);
function pCatalogPage(){
  const seg=[['all','All'],...[...PPOSES,...(PHOTOS.some(p=>p.pose==='side')?['side']:[])].map(v=>[v,pPoseName(v)])].map(([v,l])=>`<button type="button" data-pa="filter" data-v="${esc(v)}" aria-pressed="${pPose===v}">${esc(l)}</button>`).join('');
  const days=[...new Set(PHOTOS.map(p=>p.date))], latest=pLatest(), open=pFormOpen();
  const tols=P_TOLS.map(t=>`<option value="${t}"${t===pTol?' selected':''}>± ${t} kg</option>`).join('');
  return `<div class="gbar"><h2>Progress photos</h2><button class="btn" type="button" id="p-addbtn" data-pa="add" aria-expanded="${open}" aria-controls="p-form">Add photos</button></div>
    <form id="p-form" class="panel sform"${open?'':' hidden'}>
      <label class="f swide"><span class="lbl">Photos</span><input id="p-file" type="file" accept="image/*" multiple required></label>
      <label class="f"><span class="lbl">${pUseExif?'Date if a photo has none':'Date taken'}</span><input id="p-date" type="date" required value="${pDate}" max="${todayStr()}"></label>
      ${pAi?`<label class="f"><span class="lbl">Pose</span><select id="p-pose">${pPoseOptions(pUpPose,true)}</select></label>`:''}
      <label class="tog swide"><input type="checkbox" id="p-exif"${pUseExif?' checked':''}> Date each photo from its own data (when it was taken)</label>
      <label class="f swide"><span class="lbl">Note (optional)</span><input id="p-note" maxlength="200" placeholder="e.g. morning, fasted, after the cut"></label>
      <p id="p-pick" class="sub swide" role="status"></p>
      <p id="p-err" class="aderr swide" role="alert"${pUpErr?'':' hidden'}>${esc(pUpErr)}</p>
      <div class="factions swide"><button class="btn" type="submit"${pBusy?' disabled':''}>Upload</button>
        <button class="ghost" type="button" data-pa="upstop" id="p-upstop"${pBusy?'':' hidden'}${pStopUp?' disabled':''}>Stop</button><span id="p-state" class="sub" role="status">${pBusy?esc(pUpSay):''}</span></div>
      <p class="sub swide">Pick as many as you like, up to 5 GB at a time. Only you can see your photos. They’re made smaller before upload and the camera’s details, location included, are left out.${pAi?' With “Let AI tell”, the small version of each photo goes to the AI service set up for this app to pick the pose.':' They go in under Other – open a photo to set its pose.'}</p>
    </form>
    <div class="ptools">
      <div class="seg" role="group" aria-label="Pose">${seg}</div>
      <div class="prow">
        <label class="f pjump"><span class="lbl">Jump to date</span><input id="p-jump" type="date"${days.length?` min="${days[days.length-1]}" max="${days[0]}"`:' disabled'}></label>
        <button class="ghost" type="button" data-pa="select" id="p-selbtn" aria-pressed="${pSel}"${PHOTOS.length<2?' disabled':''}>Compare two photos</button>
        ${pAi?`<button class="ghost" type="button" data-pa="aitag" id="p-aibtn"${PHOTOS.length&&!pAiBusy?'':' disabled'} title="Let the AI set the pose of the photos shown">Tag poses with AI</button>
        <button class="ghost" type="button" data-pa="aiuntag" id="p-aiuntag"${PHOTOS.some(pUntagged)&&!pAiBusy?'':' disabled'} title="Let the AI set the pose of the photos shown that have none yet (or say only Side, not which side), leaving tagged ones as they are">Tag only untagged</button>
        <button class="ghost" type="button" data-pa="aistop" id="p-aistop"${pAiBusy?'':' hidden'}${pStopAi?' disabled':''}>Stop</button>`:''}
        <a class="ghost" href="/api/photos/zip" download id="p-zip"${PHOTOS.length?'':' hidden'}>Download all</a>
      </div>
      ${pAi?`<p id="p-aistate" class="sub" role="status">${pAiBusy?esc(pAiSay):''}</p>`:''}
      <div class="prow pweight">
        <label class="tog"><input type="checkbox" id="p-near"${pNear?' checked':''}${latest?'':' disabled'}> Same weight as</label>
        <label class="f"><span class="lbl">Weight kg</span><input id="p-nearkg" type="number" inputmode="decimal" min="20" max="400" step="0.1" value="${esc(pNearKg)}" placeholder="${latest?latest.kg:''}"${latest?'':' disabled'}></label>
        <label class="f"><span class="lbl">Within</span><select id="p-tol"${latest?'':' disabled'}>${tols}</select></label>
        <span class="sub">${latest?`Your latest weigh-in: <b>${esc(latest.kg)} kg</b> on ${esc(pDot(fmtShort(latest.date)))}`:'Log your weight on the <a href="#day">Daily Tracker</a> to filter photos by bodyweight.'}</span>
      </div>
    </div>
    <div id="p-selbar" class="psel" role="status"${pSel?'':' hidden'}></div>
    <div id="p-list" class="pdays"></div>`;
}
/* "Add photos" shows and hides the form */
function pAddToggle(){
  const f=$('#p-form'), b=$('#p-addbtn');if(!f||!b)return;
  if(pBusy){f.hidden=false;b.setAttribute('aria-expanded','true');$('#p-file').focus();return;}
  pAddOpen=f.hidden;f.hidden=!pAddOpen;b.setAttribute('aria-expanded',String(pAddOpen));
  if(pAddOpen)$('#p-file').focus();
}
function renderPhotoList(){
  const el=$('#p-list');if(!el)return;
  const list=pShown(), t=pTarget();
  let h=pMsg?`<p class="note fmsg" role="status">${esc(pMsg)}</p>`:'';
  const days={};list.forEach(p=>{(days[p.date]=days[p.date]||[]).push(p);});
  const n=Object.keys(days).length;
  if(pNear&&t!=null)h+=`<p class="note">${n?`${n} day${n===1?'':'s'}`:'No days'} with photos when you weighed ${esc(t)} kg ± ${esc(pTol)} (from a weigh-in within ${P_NEAR_DAYS} days of the photo).</p>`;
  if(!PHOTOS.length)h+=gEmpty('No photos yet. Pick some above, set the date they were taken and tap Upload.');
  else if(!list.length&&!pNear)h+=gEmpty(`No ${pPoseName(pPose).toLowerCase()} photos yet.`);
  h+=Object.keys(days).sort().reverse().map(d=>`<section class="pday" id="p-d-${esc(d)}" aria-label="${esc(fmtLong(d))}">
      <h3><span>${esc(fmtLong(d))}</span>${pKg(d)?`<span class="chip">${esc(pKg(d))}</span>`:''}</h3>
      <div class="pgrid">${days[d].map(pTile).join('')}</div></section>`).join('');
  el.innerHTML=h;
  const z=$('#p-zip');if(z)z.hidden=!PHOTOS.length;
  renderSelBar();
}
function pTile(p){
  const what=`${pLabel(p)}, ${fmtShort(p.date)}`, on=pSel&&pPick.includes(p.id);
  return `<a class="ptile${on?' on':''}" href="#photos/${p.id}" data-pid="${p.id}" title="${esc(p.note||what)}"${pSel?` role="button" aria-pressed="${on}"`:''}><img src="${pThumb(p)}" data-full="${pThumb(p)===pMid(p)?pSrc(p):pMid(p)}" alt="${esc(what)}" loading="lazy" decoding="async"><span>${esc(pLabel(p))}</span>${on?`<b class="pnum">${pPick.indexOf(p.id)+1}</b>`:''}</a>`;
}
function renderSelBar(){
  const el=$('#p-selbar');if(!el)return;
  el.hidden=!pSel;if(!pSel)return;
  const n=pPick.length;
  el.innerHTML=`<span>${n===2?'Two photos picked.':n===1?'Pick one more photo.':'Tap two photos to compare them.'}</span>
    <span class="factions"><button class="btn" type="button" data-pa="cmpgo"${n===2?'':' disabled'}>Compare</button><button class="ghost" type="button" data-pa="selcancel">Cancel</button></span>`;
}
function pToggle(id){
  if(pPick.includes(id))pPick=pPick.filter(x=>x!==id);
  else{pPick.push(id);if(pPick.length>2)pPick.shift();}   /* a third pick replaces the first */
  document.querySelectorAll('#p-list .ptile').forEach(t=>{
    const i=pPick.indexOf(+t.dataset.pid), on=i>=0;
    t.classList.toggle('on',on);t.setAttribute('aria-pressed',String(on));
    const b=t.querySelector('.pnum');if(b)b.remove();
    if(on)t.insertAdjacentHTML('beforeend',`<b class="pnum">${i+1}</b>`);
  });
  renderSelBar();
}
function pSetSel(on){
  pSel=on;if(!on)pPick=[];
  const b=$('#p-selbtn');if(b)b.setAttribute('aria-pressed',String(on));
  renderPhotoList();
}
/* scroll to the day with photos closest to the date picked */
function pJump(d){
  const secs=[...document.querySelectorAll('#p-list .pday')];if(!secs.length||!isDate(d))return;
  let best=null,gap=Infinity;
  secs.forEach(s=>{const g=Math.abs(pDayGap(d,s.id.slice(4)));if(g<gap){gap=g;best=s;}});
  best.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  document.querySelectorAll('.pday.hit').forEach(s=>s.classList.remove('hit'));
  best.classList.add('hit');setTimeout(()=>best.classList.remove('hit'),1600);
}


/* Draw a picture smaller as JPEGs, one per longest side asked for (decoded once); createImageBitmap turns phone photos the right way up. */
async function pShrinkAll(file,sizes){
  let bmp;
  try{bmp=await createImageBitmap(file,{imageOrientation:'from-image'});}
  catch{throw new Error(`Couldn’t read “${file.name}” – is it a picture this browser can open (JPEG, PNG, WebP)?`);}
  try{
    const out=[];
    for(const [max,quality] of sizes){
      const k=Math.min(1,max/Math.max(bmp.width,bmp.height)), c=document.createElement('canvas');
      c.width=Math.max(1,Math.round(bmp.width*k));c.height=Math.max(1,Math.round(bmp.height*k));
      const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(bmp,0,0,c.width,c.height);
      const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',quality));
      if(!blob)throw new Error(`Couldn’t shrink “${file.name}”`);
      out.push(blob);
    }
    return out;
  }finally{if(bmp.close)bmp.close();}
}
const pShrink=async(file,max,quality)=>(await pShrinkAll(file,[[max,quality]]))[0];
/* api() sends JSON; the pictures go as they are */
async function pSend(method,url,blob,more={}){
  wrote();try{return await pSend2(method,url,blob,more);}finally{wrote();}
}
async function pSend2(method,url,blob,more){
  let r;
  try{r=await fetch(url,{method,credentials:'same-origin',headers:{'content-type':'image/jpeg','x-csrf-token':csrf,...TZH,...more},body:blob});}
  catch{throw netError();}
  if(r.status===401){setTimeout(toLogin,0);const e=new Error('You were signed out');e.signedOut=true;throw e;}
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||httpText(r.status));
  return j;
}
const pGB=n=>n>=1024**3?(n/1024**3).toFixed(1)+' GB':Math.max(0.1,n/1024**2).toFixed(1)+' MB';
/* what's wrong with the files picked, or '' */
function pTooMany(files){
  const size=files.reduce((t,f)=>t+f.size,0), room=P_MAX_PHOTOS-PHOTOS.length;
  if(size>P_MAX_TOTAL)return `That’s ${pGB(size)} of photos – pick up to 5 GB at a time.`;
  if(files.length>room)return `You can keep ${P_MAX_PHOTOS} photos and have room for ${room} more – pick fewer.`;
  return '';
}
/* each file's date: its own (when asked for and it has one that isn't in the future), else the date picked */
async function pDates(files,fallback,useExif){
  const today=todayStr();
  return Promise.all(files.map(async f=>{
    const d=useExif?await ExifDate.ofFile(f):null;
    return d&&d<=today?{date:d,own:true}:{date:fallback,own:false};
  }));
}
/* The files of an upload that stopped short (the network went, Stop, a reload): name|size|last modified → {k: the key the upload goes
   with (x-photo-key – sent again, the server hands back the photo it made instead of storing it twice), id: the photo once stored,
   t: its thumbnail and middle size are in too}. Kept for this tab in sessionStorage, so Upload sends only the rest, even after a
   reload; dropped once a batch has all gone up. */
const P_SENT='logbook-monster-photo-sent';
let pSent=new Map();
try{pSent=new Map(JSON.parse(sessionStorage.getItem(P_SENT)||'[]'));}catch{}
function pSentKeep(){try{if(pSent.size)sessionStorage.setItem(P_SENT,JSON.stringify([...pSent].slice(-P_MAX_PHOTOS)));else sessionStorage.removeItem(P_SENT);}catch{}}
const pSig=f=>`${f.name}|${f.size}|${f.lastModified}`;
const pKeyNew=()=>crypto.randomUUID?crypto.randomUUID():[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
/* gone up already (and still here): its record, else null */
const pWent=f=>{const e=pSent.get(pSig(f));return e&&e.id&&(!PHOTOS||pById(e.id))?e:null;};
/* the Upload button says "Upload the rest" while some of the files picked went up already */
function pUpLabel(){const b=$('#p-form button[type=submit]'), inp=$('#p-file');if(!b||!inp)return;
  const files=[...inp.files];b.textContent=files.length&&files.some(f=>pWent(f))&&!files.every(f=>{const e=pWent(f);return e&&e.t;})?'Upload the rest':'Upload';}

/* on picking files: how many, how big, how many have their own date */
let pPickTok=0;
async function pPicked(){
  const el=$('#p-pick'), inp=$('#p-file');if(!el||!inp)return;
  const files=[...inp.files], tok=++pPickTok;pUpLabel();
  if(!files.length){el.textContent='';return;}
  const size=files.reduce((t,f)=>t+f.size,0), bad=pTooMany(files.filter(f=>!pWent(f))), went=files.filter(pWent).length;
  let txt=`${files.length} photo${files.length===1?'':'s'}, ${pGB(size)}.`+(went?` ${went===files.length?(went===1?'It':'All of them'):went} went up already – ${went===1?'it':'they'} won’t be sent again.`:'');
  if(bad){el.textContent=txt+' '+bad;return;}
  if(pUseExif){
    el.textContent=txt+' Reading their dates…';
    const ds=await pDates(files,'',true);if(tok!==pPickTok)return;
    const own=ds.filter(d=>d.own), days=new Set(own.map(d=>d.date)).size, none=files.length-own.length;
    if(own.length){const sorted=own.map(d=>d.date).sort();
      txt+=' '+pDot(`${own.length===files.length?(files.length===1?'Taken':'All taken'):own.length+' taken'} ${days===1?'on '+fmtShort(sorted[0]):`over ${days} days, ${fmtShort(sorted[0])} to ${fmtShort(sorted[sorted.length-1])}`}`);}
    if(none)txt+=` ${none===files.length?(none===1?'It has':'None have'):none+(none===1?' has':' have')} no date of ${none===1?'its':'their'} own – ${none===1?'it':'they'}’ll get the date picked.`;
  }
  el.textContent=txt;
}
async function pUpload(form){
  /* the page can be drawn again while this runs (leave Photos and come back): always write to the form on screen now */
  const showErr=t=>{pUpErr=t;const e=$('#p-err');if(e){e.textContent=t;e.hidden=!t;}};
  if(pBusy){showErr('An upload is still running – wait for it to finish, then upload these.');return;}
  const files=[...$('#p-file').files], date=$('#p-date').value, pick=$('#p-pose')?$('#p-pose').value:'other', note=$('#p-note').value.trim();
  const byAi=pick==='ai', pose=byAi?'other':pick, useExif=pUseExif;
  const unset=byAi||pick==='other';                 /* left as Other (the default, and all there is with AI off) – not set by hand, so "Tag poses with AI" takes them later */
  showErr('');
  if(!files.length){showErr('Pick one or more photos.');return;}
  if(!isDate(date)){showErr(useExif?'Pick a date for any photos without one of their own.':'Pick the date the photos were taken.');return;}
  const bad=pTooMany(files.filter(f=>!pWent(f)));if(bad){showErr(bad);return;}
  pBusy=true;pStopUp=false;pDate=date;if(pAi)pUpPose=pick;
  const btn=()=>$('#p-form button[type=submit]'), stopBtn=()=>$('#p-upstop');
  {const b=btn();if(b)b.disabled=true;const s=stopBtn();if(s){s.hidden=false;s.disabled=false;}}
  const n=files.length, many=n>1, fails=[], dates=new Set();
  let added=0, before=0, started=0, aiMiss=0, own=0, stop=null;
  const done=()=>added+before;
  const say=t=>{pUpSay=t;const s=$('#p-state');if(s)s.textContent=t;};
  try{
    say(useExif?'Reading the photos’ dates…':'Uploading…');
    const when=await pDates(files,date,useExif);
    /* a few at a time; one bad picture is skipped, but signing out, a lost server or a full account stops the lot, and Stop
       lets the ones in flight finish */
    const one=async i=>{
      const f=files[i], d=when[i].date, sig=pSig(f);
      try{
        let e=pWent(f);
        if(e&&e.t){before++;dates.add(PHOTOS&&pById(e.id)?pById(e.id).date:d);return;}   /* went up in full before: not sent again */
        if(!e||!e.k){e={k:(pSent.get(sig)||{}).k||pKeyNew()};pSent.set(sig,e);pSentKeep();}
        const [big,mid,small]=await pShrinkAll(f,[[P_MAX,0.86],[P_MID,0.82],[P_THUMB,0.8]]);
        if(stop)return;
        let p=e.id?pById(e.id):null, again=!!p;
        if(!p){
          p=await pSend('POST',`/api/photos?${new URLSearchParams({date:d,pose,...(unset?{ai:'1'}:{})})}`,big,
            {'x-photo-key':e.k,...(note?{'x-photo-note':encodeURIComponent(note)}:{})});   /* the note in a header: never in a logged URL */
          again=!!p.again;delete p.again;
          e.id=p.id;pSentKeep();
        }
        /* the smaller versions: the catalog and the photo page fall back to the full picture while one is missing; a lost
           server stops the batch, and Upload sends what's missing */
        for(const [kind,blob,has] of [['thumb',small,'tv'],['mid',mid,'mv']]){
          if(p[has])continue;
          try{p=await pSend('PUT',`/api/photos/${p.id}/${kind}`,blob);}
          catch(x){if(x.signedOut||x.network)throw x;}
        }
        e.t=!!(p.tv&&p.mv);pSentKeep();
        if(PHOTOS){const k=PHOTOS.findIndex(x=>x.id===p.id);if(k>=0)PHOTOS[k]=p;else PHOTOS.push(p);}   /* null: the list was dropped meanwhile (a range delete) and loads again */
        if(again)before++;else{added++;if(when[i].own)own++;}
        dates.add(p.date);
        if(byAi&&!again){
          try{const a=await pAskAi(p.id,true,p);const k=(PHOTOS||[]).findIndex(x=>x.id===p.id);if(k>=0)PHOTOS[k]=a.photo;}
          catch(x){if(x.signedOut)throw x;aiMiss++;}   /* stays "other", not counted as set by hand */
        }
      }catch(x){
        if(x.signedOut||x.network||/most photos|reached the/.test(x.message))stop=stop||x;
        else fails.push(`${f.name}: ${x.message}`);
      }finally{
        if(many&&!stop)say(`${byAi?'Uploading and tagging':'Uploading'} ${done()+fails.length} of ${n} done…${pStopUp?' Stopping after the photos on their way…':''}`);
      }
    };
    const worker=async()=>{while(!stop&&!pStopUp&&started<n)await one(started++);};
    await Promise.all(Array.from({length:Math.min(P_PARALLEL,n)},worker));
    if(stop&&stop.signedOut)return;
    const left=files.filter(f=>{const e=pWent(f);return !(e&&e.t);}).length;
    /* stored, but a smaller version refused (a full account answers its 413 too): kept, shown from the full picture */
    const unsent=files.filter(f=>!pWent(f)).length, noThumb=left-unsent;
    if(!left){files.forEach(f=>pSent.delete(pSig(f)));pSentKeep();}
    const ds=[...dates].sort();
    pMsg=!added?'':pDot(`Added ${added} photo${added===1?'':'s'} `+(ds.length===1?`for ${fmtLong(ds[0])}`:`over ${ds.length} days, ${fmtShort(ds[0])} to ${fmtShort(ds[ds.length-1])}`)+
      (useExif&&many&&own?` (${own===added?'all':own} dated from the photo${own===1?'':'s'}${own<added?`, ${added-own} on ${fmtShort(date)}`:''})`:''))+
      (before?` ${before} had gone up already.`:'')+
      (aiMiss?` The AI couldn’t tag ${aiMiss===added?(added===1?'it':'them'):aiMiss} – ${aiMiss===1?'it’s':'they’re'} under Other; try “Tag poses with AI” again later or change the pose on the photo.`:'');
    if(!added&&before&&!left)pMsg=`All ${n===1?'of it':n} had gone up already – nothing sent again.`;
    if(stop||fails.length||left){
      showErr((done()?`Added ${done()} of ${n}. `:'')+(stop?pDot(stop.message)+' ':pStopUp&&!fails.length?'Stopped. ':'')+
        (fails.length?`${fails.length} couldn’t be added – ${fails.slice(0,3).join('; ')}${fails.length>3?'; …':''} `:'')+
        (unsent&&unsent>fails.length?`${unsent} not sent yet – tap “Upload the rest”. `:'')+
        (noThumb>0?`${noThumb} ${noThumb===1?'was stored but has':'were stored but have'} no thumbnail yet, so ${noThumb===1?'it loads':'they load'} slowly – “Upload the rest” sends ${noThumb===1?'it':'them'} once there’s room.`:''));
    }
  }catch(x){
    if(x.signedOut)return;
    showErr((done()?`Added ${done()} of ${n}. `:'')+x.message);
  }finally{pBusy=false;pUpSay='';pStopUp=false;}
  /* after anything short of the whole batch, the list again from the server, so what's shown is what's there */
  if(pUpErr){try{await pLoad();}catch(x){if(x.signedOut)return;}}
  pSort();
  if(view!=='photos'||location.hash.replace(/^#/,'').split('/')[1])return;
  const f=$('#p-form');if(!f)return;
  if(!pUpErr){f.reset();$('#p-date').value=pDate;if($('#p-pose'))$('#p-pose').value=pUpPose;$('#p-exif').checked=pUseExif;$('#p-pick').textContent='';
    if(PHOTOS&&PHOTOS.length){pAddOpen=false;const a=$('#p-addbtn');if(a)a.setAttribute('aria-expanded','false');
      const lost=f.contains(document.activeElement)||document.activeElement===document.body;f.hidden=true;if(lost&&a)a.focus();}}   /* focus was in the form just hidden */
  $('#p-state').textContent='';const b=btn();if(b)b.disabled=false;const s=stopBtn();if(s)s.hidden=true;
  pUpLabel();renderPhotoList();
}

/* ---------- one photo ---------- */
/* the page head: back to the catalog in words, so it isn't the same ‹ as "Older photo" beside it */
const pHead=(title,extra)=>`<div class="gbar"><a class="ghost pback" href="#photos">← Photos</a><h2>${esc(title)}</h2>${extra||''}</div>`;
/* A photo in a zoom frame: its width and height go on the frame (pSize), so the page keeps the photo's room before it loads, and
   the middle size is picked (srcset) unless the slot needs more – the full picture loads only once zoomed in (pZoomSet). */
const P_ZHINT='Zoom with + and − or the mouse wheel; drag to move around, double-click to fit.';
function pFigure(p,href,cls,more,hint=true){
  const sized=p.w>0&&p.h>0, k=sized?Math.min(1,P_MID/Math.max(p.w,p.h)):1;
  const set=sized&&p.mv?`${pMid(p)} ${Math.round(p.w*k)}w, ${pSrc(p)} ${p.w}w`:'';
  return `<a class="pzoom${cls?' '+cls:''}" href="${href}"${href.startsWith('#')?'':' target="_blank" rel="noopener"'}${sized?` data-w="${p.w}" data-h="${p.h}"`:''}>`+
    `<img src="${pMid(p)}"${set?` data-srcset="${esc(set)}"`:''} data-full="${pSrc(p)}"${sized?` width="${p.w}" height="${p.h}"`:''} alt="${esc(pLabel(p)+' photo, '+fmtLong(p.date))}"${more||''}></a>
    <div class="pzbar"><button class="ghost" type="button" data-pa="zout" aria-label="Zoom out" disabled>−</button><button class="ghost" type="button" data-pa="zin" aria-label="Zoom in">+</button><button class="ghost" type="button" data-pa="zfit" disabled>Fit</button>
      ${hint?`<span class="sub">${P_ZHINT}</span>`:''}</div>`;
}
/* each frame's shape from its photo's size, and the size to load for the room it has (before the pictures are asked for) */
function pSize(root){
  root.querySelectorAll('.pzoom[data-w]').forEach(z=>{
    const w=+z.dataset.w, h=+z.dataset.h;
    z.style.setProperty('--ar',String(w/h));z.style.setProperty('--nw',String(w));z.classList.add('sized');
  });
  root.querySelectorAll('.pzoom img[data-srcset]').forEach(i=>{
    const slot=Math.max(1,Math.round(i.closest('.pzoom').clientWidth||i.closest('figure').clientWidth||P_MID));
    i.sizes=slot+'px';i.srcset=i.dataset.srcset;
  });
}
function pOnePage(p){
  const list=pShown(), i=list.indexOf(p);
  const newer=i>0?list[i-1]:null, older=i>=0&&i<list.length-1?list[i+1]:null;
  const nav=`<span class="pnav">${older?`<a class="nav" href="#photos/${older.id}" aria-label="Older photo">‹</a>`:''}${newer?`<a class="nav" href="#photos/${newer.id}" aria-label="Newer photo">›</a>`:''}</span>`;
  return pHead(`${pLabel(p)} · ${fmtShort(p.date)}`,nav)+`
    <figure class="pbig">${pFigure(p,pSrc(p),'',' fetchpriority="high"')}
      <figcaption>${esc(fmtLong(p.date))}${pKg(p.date)?' · '+esc(pKg(p.date)):''}${p.note?' · '+esc(p.note):''}</figcaption></figure>
    <form id="p-eform" class="panel sform" data-id="${p.id}" data-ver="${esc(p.updated||'')}">
      <label class="f"><span class="lbl">Date taken</span><input id="p-edate" type="date" required value="${esc(p.date)}" max="${todayStr()}"></label>
      <label class="f"><span class="lbl">Pose</span><select id="p-epose">${pPoseOptions(p.pose)}</select></label>
      <label class="f"><span class="lbl">Pose type</span><select id="p-estyle">${pStyleOptions(p.style)}</select></label>
      ${pAi?`<div class="factions"><button class="ghost" type="button" data-pa="aione" data-id="${p.id}" title="${esc(P_AI_NOTE)}">Ask AI for the pose</button><span id="p-aisay" class="sub" role="status"></span></div>`:''}
      <label class="f swide"><span class="lbl">Note (optional)</span><input id="p-enote" maxlength="200" value="${esc(p.note)}"></label>
      <p id="p-eerr" class="aderr swide" role="alert" hidden></p>
      <div class="factions swide"><button class="btn" type="submit">Save changes</button>
        <button class="ghost" type="button" data-pa="withthis" data-id="${p.id}">Compare with…</button>
        <a class="ghost" href="${pSrc(p)}" download="${esc(`progress-${p.date}-${p.pose}.jpg`)}">Download</a>
        <button class="ghost fdel" type="button" data-pa="del" data-id="${p.id}">Delete</button></div>
    </form>`;
}
/* A photo from before middle sizes (or one whose middle size didn't go up): made from the full picture once it's on screen, so the
   next look – and the coach's day card – loads the smaller one. Quietly: a failure leaves it as it was. */
const pMidBusy=new Set();
async function pMakeMid(p){
  if(p.mv&&p.tv||pMidBusy.has(p.id)||!p.v)return;
  pMidBusy.add(p.id);
  try{
    const b=await(await fetch(pSrc(p),{credentials:'same-origin'})).blob();
    const [mid,small]=await pShrinkAll(b,[[P_MID,0.82],[P_THUMB,0.8]]);
    let q=p;
    if(!q.mv)q=await pSend('PUT',`/api/photos/${p.id}/mid`,mid);
    if(!q.tv)q=await pSend('PUT',`/api/photos/${p.id}/thumb`,small);
    const k=(PHOTOS||[]).findIndex(x=>x.id===p.id);if(k>=0)PHOTOS[k]={...PHOTOS[k],mv:q.mv,tv:q.tv};
  }catch{}finally{pMidBusy.delete(p.id);}
}
async function pSave(form){
  const err=$('#p-eerr'), id=+form.dataset.id, btn=form.querySelector('button[type=submit]');
  btn.disabled=true;err.hidden=true;
  try{
    const pose=$('#p-epose').value, style=$('#p-estyle').value, said=form.dataset.ai?JSON.parse(form.dataset.ai):null;
    const p=await api('PUT','/api/photos/'+id,{date:$('#p-edate').value,pose,style,note:$('#p-enote').value,   /* the AI's answer, kept: still the AI's */
      ...(said&&said.pose===pose&&said.style===style?{ai:true}:{})},form.dataset.ver||undefined);
    PHOTOS=PHOTOS.filter(x=>x.id!==id);PHOTOS.push(p);pSort();
    pDirty=false;pMsg='Saved.';go('photos');
  }catch(e){btn.disabled=false;if(e.signedOut)return;
    if(e.conflict){
      /* changed in another tab: take its version and keep what's typed here, so Save works again once checked */
      try{await pLoad();}catch(x){if(x.signedOut)return;}
      const q=pById(id);
      if(q){form.dataset.ver=q.updated||'';err.textContent='Changed elsewhere – check and save again.';}
      else err.textContent='This photo was deleted in another tab or device.';
      err.hidden=false;return;
    }
    if(/No such/.test(e.message))pLoad().catch(()=>{});
    if(!errToField(e,[[/date|day/i,$('#p-edate')],[/note/i,$('#p-enote')]])){err.textContent=endStop(e.message);err.hidden=false;}}
}
async function pDelete(id){
  const p=pById(id);if(!p)return;
  if(!await ask(`Delete this ${(pPoseName(p.pose)).toLowerCase()} photo from ${fmtLong(p.date)}? This can’t be undone.`,{yes:'Delete photo',no:'Keep it',danger:true})||!pById(id))return;
  try{await api('DELETE','/api/photos/'+id);}catch(e){if(!e.signedOut)noteBy(document.querySelector(`[data-pa=del][data-id="${id}"]`)||null,'Couldn’t delete the photo: '+endStop(e.message));return;}
  PHOTOS=PHOTOS.filter(x=>x.id!==id);pPick=pPick.filter(x=>x!==id);pDirty=false;pMsg='Deleted the photo.';pFocusAdd=true;go('photos');
}


/* untagged: still under Other with no pose type, and not put there by hand (uploads with no pose picked go in like this) nor by the
   AI (aiSaw: it already looked and said Other), or an older photo that says only Side, not which side */
const pUntagged=p=>p.poseAi&&!p.aiSaw&&p.pose==='other'&&!p.style||p.pose==='side';
/* "Tag poses with AI": the AI sets the pose of the photos the catalog shows (so pick Other first to sort only those).
   Poses the person set themselves (poseAi false) are redone only if they say so. "Tag only untagged" (onlyNew) skips
   every photo that already has a pose or pose type, whoever set it – except an older plain Side, which needs a left or right. */
async function pAiTagAll(onlyNew){
  if(pAiBusy)return;
  let list=pShown();if(!list.length)return;
  if(onlyNew){
    list=list.filter(pUntagged);
    if(!list.length){pMsg='Every photo shown already has a pose, so there’s nothing for the AI to tag.';renderPhotoList();return;}
  }
  const mine=list.filter(p=>!p.poseAi).length;
  /* either answer goes on to the next question: "leave them" only takes those photos out of the run */
  if(mine&&!await ask(`${mine===list.length?(mine===1?'The photo':`All ${mine} photos`):`${mine} of the ${list.length} photos`} shown ${mine===1?'has a pose':'have poses'} you set yourself. Let the AI redo ${mine===1?'that':'those'} too?`,
    {title:'Poses you set yourself',yes:`Redo ${mine===1?'it':'them'} too`,no:`Leave ${mine===1?'it as it is':'them as they are'}`})){
    list=list.filter(p=>p.poseAi);
    if(!list.length){pMsg='Every photo shown has a pose you set yourself, so there’s nothing for the AI to tag.';renderPhotoList();return;}
  }
  if(!await ask(`Let the AI look at ${list.length===1?'this photo':`these ${list.length} photos`} and set ${list.length===1?'its':'their'} pose (front, left or right side, back or other) and pose type (relaxed, double biceps, most muscular…)?\n\n${P_AI_NOTE}`,
    {title:'Tag poses with AI',yes:`Tag ${list.length===1?'it':list.length+' photos'}`,no:'Not now'}))return;
  if(pAiBusy)return;   /* started from another button while this asked */
  pAiBusy=true;pStopAi=false;pMsg='';
  /* the page can be drawn again meanwhile: the buttons and the status line are looked up each time */
  const show=()=>{['#p-aibtn','#p-aiuntag'].forEach(x=>{const b=$(x);if(b)b.disabled=true;});
    const st=$('#p-aistop');if(st){st.hidden=false;st.disabled=pStopAi;}const l=$('#p-aistate');if(l)l.textContent=pAiSay;};
  let done=0, changed=0, miss=0, kept=0, why='';
  try{
    for(const p of list){
      if(pStopAi)break;
      pAiSay=`Tagging ${done+1} of ${list.length}…`;show();
      /* a photo edited (or deleted) here since the run started is left as it is now; the server checks edits from other tabs */
      const cur=pById(p.id);
      if(!cur||cur.pose!==p.pose||(cur.style||'')!==(p.style||'')){kept++;done++;continue;}
      try{
        const a=await pAskAi(p.id,true,p);
        if(a.saved===false)kept++;
        else if(a.photo.pose!==p.pose||a.photo.style!==p.style)changed++;
        const i=PHOTOS.findIndex(x=>x.id===p.id);if(i>=0)PHOTOS[i]=a.photo;
      }catch(e){if(e.signedOut)return;miss++;why=e.message;if(/OpenRouter|API key|wait a while|set up/.test(why)||[429,502,503].includes(e.status))break;}   /* the same for the rest */
      done++;
    }
    pMsg=`The AI looked at ${done-miss-kept} photo${done-miss-kept===1?'':'s'} and changed the pose of ${changed}.`+(kept?` ${kept} changed by you during the run ${kept===1?'was':'were'} left as you set ${kept===1?'it':'them'}.`:'')+(miss?` ${pDot(`${miss} couldn’t be tagged: ${why}`)}`:'')+(done<list.length?` ${pStopAi?'Stopped – ':'Stopped before the last '}${pStopAi?`${list.length-done} not tagged.`:`${list.length-done}.`}`:'');
  }finally{pAiBusy=false;pStopAi=false;pAiSay='';}
  if(view==='photos'&&!location.hash.replace(/^#/,'').split('/')[1]){
    const a=$('#p-aibtn'), u=$('#p-aiuntag'), st=$('#p-aistop'), l=$('#p-aistate');
    if(a)a.disabled=!PHOTOS.length;
    if(u)u.disabled=!PHOTOS.some(pUntagged);
    if(st)st.hidden=true;
    if(l)l.textContent='';
    renderPhotoList();
  }
}
async function pAiOne(b){
  const say=$('#p-aisay'), form=b.closest('form'), id=+b.dataset.id;b.disabled=true;say.textContent='Asking the AI…';
  /* the answer belongs to this photo's form: dropped if the person has moved to another photo (or left) meanwhile */
  const here=()=>form&&form.isConnected&&+form.dataset.id===id;
  try{
    const a=await pAskAi(id,false);
    if(!here())return;
    const sel=$('#p-epose'), st=$('#p-estyle');if(!sel||!st)return;
    const p=pById(id), said=pLabel(a);
    sel.value=a.pose;st.value=a.style||'';form.dataset.ai=JSON.stringify({pose:a.pose,style:a.style||''});
    say.textContent=p&&a.pose===p.pose&&(a.style||'')===p.style?`The AI agrees: ${said}.`:`The AI says ${said} – tap Save changes to keep it.`;
  }catch(e){if(!e.signedOut&&here())say.textContent=e.message;}
  finally{b.disabled=false;}
}

/* ---------- two photos side by side ---------- */
/* Pick from the catalog (#photos/compare/12/34), or here: either side from a list, and "match weight" finds
   the photo of the same pose, from another day, when you weighed closest to the other side's day. */
function pDefaultPair(){
  const latest=PHOTOS[0];if(!latest)return [0,0];
  const same=PHOTOS.filter(p=>p.pose===latest.pose&&p.date!==latest.date);
  const first=same.length?same[same.length-1]:PHOTOS.find(p=>p.id!==latest.id);
  return [first?first.id:0,latest.id];
}
function pCmpPage(x,y){
  if(PHOTOS.length<2)return gEmpty('Upload two or more photos to compare them.');
  let a=pById(x),b=pById(y);
  if(!a||!b||a===b){[x,y]=pDefaultPair();a=pById(x);b=pById(y);}
  if(a.date>b.date||(a.date===b.date&&a.id>b.id))[a,b]=[b,a];      /* older on the left */
  const ws=pWeights(), wa=pWeightOn(a.date,ws), wb=pWeightOn(b.date,ws);
  const opts=sel=>PHOTOS.map(p=>`<option value="${p.id}"${p===sel?' selected':''}>${esc(pYmd(p.date))} · ${esc(pLabel(p))}${pWeightOn(p.date,ws)?' · '+esc(pKgTxt(pWeightOn(p.date,ws))):''}</option>`).join('');
  const side=(p,w,k,other,ow)=>`<figure class="pside">
      <div class="pcpick"><label class="f"><span class="lbl">${k==='a'?'Before':'After'}</span><select id="p-c${k}" data-other="${other.id}">${opts(p)}</select></label>
        <button class="ghost" type="button" data-pa="cmpshow" data-for="p-c${k}" hidden>Show</button></div>
      ${pFigure(p,'#photos/'+p.id,'','',false)}
      <figcaption><b>${esc(pYmd(p.date))}</b> · ${esc(pLabel(p))}${w?' · '+esc(pKgTxt(w)):''}${p.note?`<br>${esc(p.note)}`:''}</figcaption>
      <button class="ghost" type="button" data-pa="match" data-keep="${other.id}" data-drop="${p.id}"${ow?'':' disabled'} title="Swap this side for the ${esc(pPoseName(other.pose).toLowerCase())} photo from another day when you weighed closest to that">${ow?`Find one at ${esc(ow.kg)} kg`:'No weigh-in to match'}</button></figure>`;
  const gap=pDayGap(a.date,b.date), sum=[gap?`${gap} day${gap===1?'':'s'} apart`:'Same day'];
  if(wa&&wb){const d=Math.round((wb.kg-wa.kg)*10)/10;sum.push(d?`${d>0?'+':''}${d} kg`:'same weight');}
  return `<div class="gbar"><h2>Compare</h2><button class="ghost" type="button" data-pa="repick">Pick in the catalog</button></div>
    <p class="note" id="p-cmpsum">${esc(sum.join(' · '))}</p>
    <div class="pcmp" id="p-cmp">${side(a,wa,'a',b,wb)}${side(b,wb,'b',a,wa)}</div>
    <p class="sub pzhint">${P_ZHINT}</p>
    ${pMsg?`<p class="note fmsg" role="status">${esc(pMsg)}</p>`:''}`;
}
/* Picking another photo in a Before / After list: with the mouse or a finger it shows at once; from the keyboard (arrow keys move
   through the list) only on Enter or "Show", so each arrow press doesn't load a photo and redraw the page (WCAG 3.2.2). The page
   is drawn again in place, focus back on the list that was used. */
let pCmpPtr=null;   /* the list last pressed with a pointer */
async function pCmpApply(sel){
  const keep=+sel.dataset.other, pickId=+sel.value;
  if(!pickId)return;
  pMsg='';
  history.replaceState(null,'',`#photos/compare/${pickId}/${keep}`);
  await renderPhotos(['compare',pickId,keep]);
  const again=[...document.querySelectorAll('#p-cmp select')].find(x=>+x.value===pickId);
  if(again)again.focus();
}
/* the photo, of the same pose and from another day, whose day's weight is closest to the kept photo's */
function pMatch(keepId,dropId){
  const keep=pById(keepId);if(!keep)return;
  const ws=pWeights(), w=pWeightOn(keep.date,ws);
  if(!w){pMsg=`No weigh-in within ${P_NEAR_DAYS} days of ${pYmd(keep.date)} to match.`;go(`photos/compare/${keepId}/${dropId}`);return;}
  let best=null;
  PHOTOS.forEach(p=>{
    if(p.pose!==keep.pose||p.date===keep.date)return;
    const pw=pWeightOn(p.date,ws);if(!pw)return;
    const diff=Math.abs(pw.kg-w.kg), far=Math.abs(pDayGap(keep.date,p.date));
    if(!best||diff<best.diff-1e-9||(Math.abs(diff-best.diff)<1e-9&&far>best.far))best={p,diff,far};   /* ties: the furthest apart in time */
  });
  if(!best){pMsg=`No other ${pPoseName(keep.pose).toLowerCase()} photo on a day with a weigh-in.`;go(`photos/compare/${keepId}/${dropId}`);return;}
  pMsg='';go(`photos/compare/${keepId}/${best.p.id}`);
}

/* ---------- zoom on a photo (one photo, and each side of Compare) ----------
   The mouse wheel, or the + and − buttons under the photo, zoom in and out (around the pointer, or the middle) from 1× to 8×; while
   zoomed in, dragging moves the view and a double-click (or Fit) goes back to the whole photo. Clicking the photo opens it only when
   it isn't zoomed. Zoomed in, the full picture takes the place of the middle size. */
const pZs=new WeakMap();   /* frame → {box, img, s, x, y}; a new page makes new frames */
let pZ=null;               /* the one being dragged */
const P_ZMAX=8;
function pZoomOf(box){
  let z=pZs.get(box);
  if(!z)pZs.set(box,z={box,img:box.querySelector('img'),s:1,x:0,y:0,drag:null,moved:false});
  return z;
}
function pZoomSet(z,s,x,y){
  const w=z.box.clientWidth, h=z.box.clientHeight;
  s=Math.min(P_ZMAX,Math.max(1,s));
  z.s=s;z.x=Math.min(0,Math.max(w-w*s,x));z.y=Math.min(0,Math.max(h-h*s,y));   /* the photo always fills the frame */
  z.img.style.transform=s===1?'':`translate(${z.x}px,${z.y}px) scale(${s})`;
  z.box.classList.toggle('zoomed',s>1);
  if(s>1&&z.img.dataset.full&&!z.img.dataset.big){z.img.dataset.big='1';z.img.removeAttribute('srcset');z.img.src=z.img.dataset.full;}
  const bar=z.box.nextElementSibling;
  if(bar&&bar.classList.contains('pzbar')){
    bar.querySelector('[data-pa=zout]').disabled=s<=1;bar.querySelector('[data-pa=zfit]').disabled=s<=1;bar.querySelector('[data-pa=zin]').disabled=s>=P_ZMAX;
  }
}
/* the + and − buttons: 1.5× in or out around the middle of the frame */
function pZoomBy(box,f){
  const z=pZoomOf(box), cx=box.clientWidth/2, cy=box.clientHeight/2, s=f?Math.min(P_ZMAX,Math.max(1,z.s*f)):1;
  pZoomSet(z,s,f?cx-(cx-z.x)*s/z.s:0,f?cy-(cy-z.y)*s/z.s:0);
}
document.addEventListener('wheel',e=>{
  const box=view==='photos'&&e.target.closest('.pzoom');if(!box||e.ctrlKey)return;   /* ctrl+wheel stays the browser's page zoom */
  e.preventDefault();
  const z=pZoomOf(box), r=box.getBoundingClientRect(), cx=e.clientX-r.left, cy=e.clientY-r.top;
  const dy=e.deltaMode===1?e.deltaY*16:e.deltaMode===2?e.deltaY*r.height:e.deltaY;
  const s=Math.min(P_ZMAX,Math.max(1,z.s*Math.exp(-dy/300)));
  pZoomSet(z,s,cx-(cx-z.x)*s/z.s,cy-(cy-z.y)*s/z.s);    /* the point under the pointer stays put */
},{passive:false});
document.addEventListener('pointerdown',e=>{
  const box=view==='photos'&&e.target.closest('.pzoom');if(!box||e.button!==0)return;
  const z=pZoomOf(box);z.moved=false;
  if(z.s===1)return;
  e.preventDefault();
  pZ=z;z.drag={id:e.pointerId,px:e.clientX,py:e.clientY,x:z.x,y:z.y};
  box.setPointerCapture(e.pointerId);box.classList.add('grab');
});
document.addEventListener('pointermove',e=>{
  const z=pZ;if(!z||!z.drag||z.drag.id!==e.pointerId)return;
  const dx=e.clientX-z.drag.px, dy=e.clientY-z.drag.py;
  if(Math.abs(dx)+Math.abs(dy)>3)z.moved=true;
  pZoomSet(z,z.s,z.drag.x+dx,z.drag.y+dy);
});
const pDragEnd=e=>{const z=pZ;if(!z||!z.drag||z.drag.id!==e.pointerId)return;z.drag=null;z.box.classList.remove('grab');};
document.addEventListener('pointerup',pDragEnd);
document.addEventListener('pointercancel',pDragEnd);
document.addEventListener('dblclick',e=>{
  const box=view==='photos'&&e.target.closest('.pzoom');if(!box)return;
  e.preventDefault();pZoomSet(pZoomOf(box),1,0,0);
});
document.addEventListener('dragstart',e=>{if(view==='photos'&&e.target.closest('.pzoom'))e.preventDefault();});

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  if(view!=='photos')return;
  const zb=e.target.closest('.pzoom');
  if(zb){const z=pZoomOf(zb);if(z.s>1||z.moved||e.detail>1){e.preventDefault();z.moved=false;}return;}   /* zoomed, dragged or a double-click: don't open it */
  const t=pSel&&e.target.closest('#p-list .ptile');
  if(t){e.preventDefault();pToggle(+t.dataset.pid);return;}
  const b=e.target.closest('[data-pa]');if(!b)return;
  const a=b.dataset.pa;
  if(a==='filter'){pPose=b.dataset.v;pMsg='';document.querySelectorAll('[data-pa=filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderPhotoList();}
  else if(a==='del')once(b,()=>pDelete(+b.dataset.id));
  else if(a==='select'){pMsg='';pSetSel(!pSel);}
  else if(a==='selcancel')pSetSel(false);
  else if(a==='cmpgo'&&pPick.length===2){const [x,y]=pPick;pSel=false;pPick=[];pMsg='';go(`photos/compare/${x}/${y}`);}
  else if(a==='repick'){const s=[...document.querySelectorAll('#p-cmp select')].map(x=>+x.value);pSel=true;pPick=s;pMsg='';go('photos');}
  else if(a==='withthis'){pSel=true;pPick=[+b.dataset.id];pMsg='';go('photos');}
  else if(a==='match')pMatch(+b.dataset.keep,+b.dataset.drop);
  else if(a==='aitag')pAiTagAll(false);
  else if(a==='aiuntag')pAiTagAll(true);
  else if(a==='aione')pAiOne(b);
  else if(a==='add')pAddToggle();
  else if(a==='upstop'){pStopUp=true;b.disabled=true;const s=$('#p-state');if(s)s.textContent=pUpSay=(pUpSay||'Uploading…').replace(/ Stopping.*$/,'')+' Stopping after the photos on their way…';}
  else if(a==='aistop'){pStopAi=true;b.disabled=true;const s=$('#p-aistate');if(s)s.textContent=pAiSay=pAiSay+' Stopping after this one…';}
  else if(a==='zin'||a==='zout'||a==='zfit'){const box=b.closest('.pzbar').previousElementSibling;if(box&&box.classList.contains('pzoom'))pZoomBy(box,a==='zin'?1.5:a==='zout'?1/1.5:0);}
  else if(a==='cmpshow'){const sel=document.getElementById(b.dataset.for);if(sel)pCmpApply(sel);}
});
/* keys: Space (as well as Enter) picks a photo while picking two to compare – the tiles are links; Enter on a Before / After list
   shows the photo picked */
document.addEventListener('keydown',e=>{
  if(view!=='photos')return;
  const t=e.target;
  if(pSel&&(e.key===' '||e.key==='Spacebar')&&t.matches&&t.matches('#p-list .ptile')){e.preventDefault();pToggle(+t.dataset.pid);return;}
  if((t.id==='p-ca'||t.id==='p-cb')){pCmpPtr=null;if(e.key==='Enter'){e.preventDefault();pCmpApply(t);}}
});
document.addEventListener('pointerdown',e=>{if(view==='photos'&&(e.target.id==='p-ca'||e.target.id==='p-cb'))pCmpPtr=e.target;},true);
document.addEventListener('change',e=>{
  if(view!=='photos')return;
  const id=e.target.id;
  if(id==='p-ca'||id==='p-cb'){
    if(pCmpPtr===e.target){pCmpPtr=null;pCmpApply(e.target);return;}
    const b=document.querySelector(`[data-pa=cmpshow][data-for="${id}"]`);if(b)b.hidden=false;
  }
  else if(id==='p-jump')pJump(e.target.value);
  else if(id==='p-file')pPicked();
  else if(id==='p-exif'){pUseExif=e.target.checked;const l=$('#p-date').closest('label').querySelector('.lbl');l.textContent=pUseExif?'Date if a photo has none':'Date taken';pPicked();}
  else if(id==='p-near'){pNear=e.target.checked;pMsg='';renderPhotoList();}
  else if(id==='p-tol'){pTol=+e.target.value;if(pNear)renderPhotoList();}
});
document.addEventListener('input',e=>{
  if(view==='photos'&&e.target.id==='p-nearkg'){pNearKg=e.target.value;if(pNear)renderPhotoList();}
  if(view==='photos'&&e.target.closest&&e.target.closest('#p-eform')){pDirty=true;pKeepDraft();}
});
/* An unsaved change to a photo's details isn't dropped by leaving the page (p5-photos-11): a link away asks first; Back, Forward or
   anything else that changes the address puts the photo page back, with the changes, and asks there; closing or reloading the tab
   asks too. pDraft: the form as changed, for putting it back. */
let pDraft=null;
const pAsk=t=>ask(t,{title:'Unsaved changes',yes:'Leave without saving',no:'Stay',danger:true});
const P_LEAVE='You changed this photo’s details without saving. Leave without saving them?';
function pKeepDraft(){const f=$('#p-eform');if(f)pDraft={id:+f.dataset.id,hash:location.hash,ai:f.dataset.ai||'',v:['#p-edate','#p-epose','#p-estyle','#p-enote'].map(x=>$(x).value)};}
document.addEventListener('click',e=>{
  if(!pDirty||view!=='photos'||e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey)return;
  const a=e.target.closest&&e.target.closest('a[href^="#"]');
  if(!a||!$('#p-eform')||a.getAttribute('href')===location.hash||a.closest('.pzoom'))return;
  e.preventDefault();e.stopImmediatePropagation();
  pAsk(P_LEAVE).then(yes=>{if(yes){pDirty=false;location.hash=a.getAttribute('href');}});
},true);
window.addEventListener('hashchange',async e=>{
  if(!pDirty||!pDraft||!e.oldURL)return;
  const from=new URL(e.oldURL).hash, to=location.hash;
  if(from===to||from!==pDraft.hash)return;
  pDirty=false;const d=pDraft;
  history.replaceState(null,'',from);route();
  for(let i=0;i<100&&!$(`#p-eform[data-id="${d.id}"]`);i++)await new Promise(r=>setTimeout(r,20));
  const f=$(`#p-eform[data-id="${d.id}"]`);if(!f)return;
  ['#p-edate','#p-epose','#p-estyle','#p-enote'].forEach((x,i)=>{$(x).value=d.v[i];});if(d.ai)f.dataset.ai=d.ai;
  pDirty=true;pDraft=d;
  if(await pAsk(P_LEAVE)){pDirty=false;location.hash=to;}
});
window.addEventListener('beforeunload',e=>{if(pDirty&&view==='photos'&&$('#p-eform')){e.preventDefault();e.returnValue='';}});
document.addEventListener('submit',e=>{
  if(e.target.id==='p-form'){e.preventDefault();pMsg='';pUpload(e.target);}
  else if(e.target.id==='p-eform'){e.preventDefault();pSave(e.target);}
});
