'use strict';
/* Progress photos: upload pictures, each with the date it was taken, a pose (front, side, back, other) and
   an optional note, and look back through them by date or side by side.
   #photos (the catalog, newest day first), #photos/12 (one photo: view, change, delete), #photos/compare.
   Pictures are shrunk to a JPEG in the browser before upload (which also drops the EXIF data, location
   included) and a small thumbnail is sent after it for the catalog. Uses helpers from app.js and gym.js (gHead, gEmpty). */

let PHOTOS=null, PPOSES=['front','side','back','other'], PWT={};
let pPose='all', pDate=todayStr(), pUpPose='front', pMsg='', pTok=0, pBusy=false, pCmp={a:'',b:'',pose:'front'};
const P_MAX=2000, P_THUMB=480;                     /* longest side in pixels: the photo, the thumbnail */
const P_NAME={front:'Front',side:'Side',back:'Back',other:'Other'};

const pById=id=>PHOTOS&&PHOTOS.find(p=>p.id===id);
const pSrc=p=>`/api/photos/${p.id}/file?v=${encodeURIComponent(p.v)}`;
const pThumb=p=>p.tv?`/api/photos/${p.id}/thumb?v=${encodeURIComponent(p.tv)}`:pSrc(p);
function pSort(){PHOTOS.sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);}
async function pLoad(){
  const [r,w]=await Promise.all([api('GET','/api/photos'),api('GET','/api/weights')]);
  PHOTOS=(r&&r.photos)||[];if(r&&r.poses)PPOSES=r.poses;pSort();
  PWT={};(w||[]).forEach(x=>{PWT[x.date]=x.kg;});
}
const pYmd=d=>parse(d).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
const pDays=()=>[...new Set(PHOTOS.map(p=>p.date))];   /* newest first */
const pW=d=>WEIGHTS[d]!=null?WEIGHTS[d]:PWT[d];            /* WEIGHTS (app.js) has any weigh-in logged since */
const pKg=d=>pW(d)!=null?`${pW(d)} kg`:'';

async function renderPhotos(args){
  if(view!=='photos')return;
  const tok=++pTok, box=$('#p-body'), [a]=args||[];
  const cmp=a==='compare';
  const tabs=`<nav class="seg gtabs" aria-label="Progress photos"><a href="#photos"${cmp?'':' aria-current="page"'}>By date</a><a href="#photos/compare"${cmp?' aria-current="page"':''}>Compare</a></nav>`;
  try{
    if(!PHOTOS){box.innerHTML=tabs+'<p class="note">Loading…</p>';await pLoad();if(tok!==pTok||view!=='photos')return;}
    if(/^\d+$/.test(a||'')){
      const p=pById(+a);
      box.innerHTML=p?pOnePage(p):gHead('#photos','Photo')+gEmpty('That photo isn’t here any more.');return;
    }
    if(cmp){box.innerHTML=tabs+pCmpPage();return;}
    box.innerHTML=tabs+pCatalogPage();renderPhotoList();
  }catch(e){if(!e.signedOut&&tok===pTok)box.innerHTML=tabs+gEmpty('Couldn’t load your photos: '+esc(e.message));}
}

/* ---------- the catalog: upload, then every day with photos, newest first ---------- */
function pPoseOptions(sel){return PPOSES.map(v=>`<option value="${v}"${v===sel?' selected':''}>${esc(P_NAME[v]||v)}</option>`).join('');}
function pCatalogPage(){
  const seg=[['all','All'],...PPOSES.map(v=>[v,P_NAME[v]||v])].map(([v,l])=>`<button type="button" data-pa="filter" data-v="${v}" aria-pressed="${pPose===v}">${esc(l)}</button>`).join('');
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
    <div class="ftools"><div class="seg" role="group" aria-label="Pose">${seg}</div></div>
    <div id="p-list" class="pdays"></div>`;
}
function renderPhotoList(){
  const el=$('#p-list');if(!el)return;
  const list=PHOTOS.filter(p=>pPose==='all'||p.pose===pPose);
  let h=pMsg?`<p class="note fmsg" role="status">${esc(pMsg)}</p>`:'';
  if(!PHOTOS.length)h+=gEmpty('No photos yet. Pick some above, set the date they were taken and tap Upload.');
  else if(!list.length)h+=gEmpty(`No ${esc((P_NAME[pPose]||pPose).toLowerCase())} photos yet.`);
  const days={};list.forEach(p=>{(days[p.date]=days[p.date]||[]).push(p);});
  h+=Object.keys(days).sort().reverse().map(d=>`<section class="pday" aria-label="${esc(fmtLong(d))}">
      <h3><span>${esc(fmtLong(d))}</span>${pKg(d)?`<span class="chip">${esc(pKg(d))}</span>`:''}</h3>
      <div class="pgrid">${days[d].map(pTile).join('')}</div></section>`).join('');
  el.innerHTML=h;
}
function pTile(p){
  const what=`${P_NAME[p.pose]||p.pose}, ${fmtShort(p.date)}`;
  return `<a class="ptile" href="#photos/${p.id}" title="${esc(p.note||what)}"><img src="${pThumb(p)}" alt="${esc(what)}" loading="lazy" decoding="async"><span>${esc(P_NAME[p.pose]||p.pose)}</span></a>`;
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
  const list=PHOTOS.filter(x=>pPose==='all'||x.pose===pPose), i=list.indexOf(p);
  const newer=i>0?list[i-1]:null, older=i>=0&&i<list.length-1?list[i+1]:null;
  const nav=`<span class="pnav">${older?`<a class="nav" href="#photos/${older.id}" aria-label="Older photo">‹</a>`:''}${newer?`<a class="nav" href="#photos/${newer.id}" aria-label="Newer photo">›</a>`:''}</span>`;
  return gHead('#photos',`${P_NAME[p.pose]||p.pose} · ${fmtShort(p.date)}`,nav)+`
    <figure class="pbig"><a href="${pSrc(p)}" target="_blank" rel="noopener"><img src="${pSrc(p)}" alt="${esc((P_NAME[p.pose]||p.pose)+' photo, '+fmtLong(p.date))}"></a>
      <figcaption>${esc(fmtLong(p.date))}${pKg(p.date)?' · '+esc(pKg(p.date)):''}${p.note?' · '+esc(p.note):''}</figcaption></figure>
    <form id="p-eform" class="panel sform" data-id="${p.id}">
      <label class="f"><span class="lbl">Date taken</span><input id="p-edate" type="date" required value="${p.date}"></label>
      <label class="f"><span class="lbl">Pose</span><select id="p-epose">${pPoseOptions(p.pose)}</select></label>
      <label class="f swide"><span class="lbl">Note (optional)</span><input id="p-enote" maxlength="200" value="${esc(p.note)}"></label>
      <p id="p-eerr" class="aderr swide" role="alert" hidden></p>
      <div class="factions swide"><button class="btn" type="submit">Save changes</button>
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
  if(!confirm(`Delete this ${(P_NAME[p.pose]||p.pose).toLowerCase()} photo from ${fmtLong(p.date)}? This can’t be undone.`))return;
  try{await api('DELETE','/api/photos/'+id);}catch(e){if(!e.signedOut)alert(e.message);return;}
  PHOTOS=PHOTOS.filter(x=>x.id!==id);pMsg='Deleted the photo.';go('photos');
}

