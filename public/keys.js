'use strict';
/* Super admin › Keys (#admin/keys): every credential the app holds with its age, the slots in use and the next step
   (GET /api/admin/keys, server/credentials.js – never a value), the banner on every Super admin tab while one is past 30 days
   or of unknown age, and the rotation controls on the AI and Email tabs (docs/rotation.md): Save as next, Test next, Promote,
   and Test old after revoking the replaced one at the provider – it must fail. Uses helpers from app.js; admin.js calls kyLoad(). */
let KY=null, kyBusy=false;
const KY_ROT={ai:{path:'ai',field:'key',what:'key',where:'OpenRouter'},mail:{path:'email',field:'pass',what:'password',where:'your email provider'}};
const KY_TIER={ok:['ok','OK'],due:['info','Due soon'],stale:['bad','Over 30 days'],overdue:['bad','Overdue'],unknown:['bad','Age unknown'],info:['','No schedule']};
const kyMsg={ai:'',mail:''};
async function kyLoad(){
  if(kyBusy)return;kyBusy=true;
  try{KY=await api('GET','/api/admin/keys');}catch(e){if(e.signedOut)return;KY=KY||null;}finally{kyBusy=false;}
  kyRender();
}
function kyRender(){
  const b=$('#ad-keybanner');
  if(b){b.hidden=!(KY&&KY.stale);if(KY&&KY.stale)b.innerHTML=`<b>${KY.stale} credential${KY.stale>1?'s are':' is'} over ${KY.rotate} days old or of unknown age.</b> <a href="#admin/keys">See Keys</a> for what to do.`;}
  const el=$('#ad-keys');
  if(el)el.innerHTML=!KY?'<p class="sub">Loading…</p>':KY.credentials.map(c=>{const [cl,txt]=KY_TIER[c.tier]||['',''];
    return `<div class="aduser kyrow"><span class="who"><b>${esc(c.label)}</b> <code>${esc(c.name)}</code>
      <span class="sub">${esc(c.where)} · ${esc(c.slots)}${c.rotate?` · ${c.days==null?'age unknown':`${c.days} day${c.days===1?'':'s'} old`}`:''}</span>
      <span class="sub">${esc(c.next)}</span></span><span class="chip ${cl}">${esc(txt)}</span></div>`;}).join('');
  for(const k of Object.keys(KY_ROT))kyRot(k);
}
/* the rotation block on the AI / Email tab */
function kyRot(k){
  const el=$(`#ad-rot-${k}`);if(!el)return;
  const R=KY_ROT[k], s=KY&&KY.slots&&KY.slots[k]||{};
  if(el.contains(document.activeElement)&&el.querySelector('input')===document.activeElement){const m=el.querySelector('[data-ky-msg]');if(m)m.textContent=kyMsg[k];return;}
  el.innerHTML=`<h3 class="lbl">Rotate the ${R.what}</h3>
    <p class="sub">Make a new ${R.what} at ${R.where}, save it here as next and test it, then promote it. The one it replaces is kept for an hour: revoke it at ${R.where}, then Test old – it must fail. See docs/rotation.md.</p>
    <form class="adkey" data-ky-form="${k}"><label class="f"><span class="lbl">Next ${R.what}</span><input type="password" autocomplete="off" spellcheck="false" data-ky-in="${k}" aria-describedby="ad-rot-${k}-msg"></label>
      <button class="btn" type="submit">Save as next</button></form>
    <div class="admailact"><button class="ghost" type="button" data-ky="test" data-k="${k}" data-slot="next"${s.next?'':' disabled'}>Test next</button>
      <button class="ghost" type="button" data-ky="promote" data-k="${k}"${s.next?'':' disabled'}>Promote</button>
      <button class="ghost" type="button" data-ky="test" data-k="${k}" data-slot="old"${s.old?'':' disabled'}>Test old</button></div>
    <p class="sub" role="status" id="ad-rot-${k}-msg" data-ky-msg="${k}">${esc(kyMsg[k]||(s.next?`A next ${R.what} is saved.`:'')+(s.old?` The old one is kept until ${new Date(s.oldUntil).toLocaleTimeString()}.`:''))}</p>`;
}
function kySay(k,t){kyMsg[k]=t;const m=document.querySelector(`[data-ky-msg="${k}"]`);if(m)m.textContent=t;}
/* after a change: the panel, plus the AI / Email tab's own state (admin.js) */
async function kyAfter(k){
  await kyLoad();
  if(k==='ai'&&typeof adAiLoad==='function')adAiLoad();
  if(k==='mail'&&typeof amLoad==='function')amLoad();
}
document.addEventListener('submit',e=>{
  const f=e.target.closest('[data-ky-form]');if(!f)return;e.preventDefault();
  const k=f.dataset.kyForm, R=KY_ROT[k], i=f.querySelector('input'), v=i.value.trim();
  if(!v)return fieldError(i,`Paste the new ${R.what}`);
  once(f,async()=>{
    try{await api('POST',`/api/admin/${R.path}/next`,{[R.field]:v});i.value='';kyMsg[k]='';await kyAfter(k);kySay(k,`Saved as next. Test it before you promote it.`);}
    catch(err){if(!err.signedOut)fieldError(i,endStop(err.message));}
  },'Saving…');
});
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-ky]');if(!b)return;
  const k=b.dataset.k, R=KY_ROT[k], a=b.dataset.ky;
  if(a==='promote'&&!await ask(`Promote the next ${R.what}? It takes over straight away; the current one is kept for an hour so you can test it after revoking it.`,{yes:`Promote the next ${R.what}`,no:'Not yet'}))return;
  once(b,async()=>{
    try{
      if(a==='promote'){await api('POST',`/api/admin/${R.path}/promote`);kyMsg[k]='';await kyAfter(k);kySay(k,`Promoted. Now revoke the old ${R.what} at ${R.where} and press Test old.`);return;}
      const slot=b.dataset.slot;kySay(k,`Testing the ${slot} ${R.what}…`);
      const r=await api('POST',`/api/admin/${R.path}/verify`,{slot});
      kySay(k,slot==='old'?(r.dead?`The old ${R.what} is refused – it’s dead. Recorded in the security log.`:r.ok?`The old ${R.what} still works – revoke it at ${R.where}, then test again.`:`Couldn’t tell: ${r.error||`${R.where} answered with error ${r.status}`}. Try again.`)
        :r.ok?`The ${slot} ${R.what} works.`:`The ${slot} ${R.what} didn’t work: ${r.error||(r.dead?'it was refused':`${R.where} answered with error ${r.status}`)}.`);
      kyLoad();
    }catch(err){if(!err.signedOut)kySay(k,err.message);}
  });
});
