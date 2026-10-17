'use strict';
/* Form pieces shared by every page (the app, sign-in and invite): errors shown at the field, a confirm dialog with buttons named
   for what they do, a Show button on every password box and busy wording for buttons while their request runs.
   Plain globals, loaded before the page's own script; styles in base.css. */

/* ---------- field errors ----------
   fieldError(input, msg) puts the message under the field (aria-invalid, aria-describedby), focuses it unless {focus:false},
   and clears itself as soon as the field is corrected: with {check: el => message or ''} it re-checks as you type, otherwise
   it goes once the value changes. clearFieldErrors(root) clears every one in root. fieldErrors(form, [[input, msg]…]) clears the
   form, marks each, focuses the first and – with {summary:true} or a form marked data-summary – lists them at the top too. */
const FERR=new WeakMap();
let ferrN=0;
function ferrHost(input){return input.closest('label')||null;}
function clearFieldError(input){
  const st=FERR.get(input);if(!st)return;FERR.delete(input);
  st.el.remove();input.removeEventListener('input',st.on);input.removeEventListener('change',st.on);
  input.removeAttribute('aria-invalid');
  const ids=(input.getAttribute('aria-describedby')||'').split(/\s+/).filter(x=>x&&x!==st.el.id);
  if(ids.length)input.setAttribute('aria-describedby',ids.join(' '));else input.removeAttribute('aria-describedby');
  const form=input.form||input.closest('form');
  if(form){const sum=form.querySelector(':scope > .ferrsum');if(sum){const li=sum.querySelector(`[data-for="${CSS.escape(st.el.id)}"]`);if(li)li.remove();if(!sum.querySelector('li'))sum.remove();}}
}
function fieldError(input,msg,opts={}){
  if(!input)return false;
  if(!msg){clearFieldError(input);return true;}
  let st=FERR.get(input);
  if(!st){
    const el=document.createElement('span');el.className='ferr';el.id='ferr-'+(++ferrN);
    const host=ferrHost(input), pw=input.closest('.pwf');
    /* inside a label the message would become part of the field's name: hidden there, read as its description instead;
       a password box's goes under its Show button */
    if(pw)pw.appendChild(el);
    else if(host){el.setAttribute('aria-hidden','true');host.appendChild(el);}else input.insertAdjacentElement('afterend',el);
    st={el,bad:input.value,check:opts.check,on:null};
    st.on=()=>{const s=FERR.get(input);if(!s)return;
      if(s.check){const m=s.check(input);if(m)s.el.textContent=m;else clearFieldError(input);}
      else if(input.value!==s.bad||input.type==='checkbox')clearFieldError(input);};
    input.addEventListener('input',st.on);input.addEventListener('change',st.on);
    FERR.set(input,st);
    const ids=(input.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);
    input.setAttribute('aria-describedby',[el.id,...ids].join(' '));
  }
  st.el.textContent=msg;st.bad=input.value;if(opts.check)st.check=opts.check;
  input.setAttribute('aria-invalid','true');
  if(opts.focus!==false){try{input.focus({preventScroll:false});}catch{}}
  return false;
}
function clearFieldErrors(root){
  if(!root)return;
  root.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
  root.querySelectorAll('.ferrsum').forEach(s=>s.remove());
}
function fieldErrors(form,list,opts={}){
  clearFieldErrors(form);
  const bad=list.filter(x=>x&&x[0]&&x[1]);
  if(!bad.length)return true;
  bad.forEach(([el,msg,o])=>fieldError(el,msg,{...(o||{}),focus:false}));
  if((opts.summary||form.dataset.summary!=null)&&bad.length>1){
    const s=document.createElement('div');s.className='ferrsum';s.setAttribute('role','alert');
    const h=document.createElement('p');h.textContent=`Fix ${bad.length} things before saving:`;s.appendChild(h);
    const ul=document.createElement('ul');
    bad.forEach(([el,msg])=>{const li=document.createElement('li');li.dataset.for=FERR.get(el).el.id;
      const b=document.createElement('button');b.type='button';b.className='link';b.textContent=msg;
      b.addEventListener('click',()=>el.focus());li.appendChild(b);ul.appendChild(li);});
    s.appendChild(ul);form.prepend(s);
  }
  bad[0][0].focus();
  return false;
}
/* The browser's own checks (required, type=email, min/max…) show the same way instead of its bubble: the form still isn't sent,
   the first bad field gets focus and each says why under it until it's fixed. */