/* ---------- compare two days side by side ---------- */
function pCmpPage(){
  const days=pDays();
  if(days.length<2)return gEmpty('Upload photos on two or more different days to compare them.');
  if(!days.includes(pCmp.a))pCmp.a=days[days.length-1];           /* the first day you have */
  if(!days.includes(pCmp.b)||pCmp.b===pCmp.a)pCmp.b=days[0];       /* the latest */
  const opts=sel=>days.map(d=>`<option value="${d}"${d===sel?' selected':''}>${esc(pYmd(d))}</option>`).join('');
  return `<form class="panel sform pcmpf" id="p-cform">
      <label class="f"><span class="lbl">Before</span><select id="p-ca">${opts(pCmp.a)}</select></label>
      <label class="f"><span class="lbl">After</span><select id="p-cb">${opts(pCmp.b)}</select></label>
      <label class="f swide"><span class="lbl">Pose</span><select id="p-cpose">${pPoseOptions(pCmp.pose)}</select></label>
    </form>
    <div id="p-cmp">${pCmpBody()}</div>`;
}
function pCmpBody(){
  const {a,b,pose}=pCmp;
  const side=d=>{
    const p=PHOTOS.filter(x=>x.date===d&&x.pose===pose).sort((x,y)=>x.id-y.id)[0];
    return `<figure class="pside">${p?`<a href="#photos/${p.id}"><img src="${pSrc(p)}" alt="${esc((P_NAME[pose]||pose)+' photo, '+fmtLong(d))}"></a>`
      :`<div class="pnone">No ${esc((P_NAME[pose]||pose).toLowerCase())} photo this day</div>`}
      <figcaption><b>${esc(pYmd(d))}</b>${pKg(d)?' · '+esc(pKg(d)):''}</figcaption></figure>`;
  };
  const gap=Math.round((parse(b)-parse(a))/864e5), kg=pW(a)!=null&&pW(b)!=null?Math.round((pW(b)-pW(a))*10)/10:null;
  const sum=[`${Math.abs(gap)} day${Math.abs(gap)===1?'':'s'} apart`];
  if(kg!=null)sum.push(`${kg>0?'+':''}${kg} kg`);
  return `<p class="note">${esc(sum.join(' · '))}</p><div class="pcmp">${side(a)}${side(b)}</div>`;
}

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-pa]');if(!b||view!=='photos')return;
  const a=b.dataset.pa;
  if(a==='filter'){pPose=b.dataset.v;pMsg='';document.querySelectorAll('[data-pa=filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderPhotoList();}
  else if(a==='del')pDelete(+b.dataset.id);
});
document.addEventListener('change',e=>{
  if(view!=='photos')return;
  const id=e.target.id;
  if(id==='p-ca'||id==='p-cb'||id==='p-cpose'){
    pCmp={a:$('#p-ca').value,b:$('#p-cb').value,pose:$('#p-cpose').value};
    $('#p-cmp').innerHTML=pCmpBody();
  }
});
document.addEventListener('submit',e=>{
  if(e.target.id==='p-form'){e.preventDefault();pMsg='';pUpload(e.target);}
  else if(e.target.id==='p-eform'){e.preventDefault();pSave(e.target);}
  else if(e.target.id==='p-cform')e.preventDefault();
});
