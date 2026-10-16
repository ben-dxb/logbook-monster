'use strict';
/* Progress photos: upload pictures, each with the date it was taken, a pose (front, side, back, other) and
   an optional note, and look back through them by date or side by side.
   #photos (the catalog, newest day first: filter by pose or by bodyweight, jump to a date, pick two to compare),
   #photos/12 (one photo: view, change, delete), #photos/compare/12/34 (two photos side by side, older on the left).
   Pictures are shrunk to a JPEG in the browser before upload (which also drops the EXIF data, location
   included) and a small thumbnail is sent after it for the catalog. Uses helpers from app.js and gym.js (gHead, gEmpty). */

let PHOTOS=null, PPOSES=['front','side','back','other'], PWT={};
let pPose='all', pDate=todayStr(), pUpPose='front', pMsg='', pTok=0, pBusy=false;
let pSel=false, pPick=[];                          /* picking photos to compare, and the ones picked (up to 2) */
let pNear=false, pNearKg='', pTol=1;              /* only days when you weighed about the same: around pNearKg (blank = your latest weigh-in), ± pTol kg */
const P_MAX=2000, P_THUMB=480;                     /* longest side in pixels: the photo, the thumbnail */
const P_NAME={front:'Front',side:'Side',back:'Back',other:'Other'}, P_TOLS=[0.5,1,2,3];
const P_NEAR_DAYS=3;                               /* a day without a weigh-in takes the closest one this many days either side */

const pById=id=>PHOTOS&&PHOTOS.find(p=>p.id===id);
const pSrc=p=>`/api/photos/${p.id}/file?v=${encodeURIComponent(p.v)}`;
const pThumb=p=>p.tv?`/api/photos/${p.id}/thumb?v=${encodeURIComponent(p.tv)}`:pSrc(p);
const pPoseName=p=>P_NAME[p]||p;
function pSort(){PHOTOS.sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);}
async function pLoad(){
  const [r,w]=await Promise.all([api('GET','/api/photos'),api('GET','/api/weights')]);
  PHOTOS=(r&&r.photos)||[];if(r&&r.poses)PPOSES=r.poses;pSort();
  PWT={};(w||[]).forEach(x=>{PWT[x.date]=x.kg;});
}
const pYmd=d=>parse(d).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
const pDayGap=(a,b)=>Math.round((parse(b)-parse(a))/864e5);

/* ---------- bodyweight ---------- */
/* every weigh-in, oldest first: the ones loaded here plus any logged since (WEIGHTS in app.js) */
function pWeights(){
  const all={...PWT};Object.keys(WEIGHTS).forEach(d=>{if(WEIGHTS[d]!=null)all[d]=WEIGHTS[d];});
  return Object.keys(all).sort().map(d=>({date:d,kg:all[d]}));
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
    if(/^\d+$/.test(a||'')){
      const p=pById(+a);
      box.innerHTML=p?pOnePage(p):gHead('#photos','Photo')+gEmpty('That photo isn’t here any more.');return;
    }
    if(cmp){box.innerHTML=tabs+pCmpPage(+x||0,+y||0);return;}
    box.innerHTML=tabs+pCatalogPage();renderPhotoList();
  }catch(e){if(!e.signedOut&&tok===pTok)box.innerHTML=tabs+gEmpty('Couldn’t load your photos: '+esc(e.message));}
}

