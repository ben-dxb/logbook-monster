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
   ask(text, {yes, no, danger, title}) → Promise<boolean>: a modal <dialog> with buttons named for what they do. Focus moves in
   (to the safe button when danger), Tab stays inside, Escape is "no", and focus goes back to what had it. */
let ASKD=null;
function askDialog(){
  if(ASKD)return ASKD;
  const d=document.createElement('dialog');d.id='ask';d.className='askd';
  d.setAttribute('aria-labelledby','ask-h');d.setAttribute('aria-describedby','ask-t');
  d.innerHTML='<h2 id="ask-h"></h2><p id="ask-t"></p><div class="askbtns"><button type="button" class="btn" id="ask-yes"></button><button type="button" class="ghost" id="ask-no"></button></div>';
  document.body.appendChild(d);
  d.addEventListener('keydown',e=>{if(e.key!=='Tab')return;
    const bs=[...d.querySelectorAll('button')],i=bs.indexOf(document.activeElement);
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
    yes.textContent=opts.yes||'OK';no.textContent=opts.no||'Cancel';
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

/* ---------- busy buttons ----------
   busyOn(button, 'Saving…') → a function that puts it back: aria-busy, the busy wording and disabled meanwhile. */
function busyOn(b,text){
  if(!b)return()=>{};
  const was=b.textContent,wasDis=b.disabled;b.disabled=true;b.setAttribute('aria-busy','true');if(text)b.textContent=text;
  return()=>{b.removeAttribute('aria-busy');b.disabled=wasDis;if(text&&b.textContent===text)b.textContent=was;};
}