if(typeof document!=='undefined')document.addEventListener('invalid',e=>{
  const el=e.target;if(!el||!el.form)return;e.preventDefault();
  const first=[...el.form.elements].find(x=>x.willValidate&&!x.validity.valid);
  fieldError(el,el.validationMessage,{focus:first===el,check:x=>x.validity.valid?'':x.validationMessage});
},true);
/* A server's 400 message on the field it is about: the first [pattern, input] whose pattern matches the message gets it;
   true if one did (the caller shows it at the form otherwise). */
function errToField(err,pairs){
  const msg=err&&err.message||String(err||'');
  for(const [re,el] of pairs)if(el&&re.test(msg)){fieldError(el,msg);return true;}
  return false;
}

/* ---------- confirm dialog ----------
   ask(text, {yes, no, danger, title, only}) → Promise<boolean>: a modal <dialog> with buttons named for what they do (only: just
   the yes button, a notice in place of alert()). Focus moves in
   (to the safe button when danger), Tab stays inside, Escape is "no", and focus goes back to what had it. */
let ASKD=null;
function askDialog(){
  if(ASKD)return ASKD;
  const d=document.createElement('dialog');d.id='ask';d.className='askd';
  d.setAttribute('aria-labelledby','ask-h');d.setAttribute('aria-describedby','ask-t');
  d.innerHTML='<h2 id="ask-h"></h2><p id="ask-t"></p><div class="askbtns"><button type="button" class="btn" id="ask-yes"></button><button type="button" class="ghost" id="ask-no"></button></div>';
  document.body.appendChild(d);
  d.addEventListener('keydown',e=>{if(e.key!=='Tab')return;
    const bs=[...d.querySelectorAll('button')].filter(b=>!b.hidden),i=bs.indexOf(document.activeElement);
    if(e.shiftKey&&i<=0){e.preventDefault();bs[bs.length-1].focus();}
    else if(!e.shiftKey&&i===bs.length-1){e.preventDefault();bs[0].focus();}});
  return ASKD=d;
}
function ask(text,opts={}){
  const d=askDialog();
  if(d.open&&d._done)d._done(false);
  const back=document.activeElement;
  return new Promise(res=>{
    const yes=d.querySelector('#ask-yes'),no=d.querySelector('#ask-no');
    d.querySelector('#ask-h').textContent=opts.title||(opts.danger?'Are you sure?':'Please confirm');
    d.querySelector('#ask-t').textContent=text;
    yes.textContent=opts.yes||'OK';no.textContent=opts.no||'Cancel';no.hidden=!!opts.only;
    yes.className='btn'+(opts.danger?' danger':'');
    const done=v=>{d._done=null;yes.onclick=no.onclick=null;d.oncancel=null;if(d.open)d.close();
      if(back&&back.isConnected&&typeof back.focus==='function')try{back.focus();}catch{}
      res(v);};
    d._done=done;
    yes.onclick=()=>done(true);no.onclick=()=>done(false);
    d.oncancel=e=>{e.preventDefault();done(false);};
    d.showModal();(opts.danger?no:yes).focus();
  });
}

/* ---------- show password ----------
   Every password box gets a "Show" button after it (aria-pressed, aria-controls); it hides again when its form is sent.
   New boxes (pages drawn later) get theirs as they appear. */