/* ---------- the catalog: upload, then every day with photos, newest first ---------- */
function pPoseOptions(sel){return PPOSES.map(v=>`<option value="${v}"${v===sel?' selected':''}>${esc(pPoseName(v))}</option>`).join('');}
function pCatalogPage(){
  const seg=[['all','All'],...PPOSES.map(v=>[v,pPoseName(v)])].map(([v,l])=>`<button type="button" data-pa="filter" data-v="${v}" aria-pressed="${pPose===v}">${esc(l)}</button>`).join('');
  const days=[...new Set(PHOTOS.map(p=>p.date))], latest=pLatest();
  const tols=P_TOLS.map(t=>`<option value="${t}"${t===pTol?' selected':''}>± ${t} kg</option>`).join('');
  return `<div class="gbar"><h2>Progress photos</h2></div>
    <form id="p-form" class="panel sform">
      <label class="f swide"><span class="lbl">Photos</span><input id="p-file" type="file" accept="image/*" multiple required></label>
      <label class="f"><span class="lbl">Date taken</span><input id="p-date" type="date" required value="${pDate}" max="${todayStr()}"></label>
      <label class="f"><span class="lbl">Pose</span><select id="p-pose">${pPoseOptions(pUpPose)}</select></label>
      <label class="f swide"><span class="lbl">Note (optional)</span><input id="p-note" maxlength="200" placeholder="e.g. morning, fasted, after the cut"></label>
      <p id="p-err" class="aderr swide" role="alert" hidden></p>
      <div class="factions swide"><button class="btn" type="submit">Upload</button><span id="p-state" class="sub" role="status"></span></div>
      <p class="sub swide">Only you can see your photos. They’re made smaller before upload and the camera’s details, location included, are left out.</p>
    </form>
    <div class="ptools">
      <div class="seg" role="group" aria-label="Pose">${seg}</div>
      <div class="prow">
        <label class="f pjump"><span class="lbl">Jump to date</span><input id="p-jump" type="date"${days.length?` min="${days[days.length-1]}" max="${days[0]}"`:' disabled'}></label>
        <button class="ghost" type="button" data-pa="select" id="p-selbtn" aria-pressed="${pSel}"${PHOTOS.length<2?' disabled':''}>Compare two photos</button>
      </div>
      <div class="prow pweight">
        <label class="tog"><input type="checkbox" id="p-near"${pNear?' checked':''}${latest?'':' disabled'}> Same weight as</label>
        <label class="f"><span class="lbl">Weight kg</span><input id="p-nearkg" type="number" inputmode="decimal" min="20" max="400" step="0.1" value="${esc(pNearKg)}" placeholder="${latest?latest.kg:''}"${latest?'':' disabled'}></label>
        <label class="f"><span class="lbl">Within</span><select id="p-tol"${latest?'':' disabled'}>${tols}</select></label>
        <span class="sub">${latest?`Your latest weigh-in: <b>${esc(latest.kg)} kg</b> on ${esc(fmtShort(latest.date))}.`:'Log your weight on the Weight page to filter photos by bodyweight.'}</span>
      </div>
    </div>
    <div id="p-selbar" class="psel" role="status"${pSel?'':' hidden'}></div>
    <div id="p-list" class="pdays"></div>`;
}
function renderPhotoList(){
  const el=$('#p-list');if(!el)return;
  const list=pShown(), t=pTarget();
  let h=pMsg?`<p class="note fmsg" role="status">${esc(pMsg)}</p>`:'';
  const days={};list.forEach(p=>{(days[p.date]=days[p.date]||[]).push(p);});
  const n=Object.keys(days).length;
  if(pNear&&t!=null)h+=`<p class="note">${n?`${n} day${n===1?'':'s'}`:'No days'} with photos when you weighed ${esc(t)} kg ± ${esc(pTol)} (from a weigh-in within ${P_NEAR_DAYS} days of the photo).</p>`;
  if(!PHOTOS.length)h+=gEmpty('No photos yet. Pick some above, set the date they were taken and tap Upload.');
  else if(!list.length&&!pNear)h+=gEmpty(`No ${esc(pPoseName(pPose).toLowerCase())} photos yet.`);
  h+=Object.keys(days).sort().reverse().map(d=>`<section class="pday" id="p-d-${d}" aria-label="${esc(fmtLong(d))}">
      <h3><span>${esc(fmtLong(d))}</span>${pKg(d)?`<span class="chip">${esc(pKg(d))}</span>`:''}</h3>
      <div class="pgrid">${days[d].map(pTile).join('')}</div></section>`).join('');
  el.innerHTML=h;
  renderSelBar();
}
function pTile(p){
  const what=`${pPoseName(p.pose)}, ${fmtShort(p.date)}`, on=pSel&&pPick.includes(p.id);
  return `<a class="ptile${on?' on':''}" href="#photos/${p.id}" data-pid="${p.id}" title="${esc(p.note||what)}"${pSel?` role="button" aria-pressed="${on}"`:''}><img src="${pThumb(p)}" alt="${esc(what)}" loading="lazy" decoding="async"><span>${esc(pPoseName(p.pose))}</span>${on?`<b class="pnum">${pPick.indexOf(p.id)+1}</b>`:''}</a>`;
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
  best.scrollIntoView({block:'start',behavior:'smooth'});
  document.querySelectorAll('.pday.hit').forEach(s=>s.classList.remove('hit'));
  best.classList.add('hit');setTimeout(()=>best.classList.remove('hit'),1600);
}


/* Draw a picture smaller as a JPEG; createImageBitmap turns phone photos the right way up. */
async function pShrink(file,max,quality){
  let bmp;
  try{bmp=await createImageBitmap(file,{imageOrientation:'from-image'});}
  catch{throw new Error(`Couldn’t read “${file.name}” – is it a picture this browser can open (JPEG, PNG, WebP)?`);}
  const k=Math.min(1,max/Math.max(bmp.width,bmp.height)), c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(bmp.width*k));c.height=Math.max(1,Math.round(bmp.height*k));
  const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(bmp,0,0,c.width,c.height);
  if(bmp.close)bmp.close();
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',quality));
  if(!blob)throw new Error(`Couldn’t shrink “${file.name}”`);
  return blob;
}
/* api() sends JSON; the pictures go as they are */
async function pSend(method,url,blob){
  let r;
  try{r=await fetch(url,{method,credentials:'same-origin',headers:{'content-type':'image/jpeg','x-csrf-token':csrf},body:blob});}
  catch{throw new Error('Can’t reach the server – is it still running?');}
  if(r.status===401){setTimeout(toLogin,0);const e=new Error('You were signed out');e.signedOut=true;throw e;}
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);
  return j;
}
async function pUpload(form){
  if(pBusy)return;
  const err=$('#p-err'), st=$('#p-state'), btn=form.querySelector('button[type=submit]');
  const files=[...$('#p-file').files], date=$('#p-date').value, pose=$('#p-pose').value, note=$('#p-note').value.trim();
  err.hidden=true;
  if(!files.length){err.textContent='Pick one or more photos.';err.hidden=false;return;}
  if(!isDate(date)){err.textContent='Pick the date the photos were taken.';err.hidden=false;return;}
  pBusy=true;btn.disabled=true;pDate=date;pUpPose=pose;
  let done=0;
  try{
    for(const f of files){
      st.textContent=files.length>1?`Uploading ${done+1} of ${files.length}…`:'Uploading…';
      const big=await pShrink(f,P_MAX,0.86), small=await pShrink(f,P_THUMB,0.8);
      let p=await pSend('POST',`/api/photos?${new URLSearchParams({date,pose,note})}`,big);
      try{p=await pSend('PUT',`/api/photos/${p.id}/thumb`,small);}catch(e){if(e.signedOut)throw e;}   /* the catalog falls back to the full picture */
      PHOTOS.push(p);done++;
    }
    pMsg=`Added ${done} photo${done===1?'':'s'} for ${fmtLong(date)}.`;
  }catch(e){
    if(e.signedOut)return;
    err.textContent=(done?`Added ${done} of ${files.length}. `:'')+e.message;err.hidden=false;
  }finally{pBusy=false;}
  pSort();
  if(view!=='photos'||location.hash.replace(/^#/,'').split('/')[1])return;
  if(err.hidden){form.reset();$('#p-date').value=pDate;$('#p-pose').value=pUpPose;st.textContent='';}
  else st.textContent='';
  btn.disabled=false;renderPhotoList();
}

/* ---------- one photo ---------- */
function pOnePage(p){
  const list=pShown(), i=list.indexOf(p);
  const newer=i>0?list[i-1]:null, older=i>=0&&i<list.length-1?list[i+1]:null;
  const nav=`<span class="pnav">${older?`<a class="nav" href="#photos/${older.id}" aria-label="Older photo">‹</a>`:''}${newer?`<a class="nav" href="#photos/${newer.id}" aria-label="Newer photo">›</a>`:''}</span>`;
  return gHead('#photos',`${pPoseName(p.pose)} · ${fmtShort(p.date)}`,nav)+`
    <figure class="pbig"><a href="${pSrc(p)}" target="_blank" rel="noopener"><img src="${pSrc(p)}" alt="${esc((pPoseName(p.pose))+' photo, '+fmtLong(p.date))}"></a>
      <figcaption>${esc(fmtLong(p.date))}${pKg(p.date)?' · '+esc(pKg(p.date)):''}${p.note?' · '+esc(p.note):''}</figcaption></figure>
    <form id="p-eform" class="panel sform" data-id="${p.id}">
      <label class="f"><span class="lbl">Date taken</span><input id="p-edate" type="date" required value="${p.date}"></label>
      <label class="f"><span class="lbl">Pose</span><select id="p-epose">${pPoseOptions(p.pose)}</select></label>
      <label class="f swide"><span class="lbl">Note (optional)</span><input id="p-enote" maxlength="200" value="${esc(p.note)}"></label>
      <p id="p-eerr" class="aderr swide" role="alert" hidden></p>
      <div class="factions swide"><button class="btn" type="submit">Save changes</button>
        <button class="ghost" type="button" data-pa="withthis" data-id="${p.id}">Compare with…</button>
        <a class="ghost" href="${pSrc(p)}" download="progress-${p.date}-${p.pose}.jpg">Download</a>
        <button class="ghost fdel" type="button" data-pa="del" data-id="${p.id}">Delete</button></div>
    </form>`;
}
async function pSave(form){
  const err=$('#p-eerr'), id=+form.dataset.id, btn=form.querySelector('button[type=submit]');
  btn.disabled=true;err.hidden=true;
  try{
    const p=await api('PUT','/api/photos/'+id,{date:$('#p-edate').value,pose:$('#p-epose').value,note:$('#p-enote').value});
    PHOTOS=PHOTOS.filter(x=>x.id!==id);PHOTOS.push(p);pSort();
    pMsg='Saved.';go('photos');
  }catch(e){btn.disabled=false;if(!e.signedOut){err.textContent=e.message;err.hidden=false;}}
}
async function pDelete(id){
  const p=pById(id);if(!p)return;
  if(!confirm(`Delete this ${(pPoseName(p.pose)).toLowerCase()} photo from ${fmtLong(p.date)}? This can’t be undone.`))return;
  try{await api('DELETE','/api/photos/'+id);}catch(e){if(!e.signedOut)alert(e.message);return;}
  PHOTOS=PHOTOS.filter(x=>x.id!==id);pPick=pPick.filter(x=>x!==id);pMsg='Deleted the photo.';go('photos');
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
  const opts=sel=>PHOTOS.map(p=>`<option value="${p.id}"${p===sel?' selected':''}>${esc(pYmd(p.date))} · ${esc(pPoseName(p.pose))}${pWeightOn(p.date,ws)?' · '+esc(pKgTxt(pWeightOn(p.date,ws))):''}</option>`).join('');
  const side=(p,w,k,other,ow)=>`<figure class="pside">
      <label class="f"><span class="lbl">${k==='a'?'Before':'After'}</span><select id="p-c${k}" data-other="${other.id}">${opts(p)}</select></label>
      <a href="#photos/${p.id}"><img src="${pSrc(p)}" alt="${esc(pPoseName(p.pose)+' photo, '+fmtLong(p.date))}"></a>
      <figcaption><b>${esc(pYmd(p.date))}</b> · ${esc(pPoseName(p.pose))}${w?' · '+esc(pKgTxt(w)):''}${p.note?`<br>${esc(p.note)}`:''}</figcaption>
      <button class="ghost" type="button" data-pa="match" data-keep="${other.id}" data-drop="${p.id}"${ow?'':' disabled'} title="Swap this side for the ${esc(pPoseName(other.pose).toLowerCase())} photo from another day when you weighed closest to that">${ow?`Find one at ${esc(ow.kg)} kg`:'No weigh-in to match'}</button></figure>`;
  const gap=pDayGap(a.date,b.date), sum=[gap?`${gap} day${gap===1?'':'s'} apart`:'Same day'];
  if(wa&&wb){const d=Math.round((wb.kg-wa.kg)*10)/10;sum.push(d?`${d>0?'+':''}${d} kg`:'same weight');}
  return `<div class="gbar"><h2>Compare</h2><button class="ghost" type="button" data-pa="repick">Pick in the catalog</button></div>
    <p class="note" id="p-cmpsum">${esc(sum.join(' · '))}</p>
    <div class="pcmp" id="p-cmp">${side(a,wa,'a',b,wb)}${side(b,wb,'b',a,wa)}</div>
    ${pMsg?`<p class="note fmsg" role="status">${esc(pMsg)}</p>`:''}`;
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

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  if(view!=='photos')return;
  const t=pSel&&e.target.closest('#p-list .ptile');
  if(t){e.preventDefault();pToggle(+t.dataset.pid);return;}
  const b=e.target.closest('[data-pa]');if(!b)return;
  const a=b.dataset.pa;
  if(a==='filter'){pPose=b.dataset.v;pMsg='';document.querySelectorAll('[data-pa=filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderPhotoList();}
  else if(a==='del')pDelete(+b.dataset.id);
  else if(a==='select'){pMsg='';pSetSel(!pSel);}
  else if(a==='selcancel')pSetSel(false);
  else if(a==='cmpgo'&&pPick.length===2){const [x,y]=pPick;pSel=false;pPick=[];pMsg='';go(`photos/compare/${x}/${y}`);}
  else if(a==='repick'){const s=[...document.querySelectorAll('#p-cmp select')].map(x=>+x.value);pSel=true;pPick=s;pMsg='';go('photos');}
  else if(a==='withthis'){pSel=true;pPick=[+b.dataset.id];pMsg='';go('photos');}
  else if(a==='match')pMatch(+b.dataset.keep,+b.dataset.drop);
});
document.addEventListener('change',e=>{
  if(view!=='photos')return;
  const id=e.target.id;
  if(id==='p-ca'||id==='p-cb'){pMsg='';go(`photos/compare/${e.target.value}/${e.target.dataset.other}`);}
  else if(id==='p-jump')pJump(e.target.value);
  else if(id==='p-near'){pNear=e.target.checked;pMsg='';renderPhotoList();}
  else if(id==='p-tol'){pTol=+e.target.value;if(pNear)renderPhotoList();}
});
document.addEventListener('input',e=>{
  if(view==='photos'&&e.target.id==='p-nearkg'){pNearKg=e.target.value;if(pNear)renderPhotoList();}
});
document.addEventListener('submit',e=>{
  if(e.target.id==='p-form'){e.preventDefault();pMsg='';pUpload(e.target);}
  else if(e.target.id==='p-eform'){e.preventDefault();pSave(e.target);}
});