let pwN=0;
function pwToggles(root){
  (root||document).querySelectorAll('input[type=password]:not([data-pwt])').forEach(input=>{
    input.dataset.pwt='1';if(!input.id)input.id='pw-'+(++pwN);
    const host=input.closest('label')||input;
    const wrap=document.createElement('div');wrap.className='pwf';
    host.replaceWith(wrap);wrap.appendChild(host);
    if(host.hidden){wrap.hidden=true;host.hidden=false;}   /* a hidden field keeps its row hidden */
    const b=document.createElement('button');b.type='button';b.className='ghost pwshow';
    b.setAttribute('aria-controls',input.id);b.setAttribute('aria-pressed','false');
    b.innerHTML='Show<span class="vh"> password</span>';
    b.addEventListener('click',()=>{const on=input.type==='password';input.type=on?'text':'password';b.setAttribute('aria-pressed',String(on));});
    wrap.appendChild(b);
    const form=input.form;
    if(form&&!form.dataset.pwreset){form.dataset.pwreset='1';
      form.addEventListener('submit',()=>form.querySelectorAll('.pwshow[aria-pressed="true"]').forEach(x=>x.click()),true);}
  });
}
/* a wrapped field's row is hidden or shown through its wrapper */
function pwRow(input){return input&&input.closest('.pwf')||input&&input.closest('label')||input;}
if(typeof document!=='undefined'){
  let queued=false;
  const scan=()=>{queued=false;pwToggles(document);};
  const start=()=>{scan();new MutationObserver(()=>{if(!queued){queued=true;queueMicrotask(scan);}}).observe(document.body,{childList:true,subtree:true});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
}

/* ---------- drawing a part of the page again ----------
   redraw(box, html, near): box.innerHTML = html without losing the keyboard's place. The control that had focus inside box is found
   again in the new markup by its id or its data-* keys (data-g="iup" data-i="2"…) and focused, with the caret where it was; when it
   is gone or switched off, near(key, el) can name another (a selector or element), else the first usable one of its kind (same
   data-g/fa/sa… action). focusAgain(box, key, near) does the second half for a box drawn some other way (key from focusKey()). */
const FKEYS=['g','fa','sa','sai','st','i','id','t','v','p','f','d','e','k'];
function focusKey(el){
  if(!el||el===document.body||!el.tagName)return null;
  if(el.id)return {sel:'#'+CSS.escape(el.id),act:null,caret:el.selectionStart!=null?[el.selectionStart,el.selectionEnd]:null};
  const ds=FKEYS.filter(k=>el.dataset&&el.dataset[k]!=null);if(!ds.length)return null;
  const act=FKEYS.slice(0,5).find(k=>el.dataset[k]!=null);
  return {sel:el.tagName.toLowerCase()+ds.map(k=>`[data-${k}="${CSS.escape(el.dataset[k])}"]`).join(''),
    act:act?`${el.tagName.toLowerCase()}[data-${act}="${CSS.escape(el.dataset[act])}"]`:null,caret:el.selectionStart!=null?[el.selectionStart,el.selectionEnd]:null};
}
const fUsable=x=>x&&x.isConnected&&!x.disabled&&!x.closest('[hidden]')&&x.getClientRects().length;
function focusAgain(box,key,near){
  if(!key||!box)return false;
  let el=box.querySelector(key.sel);
  if(!fUsable(el)&&near){const n=near(key,el);el=typeof n==='string'?box.querySelector(n):n;}
  if(!fUsable(el)&&key.act){const all=[...box.querySelectorAll(key.act)].filter(fUsable);el=all[0]||null;}
  if(!fUsable(el))return false;
  try{el.focus({preventScroll:false});if(key.caret&&el.setSelectionRange&&el===document.activeElement)el.setSelectionRange(...key.caret);}catch{}
  return document.activeElement===el;
}
function redraw(box,html,near){
  if(!box)return false;
  const a=document.activeElement, key=a&&box.contains(a)?focusKey(a):null;
  box.innerHTML=html;
  return key?focusAgain(box,key,near):false;
}
/* Short news for screen readers ("Logged 8 × 100 kg", "Squat added"): one polite live region for the page. */
let LIVE=null;
function say(text){
  if(typeof document==='undefined'||!document.body)return;
  if(!LIVE){LIVE=document.createElement('div');LIVE.id='live';LIVE.className='vh';LIVE.setAttribute('aria-live','polite');LIVE.setAttribute('aria-atomic','true');document.body.appendChild(LIVE);}
  LIVE.textContent='';setTimeout(()=>{LIVE.textContent=text;},50);
}
/* A heading the page moved you to (a preview that just opened, a new page): focusable from script only, scrolled into view. */
function focusHead(h,scroll=true){if(!h)return;if(!h.hasAttribute('tabindex'))h.setAttribute('tabindex','-1');try{h.focus({preventScroll:true});if(scroll)h.scrollIntoView({block:'start',behavior:'smooth'});}catch{}}

/* ---------- unsaved changes ----------
   leaveGuard({dirty, text, drop}): while dirty() is true, a link to another #address asks first (ask(): Leave without saving / Stay),
   Back, Forward or a typed address puts the address back before the page changes and asks the same, and closing or reloading the
   tab asks too (beforeunload). Saying leave calls drop() – the page forgets its draft – and goes on. */
const LEAVE=[];
function leaveGuard(g){LEAVE.push(g);}
/* set once the person has said to leave anyway (sign out without saving): the browser's own Leave? box isn't shown again */
let leaveOk=false;
const leaveDirty=()=>LEAVE.find(g=>{try{return g.dirty();}catch{return false;}});
let leaveAsking=false;
async function leaveAsk(g){
  if(leaveAsking)return false;leaveAsking=true;
  try{return await ask(g.text||'You have changes that aren’t saved. Leave without saving them?',{title:'Unsaved changes',yes:'Leave without saving',no:'Stay',danger:true});}
  finally{leaveAsking=false;}
}
function leaveTo(g,to){try{if(g.drop)g.drop();}catch{}location.hash=to;}
if(typeof document!=='undefined'){
  document.addEventListener('click',e=>{
    if(e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
    const a=e.target.closest&&e.target.closest('a[href^="#"]');if(!a)return;
    const to=a.getAttribute('href');if(to===location.hash||to==='#main')return;
    const g=leaveDirty();if(!g)return;
    e.preventDefault();e.stopImmediatePropagation();
    leaveAsk(g).then(yes=>{if(yes)leaveTo(g,to);});
  },true);
  /* registered before app.js's route(): stopping here means the page you were on is never drawn away */
  window.addEventListener('hashchange',e=>{
    const from=e.oldURL?new URL(e.oldURL).hash:'', to=location.hash;if(from===to)return;
    const g=leaveDirty();if(!g)return;
    e.stopImmediatePropagation();history.replaceState(null,'',from||'#');
    leaveAsk(g).then(yes=>{if(yes)leaveTo(g,to);});
  });
  window.addEventListener('beforeunload',e=>{if(!leaveOk&&leaveDirty()){e.preventDefault();e.returnValue='';}});
}

/* ---------- a refusal with no words of its own ----------
   httpText(status): what to say when the answer isn't the app's JSON (a proxy's 502 page, a cut-off body) – never "HTTP 502". */
function httpText(s){
  return s===413?'That’s too big to send.':s===429?'That’s a lot of requests – wait a minute and try again.'
    :s>=502&&s<=504?'The server isn’t answering right now – try again in a minute.':s>=500?'Something went wrong on the server – try again.'
    :`That didn’t work (error ${s}) – try again.`;
}

/* ---------- busy buttons ----------
   busyOn(button, 'Saving…') → a function that puts it back: aria-busy, the busy wording and disabled meanwhile. */
function busyOn(b,text){
  if(!b)return()=>{};
  const was=b.textContent,wasDis=b.disabled;b.disabled=true;b.setAttribute('aria-busy','true');if(text)b.textContent=text;
  return()=>{b.removeAttribute('aria-busy');b.disabled=wasDis;if(text&&b.textContent===text)b.textContent=was;};
}
