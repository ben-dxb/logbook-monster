'use strict';
/* Admin view, in two scopes on one page:
   - account admin (#account, anyone): your own meal plan – foods, day templates (each with its meals and targets),
     which template each weekday uses and free foods – kept as dated changes. There are no app-wide defaults:
     a new account starts with no plan and builds or uploads its own here;
   - super admin (#admin, ADMIN_EMAILS): app-wide settings in tabs – AI (#admin/ai: OpenRouter key and a model per
     task), People (#admin/people), Email (#admin/email), Options (#admin/options) and the Security log (#admin/log).
   Uses helpers from app.js. */

const AD_BOXES=[['p','Protein'],['c','Carbs'],['x','Additional fats']];
const AD_FREE=[['sauce','Sauces','any food marked Sauce'],['veg','Green veg','any food marked Green veg']];
const AD_FREE_OPTS=[['','No'],['sauce','Sauce'],['veg','Green veg']];
const AD_LEGACY={T:'Training',R:'Rest',S:'Saturday training'};   /* day types before templates had names */
const AD_MAX_TPL=12;
let AD=null, AD_BASE=null, adSaved='', adType=null, adMsg='', adErrs=[], adBusy=false;
let DEFS={mine:null,myVersions:[]};          /* your plan from the server: the change in effect today and every dated change */
let DEFS_ON, adVer=null, adFrom='', adFromToday=false, adFromBad=false;   /* adFromBad: the box holds a date that can't be used – refused, never read as blank */          /* plan change applied now; the one being edited; the date a save takes effect from ('' = from the start) */
let adAi=null, adNotes=[], adSuper=false;
const LOADERR={};   /* a part of the page whose data didn't load: its message, shown in its place */
const loadErr=(what,k)=>`<p class="aderr" role="alert">Couldn’t load ${what}: ${esc(endStop(LOADERR[k]))} Open this tab again or reload the page to try again.</p>`;
const loadTry=async(k,fn)=>{try{const v=await fn();delete LOADERR[k];return v;}catch(e){if(e.signedOut)throw e;LOADERR[k]=e.message||'Something went wrong';return null;}};
const AD_TABS=['ai','people','email','options','log'];
let adTab='ai';                              /* the super admin tab shown */
const adOpen=new Set();                      /* food editors left open */

/* ---------- your plan from the server ---------- */
/* Your plan changes each take effect from a date, so every day uses the change in effect on its date.
   applyDefaults resets FOODS, so the food library goes back in after it. */
function mineOn(date){let v=null;for(const x of DEFS.myVersions||[])if(!x.from||x.from<=date)v=x;return v;}
function useDefs(date,force){const v=mineOn(date);if(force||v!==DEFS_ON){DEFS_ON=v;applyDefaults(v);libRegister();}}
/* the day template a date's weekday uses, and a template's name, from the plan in effect on that date */
function typeOn(date){const v=mineOn(date),ids=((v&&v.templates)||[]).map(t=>t.id),s=v&&v.schedule,t=Array.isArray(s)?s[wdOf(date)]:null;
  return ids.includes(t)?t:ids[0]||null;}
function tnameOn(date,id){const v=mineOn(date),t=((v&&v.templates)||[]).find(x=>x.id===id);return t?t.name:AD_LEGACY[id]||'';}
function freshOn(date,t){useDefs(date);const D=freshDay(wdOf(date),t);libSync(D,date);return D;}   /* with its copy of the plan foods, as persist() keeps it */
function adApplyInUse(){useDefs(S.cur,true);}
function setDefaults(d){DEFS=d||{mine:null,myVersions:[]};adApplyInUse();}
const adEmpty=v=>!v||(!(v.templates||[]).length&&!Object.keys(v.foods||{}).length);   /* as the server sees it: no templates, no foods */
/* choose which of your plan changes to edit (the one in effect today unless one is named) */
function adPick(v){
  const td=todayStr(), now=mineOn(td);
  if(v===undefined)v=now;
  adVer=v;adFrom=v&&v!==now?v.from||'':td;   /* a change to today's plan starts today; another change keeps its own date */
  adFromBad=false;adFromToday=adFrom===td;   /* …today when it is saved, if the page is left open past midnight */
}

/* ---------- draft ---------- */
const ZT=()=>({k:0,p:0,c:0,f:0});
/* the whole plan of a change as a draft: every template with its meals and targets, a template for each weekday */
function adNorm(v){
  v=v||{};
  const templates=(v.templates||[]).map(t=>({id:String(t.id),name:String(t.name||t.id)}));
  const ids=templates.map(t=>t.id);
  const foods={};for(const [id,r] of Object.entries(v.foods||{}))if(id!=='pudding')foods[id]={...r};
  const plan={},targets={};
  ids.forEach(id=>{plan[id]=clone((v.plan||{})[id]||[]).map(m=>({id:String(m.id),name:String(m.name||''),...(m.note?{note:m.note}:{}),
    p:(m.p||[]).map(i=>({f:i.f,g:+i.g||0,lock:!!i.lock})),c:(m.c||[]).map(i=>({f:i.f,g:+i.g||0,lock:!!i.lock})),x:(m.x||[]).map(i=>({f:i.f,g:+i.g||0,lock:!!i.lock}))}));
    targets[id]={...ZT(),...((v.targets||{})[id]||{})};});
  const s=Array.isArray(v.schedule)?v.schedule:[];
  return {foods,pud:(v.foods||{}).pudding||null,templates,plan,targets,
    schedule:DAYS.map((_,d)=>ids.includes(s[d])?s[d]:ids[0]||null),free:{sauce:!!(v.free||{}).sauce,veg:!!(v.free||{}).veg}};
}
function adLoad(){
  AD=adNorm(adVer);AD_BASE=clone(AD);
  if(!AD.templates.some(t=>t.id===adType))adType=AD.templates.length?AD.templates[0].id:null;
  adApplyInUse();
  adSaved=adState();
}
function adState(){return JSON.stringify({...adPayload(),from:adFrom});}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/* the whole plan is stored – nothing is inherited from anywhere */
function adPayload(){
  const has=AD.templates.length;
  return {foods:{...AD.foods,...(AD.pud?{pudding:AD.pud}:{})},templates:AD.templates,schedule:has?AD.schedule:null,
    targets:AD.targets,plan:AD.plan,free:AD.free};
}
function adDirty(){return !!AD&&adState()!==adSaved;}
const adFoodName=id=>(AD.foods[id]||FOODS[id]||{n:id}).n;
const adTpl=id=>AD.templates.find(t=>t.id===id);
const adTplName=id=>(adTpl(id)||{name:id}).name;
function adMac(f,g){const F=f==='pudding'?FOODS.pudding:AD.foods[f];if(!F||F.free&&AD.free[F.free])return {k:0,p:0,c:0,f:0};
  return {k:F.k*g/100,p:F.p*g/100,c:F.c*g/100,f:F.f*g/100};}
function adPlanUses(id){return Object.values(AD.plan).some(ms=>ms.some(m=>['p','c','x'].some(b=>(m[b]||[]).some(i=>i.f===id))));}
/* a new template id: short, unused, the kind the server accepts */
function adNewTid(){let n=AD.templates.length+1,id;do{id='D'+n++;}while(adTpl(id));return id;}
/* add a day template: blank or a copy of another; the first one becomes every weekday's */
function adAddTpl(name,from){
  const id=adNewTid();
  AD.templates.push({id,name});
  AD.plan[id]=from?clone(AD.plan[from]||[]):[{id:'1',name:'Meal 1',p:[],c:[],x:[]}];
  AD.targets[id]=from?{...AD.targets[from]}:adType&&AD.targets[adType]?{...AD.targets[adType]}:ZT();
  if(AD.templates.length===1)AD.schedule=DAYS.map(()=>id);
  return id;
}

/* ---------- rendering ---------- */
/* from the route: #admin/ai, #admin/people, #admin/email; #admin opens the first tab */
function adRoute(arg){adTab=AD_TABS.includes(arg)?arg:AD_TABS[0];if(adTab==='log')LG=null;if(view==='account')ML=null;renderAdmin();}
function adTabs(){
  document.querySelectorAll('#v-admin [data-adtab]').forEach(el=>{el.hidden=el.dataset.adtab!==adTab;});
  document.querySelectorAll('#ad-tabs a').forEach(a=>{if(a.dataset.adt===adTab)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
}
function renderAdmin(){
  if(view!=='admin'&&view!=='account')return;
  const mine=view==='account';
  $('#v-admin').classList.toggle('mine',mine);
  $('#v-admin').classList.toggle('nofiles',!planFiles);$('#ad-planfiles').checked=planFiles;
  if(!adAi)adAiLoad();
  if(!mine){if(!adSuper){adSuper=true;auLoad();amLoad();aoLoad();}
    else{if(LOADERR.au)auLoad();if(LOADERR.am)amLoad();if(LOADERR.ao)aoLoad();}   /* a part that failed to load tries again when you come back */
    if(LOADERR.ai)adAiLoad();
    if(adTab==='log'&&!LG)lgLoad();adTabs();return;}
  if(!AD){adPick();adLoad();}
  if(!SH)shLoad();
  if(!ML)mlLoad();
  pbSync();
  if(!clDraft)clLoad();else clRender();
  adVersions();
  const numIn=(id,val,attrs,label)=>`<input id="${id}" type="number" inputmode="decimal" min="0" value="${val==null?'':esc(val)}" ${attrs} aria-label="${esc(label)}">`;
  const has=AD.templates.length>0;
  /* plan */
  $('#ad-planstate').innerHTML=has
    ?`<span class="chip info">${AD.templates.length} day template${AD.templates.length>1?'s':''}</span> Each new day starts from the template its weekday uses (set in the week below) – or pick another on the Daily Tracker.`
    :'<span class="chip">No plan yet</span> Upload your plan, read a PDF with AI, or add a day template below and build it here.';
  $('#ad-upmsg').innerHTML=(adMsg?`<p class="admsg">${esc(adMsg)}</p>`:'')+(adErrs.length?`<ul class="aderr">${adErrs.slice(0,12).map(e=>`<li>${esc(e)}</li>`).join('')}${adErrs.length>12?`<li>…and ${adErrs.length-12} more</li>`:''}</ul>`:'')
    +(adNotes.length?`<details class="adnotes" open><summary>What the AI estimated or left out (${adNotes.length})</summary><ul>${adNotes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></details>`:'');
  adAiPreview();
  const full=AD.templates.length>=AD_MAX_TPL;
  $('#ad-types').innerHTML=AD.templates.map(t=>`<button type="button" data-ad="type" data-t="${esc(t.id)}" aria-pressed="${t.id===adType}">${esc(t.name)}</button>`).join('')
    +`<button type="button" class="adtadd" data-ad="tadd"${full?' disabled':''}>+ New day template</button>`;
  $('#ad-tpl').innerHTML=has&&adType?`<label class="f adtname"><span class="lbl">Template name</span><input id="ad-tn" data-ad="tname" maxlength="40" value="${esc(adTplName(adType))}"></label>
      <span class="adtacts"><button type="button" class="ghost" data-ad="tdup"${full?' disabled':''}>Duplicate</button>
      <button type="button" class="ghost" data-ad="tdel">Delete template</button></span>`:'';
  const foodIds=()=>Object.keys(AD.foods).concat(AD.pud?['pudding']:[]);
  const grp=f=>f==='pudding'?(AD.pud.group||'c'):(AD.foods[f]||{}).group;
  const foodOpts=(sel,box)=>{const ids=foodIds().filter(f=>box==='x'?grp(f)==='x':grp(f)!=='x');
    if(sel&&!ids.includes(sel))ids.unshift(sel);
    return ids.map(f=>`<option value="${esc(f)}"${f===sel?' selected':''}>${esc(adFoodName(f))}</option>`).join('');};
  const meals=has&&adType?AD.plan[adType]||[]:[];
  $('#ad-meals').innerHTML=!has?'':meals.map((m,mi)=>`<section class="meal admeal">
      <header class="adhead"><span class="mn">Meal ${esc(m.id)}</span>
        <input id="ad-mn-${mi}" class="adname" data-ad="mname" data-m="${mi}" value="${esc(m.name)}" aria-label="Meal name">
        <button type="button" class="x" data-ad="mdel" data-m="${mi}" aria-label="Remove meal ${esc(m.id)}">×</button></header>
      <input id="ad-note-${mi}" class="adnote" data-ad="mnote" data-m="${mi}" value="${esc(m.note||'')}" placeholder="Note (optional)" aria-label="Meal note">
      <span class="ml" id="ad-mt-${mi}"></span>
      <div class="boxes">${AD_BOXES.map(([b,l])=>`<div class="box"><span class="lbl">${l}</span>
        ${(m[b]||[]).map((i,ii)=>{const u=(AD.foods[i.f]||FOODS[i.f]||{}).unit||'g';const k=`${mi}-${b}-${ii}`;
          return `<div class="adrow"><select id="ad-f-${k}" data-ad="ifood" data-m="${mi}" data-b="${b}" data-i="${ii}" aria-label="Food">${foodOpts(i.f,b)}</select>
          <span class="amt">${numIn('ad-g-'+k,i.g,`step="1" data-ad="igram" data-m="${mi}" data-b="${b}" data-i="${ii}"`,'Amount')}<em>${esc(u)}</em></span>
          <label class="lock"><input type="checkbox" id="ad-l-${k}" data-ad="ilock" data-m="${mi}" data-b="${b}" data-i="${ii}"${i.lock?' checked':''}><span>Lock</span></label>
          <button type="button" class="x" data-ad="idel" data-m="${mi}" data-b="${b}" data-i="${ii}" aria-label="Remove">×</button></div>`;}).join('')||'<p class="empty">Nothing here</p>'}
        <div class="add"><select id="ad-a-${mi}-${b}" data-ad="iadd" data-m="${mi}" data-b="${b}" aria-label="Add a food"><option value="">${foodIds().length?'+ Add a food…':'+ Add foods in My foods first'}</option>${foodOpts(null,b)}</select></div>
      </div>`).join('')}</div></section>`).join('')
    +`${meals.length?'':'<p class="empty">No meals in this template yet.</p>'}<div class="adplanfoot"><span class="ml" id="ad-tot"></span><button type="button" class="ghost" data-ad="madd"${meals.length>=12?' disabled':''}>+ Add a meal</button></div>`;
  /* week & targets */
  const opts=sel=>AD.templates.map(t=>`<option value="${esc(t.id)}"${sel===t.id?' selected':''}>${esc(t.name)}</option>`).join('');
  $('#ad-week').innerHTML=has?DAYS.map((d,i)=>`<label class="f"><span class="lbl">${d}</span><select id="ad-wd-${i}" data-ad="wday" data-i="${i}">${opts(AD.schedule[i])}</select></label>`).join('')
    :'<p class="empty">Add a day template first.</p>';
  $('#ad-targets').innerHTML=has?'<span></span><span class="lbl">kcal</span><span class="lbl">Protein g</span><span class="lbl">Carbs g</span><span class="lbl">Fat g</span>'+
    AD.templates.map(({id,name})=>`<span class="adtl">${esc(name)}</span>`+MAC.map(m=>numIn(`ad-tg-${esc(id)}-${m}`,AD.targets[id][m],`data-ad="target" data-t="${esc(id)}" data-k="${m}"`,`${name} ${m}`)).join('')).join('')
    :'';
  $('#ad-targets').hidden=!has;
  /* free foods */
  $('#ad-free').innerHTML=AD_FREE.map(([x,l,hint])=>`<label class="tog"><input type="checkbox" id="ad-free-${x}" data-ad="free" data-k="${x}"${AD.free[x]?' checked':''}> ${l} are free <span class="muted">– ${hint}</span></label>`).join('');
  /* foods */
  const groups={p:'Protein swaps',c:'Carb swaps',x:'Fat swaps','':'Not in a swap list'};
  const ids=Object.keys(AD.foods);
  $('#ad-foods').innerHTML=(ids.length?'':'<p class="empty">No foods yet. Add the foods your plan uses above, or upload a plan.</p>')+ids.map(id=>{const r=AD.foods[id];
    const isNew=!AD_BASE.foods[id], edited=!isNew&&!same(r,AD_BASE.foods[id]);
    const fld=(k,label,attrs='')=>`<label class="f"><span class="lbl">${label}</span>${numIn(`ad-fd-${esc(id)}-${k}`,r[k],`step="any" data-ad="food" data-id="${esc(id)}" data-k="${k}" ${attrs}`,`${r.n} ${label}`)}</label>`;
    return `<details class="adfood" data-id="${esc(id)}"${adOpen.has(id)?' open':''}><summary><span class="adfn">${esc(r.n)}</span>
        ${isNew?'<span class="chip info">New</span>':edited?'<span class="chip info">Changed</span>':''}
        <span class="ml" id="ad-fs-${esc(id)}">${adFoodLine(r)}</span></summary>
      <div class="adfgrid">
        <label class="f adwide"><span class="lbl">Name</span><input id="ad-fd-${esc(id)}-n" data-ad="food" data-id="${esc(id)}" data-k="n" value="${esc(r.n)}"></label>
        ${fld('k',`kcal / 100${esc(r.unit)}`)}${fld('p','Protein')}${fld('c','Carbs')}${fld('f','Fat')}${fld('d','Direct protein')}
        ${fld('step','Step')}${fld('min','Min serving')}${fld('max','Max serving')}${fld('order','Daily order')}
        <label class="f"><span class="lbl">Unit</span><select id="ad-fd-${esc(id)}-unit" data-ad="food" data-id="${esc(id)}" data-k="unit">${['g','ml'].map(u=>`<option${r.unit===u?' selected':''}>${u}</option>`).join('')}</select></label>
        <label class="f"><span class="lbl">Swap list</span><select id="ad-fd-${esc(id)}-group" data-ad="food" data-id="${esc(id)}" data-k="group">${Object.entries(groups).map(([g,n])=>`<option value="${g}"${r.group===g?' selected':''}>${n}</option>`).join('')}</select></label>
        <label class="f"><span class="lbl">Free food</span><select id="ad-fd-${esc(id)}-free" data-ad="food" data-id="${esc(id)}" data-k="free">${AD_FREE_OPTS.map(([x,n])=>`<option value="${x}"${(r.free||'')===x?' selected':''}>${n}</option>`).join('')}</select></label>
      </div>
      <div class="adfact">${edited?`<button type="button" class="ghost" data-ad="freset" data-id="${esc(id)}">Undo changes</button>`:''}
        <button type="button" class="ghost" data-ad="fdel" data-id="${esc(id)}">Delete food</button></div>
    </details>`;}).join('');
  adStatus();adTotals();
}
/* your plan changes, each with the date it takes effect from */
const adWhen=f=>f?fmtLong(f):'the start';
function adVersions(){
  const el=$('#ad-versions'),list=DEFS.myVersions||[];el.hidden=!list.length;
  if(el.hidden){el.innerHTML='';return;}
  const now=mineOn(todayStr());
  el.innerHTML=`<h3 class="lbl">Plan changes</h3><ul class="advers">${list.slice().reverse().map(v=>{
    const k=v.from||'',state=v===now?'<span class="chip ok">In use today</span>':v.from&&v.from>todayStr()?'<span class="chip info">Scheduled</span>':'<span class="chip">Earlier</span>';
    return `<li class="adver${v===adVer?' on':''}"><span class="advw"><b>From ${esc(adWhen(v.from))}</b> ${state}${v===adVer?' <span class="chip info">Editing</span>':''}</span>
      <span class="sub">${adEmpty(v)?'No plan':esc((v.templates||[]).map(t=>t.name).join(' · '))}</span>
      <span class="sb">${v===adVer?'':`<button type="button" class="ghost" data-ad="vedit" data-from="${esc(k)}">Edit</button>`}
        <button type="button" class="ghost" data-ad="vdel" data-from="${esc(k)}">Delete</button></span></li>`;}).join('')}</ul>`;
}
function adFoodLine(r){return `${r0(+r.k||0)} kcal · P ${r1(+r.p||0)} · C ${r1(+r.c||0)} · F ${r1(+r.f||0)} per 100${esc(r.unit)}`;}
function adTotals(){
  if(!adType||!AD.plan[adType]){const el=$('#ad-tot');if(el)el.innerHTML='';return;}
  const meals=AD.plan[adType];const tg=AD.targets[adType];
  meals.forEach((m,mi)=>{const el=$('#ad-mt-'+mi);if(el)el.innerHTML=macLine(sum(['p','c','x'].flatMap(b=>(m[b]||[]).map(i=>adMac(i.f,+i.g||0)))));});
  const t=sum(meals.flatMap(m=>['p','c','x'].flatMap(b=>(m[b]||[]).map(i=>adMac(i.f,+i.g||0)))));
  const el=$('#ad-tot');
  if(el)el.innerHTML=`<b>${esc(adTplName(adType))} as written:</b> ${r0(t.k)} kcal · P ${r1(t.p)} · C ${r1(t.c)} · F ${r1(t.f)} – target ${r0(+tg.k)} kcal · P ${r0(+tg.p)} · C ${r0(+tg.c)} · F ${r0(+tg.f)}. Each new day balances these amounts to its targets.`;
}
function adStatus(){
  const d=adDirty(), fe=$('#ad-from');
  fe.min='2000-01-01';fe.max=lastDate();
  if(document.activeElement!==fe&&!adFromBad)fe.value=adFrom;
  fe.setAttribute('aria-invalid',String(adFromBad));$('#ad-fromhint').classList.toggle('bad',adFromBad);
  const later=(DEFS.myVersions||[]).filter(v=>v.from&&v.from>(adFrom||'')&&v!==adVer).map(v=>fmtShort(v.from));
  $('#ad-fromhint').textContent=adFromBad?'Pick a date from 2000 to a year from today – or clear the box for “from the start”. Nothing is saved until then.':(adFrom?`Your days from ${fmtShort(adFrom)} start from this plan; earlier days keep the plan they had.`:'Every day starts from this plan, back to the start.')
    +(later.length?` Later changes still apply from ${later.join(', ')}.`:'');
  $('#ad-status').innerHTML=adBusy?'<span class="chip info">Saving…</span>'
    :d?'<span class="chip bad">Unsaved changes</span> Nothing changes for your days until you save.'
    :!AD.templates.length&&adEmpty(adVer)?(adVer?`<span class="chip">No plan from ${esc(adVer.from?fmtShort(adVer.from):'the start')}</span> ${adVer.from?'Your days from then have no meal plan until a later change.':'Your days have no meal plan.'} Add a day template or upload a plan, then save it.`
      :'<span class="chip">No plan saved yet</span> Add a day template or upload a plan, then save it.')
    :`<span class="chip ok">✓ Saved</span> ${adVer&&adVer.from?`Your days from ${esc(fmtShort(adVer.from))} start from this plan.`:'Your new days start from this plan.'} Days already in your history keep their own amounts.`;
  $('#ad-save').disabled=!d||adBusy||adFromBad;$('#ad-discard').hidden=!d;
}

/* ---------- editing ---------- */
const adMeal=el=>AD.plan[adType][+el.dataset.m];
const adItem=el=>adMeal(el)[el.dataset.b][+el.dataset.i];
function adNewId(name){let base=String(name).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').replace(/^(?=[^a-z])/,'f_').slice(0,24)||'food';
  let id=base,n=2;while(AD.foods[id]||id==='pudding')id=`${base}_${n++}`;return id;}

document.addEventListener('input',e=>{
  const el=e.target, a=el.dataset.ad; if(!a||!AD)return;
  if(a==='igram'){adItem(el).g=Math.max(0,+el.value||0);adTotals();}
  else if(a==='mname'){adMeal(el).name=el.value;}
  else if(a==='mnote'){const m=adMeal(el);if(el.value)m.note=el.value;else delete m.note;}
  else if(a==='tname'){const t=adTpl(adType);if(!t)return;t.name=el.value.slice(0,40);
    const b=document.querySelector(`#ad-types [data-t="${CSS.escape(adType)}"]`);if(b)b.textContent=t.name;}
  else if(a==='target'){AD.targets[el.dataset.t][el.dataset.k]=+el.value||0;adTotals();}
  else if(a==='food'&&el.tagName==='INPUT'){const r=AD.foods[el.dataset.id],k=el.dataset.k;
    if(k==='n')r.n=el.value;else if(['min','max','order'].includes(k))r[k]=el.value===''?null:+el.value;else r[k]=+el.value||0;
    const s=$('#ad-fs-'+el.dataset.id);if(s)s.innerHTML=adFoodLine(r);
    if(k==='n'&&el.closest('details'))el.closest('details').querySelector('.adfn').textContent=r.n;
    adTotals();}
  else return;
  adStatus();
});
document.addEventListener('change',e=>{
  const el=e.target, a=el.dataset.ad; if(!a||!AD)return;
  if(a==='ilock'){adItem(el).lock=el.checked;}
  else if(a==='ifood'){adItem(el).f=el.value;renderAdmin();}
  else if(a==='iadd'){if(!el.value)return;const f=el.value,F=AD.foods[f]||FOODS[f];
    const m=adMeal(el);(m[el.dataset.b]=m[el.dataset.b]||[]).push({f,g:F.min||(F.step>=5?50:10),lock:false});renderAdmin();}
  else if(a==='tname'){const t=adTpl(adType);if(t&&!t.name.trim())t.name='Day template';renderAdmin();}
  else if(a==='wday'){AD.schedule[+el.dataset.i]=el.value;}
  else if(a==='free'){AD.free[el.dataset.k]=el.checked;adTotals();}
  else if(a==='from'){const v=el.value;adFromBad=el.validity.badInput||(v!==''&&!isDate(v));if(!adFromBad){adFrom=v;adFromToday=false;}}   /* only a box really left empty means from the start */
  else if(a==='aipick'){if(adAiPend)adAiPend.on[el.dataset.key]=el.checked;return;}
  else if(a==='food'&&el.tagName==='SELECT'){AD.foods[el.dataset.id][el.dataset.k]=el.value;const s=$('#ad-fs-'+el.dataset.id);if(s)s.innerHTML=adFoodLine(AD.foods[el.dataset.id]);adTotals();}
  else return;
  adStatus();
});
document.addEventListener('toggle',e=>{const d=e.target;if(d.classList&&d.classList.contains('adfood')){if(d.open)adOpen.add(d.dataset.id);else adOpen.delete(d.dataset.id);}},true);
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-ad]'); if(!b||!AD||b.tagName==='INPUT'||b.tagName==='SELECT')return;
  const a=b.dataset.ad;
  if(a==='type'){adType=b.dataset.t;}
  else if(a==='tadd'){adType=adAddTpl(AD.templates.length?'New day template':'My day');renderAdmin();const i=$('#ad-tn');if(i){i.focus();i.select();}return;}
  else if(a==='tdup'){const from=adType;adType=adAddTpl(`${adTplName(from)} (copy)`.slice(0,40),from);renderAdmin();const i=$('#ad-tn');if(i){i.focus();i.select();}return;}
  else if(a==='tdel'){adDelTpl();return;}
  else if(a==='idel'){adMeal(b)[b.dataset.b].splice(+b.dataset.i,1);}
  else if(a==='mdel'){const m=adMeal(b);if(!confirm(`Remove meal ${m.id} (${m.name}) from ${adTplName(adType)}?`))return;
    AD.plan[adType].splice(+b.dataset.m,1);}
  else if(a==='madd'){const ms=AD.plan[adType];const n=ms.reduce((x,m)=>Math.max(x,parseInt(m.id,10)||0),0)+1;
    ms.push({id:String(n),name:'New meal',p:[],c:[],x:[]});}
  else if(a==='freset'){AD.foods[b.dataset.id]=clone(AD_BASE.foods[b.dataset.id]);}
  else if(a==='fdel'){const id=b.dataset.id;
    if(adPlanUses(id)){alert(`${adFoodName(id)} is in your meal plan. Take it out of the plan first.`);return;}
    if(!confirm(`Delete ${adFoodName(id)} from your foods?`))return;
    delete AD.foods[id];adOpen.delete(id);}
  else if(a==='csv'){adDownload(`logbook-monster-plan-${todayStr()}.csv`,planCsv(AD.plan),'text/csv');return;}
  else if(a==='json'){adDownload(`logbook-monster-plan-${todayStr()}.json`,JSON.stringify(adPayload(),null,2),'application/json');return;}
  else if(a==='discard'){adPick(adVer);adLoad();adMsg='';adErrs=[];adNotes=[];}
  else if(a==='vedit'){const v=(DEFS.myVersions||[]).find(x=>(x.from||'')===b.dataset.from);if(!v)return;
    if(adDirty()&&!confirm('Drop your unsaved changes and edit this plan instead?'))return;
    adPick(v);adLoad();adMsg='';adErrs=[];adNotes=[];}
  else if(a==='vdel'){adDelete(b.dataset.from||null);return;}
  else if(a==='save'){adSave();return;}
  else if(a==='aiuse'){if(adAiPend)adAiUse();}
  else if(a==='aidrop'){adAiPend=null;adNotes=[];jobSeen('plan');}
  else return;
  renderAdmin();
});
/* delete a day template; weekdays that used it move to the first one left */
function adDelTpl(){
  const id=adType,t=adTpl(id);if(!t)return;
  const days=DAYS.filter((_,i)=>AD.schedule[i]===id);
  const rest=AD.templates.filter(x=>x.id!==id);
  if(!confirm(`Delete the ${t.name} template and its meals?`+(days.length&&rest.length?` ${days.join(', ')} will use ${rest[0].name} instead.`:'')+' Days already in your history keep their own amounts.'))return;
  AD.templates=rest;delete AD.plan[id];delete AD.targets[id];
  AD.schedule=AD.schedule.map(x=>x===id?(rest[0]?rest[0].id:null):x);
  adType=rest.length?rest[0].id:null;
  renderAdmin();
}
$('#ad-addfood').addEventListener('submit',e=>{
  e.preventDefault();const v=id=>$('#'+id).value;
  const n=v('ad-nf-n').trim();if(!n){$('#ad-nf-n').focus();return;}
  const group=v('ad-nf-g'),p=+v('ad-nf-p')||0;
  const id=adNewId(n);
  AD.foods[id]={group,n,k:+v('ad-nf-k')||0,p,c:+v('ad-nf-c')||0,f:+v('ad-nf-f')||0,d:group==='p'?p:0,step:group==='x'?1:5,unit:'g',min:null,max:null,order:null,free:''};
  adOpen.add(id);['ad-nf-n','ad-nf-k','ad-nf-p','ad-nf-c','ad-nf-f'].forEach(x=>{$('#'+x).value='';});
  renderAdmin();
  const d=document.querySelector(`.adfood[data-id="${id}"]`);if(d)d.scrollIntoView({block:'nearest'});
});
/* super admin: CSV / JSON plan files on or off for everyone */
$('#ad-planfiles').addEventListener('change',async e=>{
  const el=e.target;el.disabled=true;
  try{planFiles=(await api('PUT','/api/admin/options',{planFiles:el.checked})).planFiles;}
  catch(err){if(!err.signedOut)alert(err.message);}
  el.disabled=false;el.checked=planFiles;$('#v-admin').classList.toggle('nofiles',!planFiles);
});
/* super admin: private AI providers only, and the daily AI caps (0 = no limit) */
function aoFill(o){$('#ad-aiprivate').checked=o.aiPrivate!==false;$('#ad-admintotp').checked=!!o.adminTotp;$('#ad-capuser').value=o.aiDailyUser;$('#ad-capall').value=o.aiDailyAll;}
async function aoLoad(){const o=await loadTry('ao',()=>api('GET','/api/admin/options')).catch(()=>null);if(o)aoFill(o);
  $('#ad-capmsg').innerHTML=LOADERR.ao?loadErr('the options','ao'):'';}
$('#ad-aiprivate').addEventListener('change',async e=>{
  const el=e.target;el.disabled=true;
  try{aoFill(await api('PUT','/api/admin/options',{aiPrivate:el.checked}));}
  catch(err){if(!err.signedOut)alert(err.message);aoLoad();}
  el.disabled=false;
});
$('#ad-admintotp').addEventListener('change',async e=>{
  const el=e.target;el.disabled=true;
  try{aoFill(await api('PUT','/api/admin/options',{adminTotp:el.checked}));}
  catch(err){if(!err.signedOut)alert(err.message);aoLoad();}
  el.disabled=false;
});
$('#ad-capform').addEventListener('submit',async e=>{
  e.preventDefault();
  try{aoFill(await api('PUT','/api/admin/options',{aiDailyUser:+$('#ad-capuser').value,aiDailyAll:+$('#ad-capall').value}));$('#ad-capmsg').textContent='Limits saved.';}
  catch(err){if(!err.signedOut)$('#ad-capmsg').textContent=err.message;}
});
$('#ad-file').addEventListener('change',e=>{const el=e.target;adUpload(el.files&&el.files[0]).finally(()=>{el.value='';});});
window.addEventListener('beforeunload',e=>{if(adDirty()){e.preventDefault();e.returnValue='';}});

/* what the server would refuse in your foods, said before sending */
function adFoodErrs(){
  const out=[];
  for(const r of Object.values(AD.foods)){const n=r.n||'A food';
    if(r.min!=null&&r.max!=null&&+r.min>+r.max)out.push(`${n}: the min serving (${r.min}) is more than the max serving (${r.max}).`);
    if((+r.d||0)>(+r.p||0))out.push(`${n}: direct protein (${+r.d||0}) is more than its protein (${+r.p||0}).`);}
  return out;
}
async function adSave(){
  if(adFromToday&&adFrom<todayStr())adFrom=todayStr();
  if(adFromBad){adErrs=['Pick a date from 2000 to a year from today in “Takes effect from”.'];adMsg='Couldn’t save:';renderAdmin();return;}
  const errs=adFoodErrs();
  if(errs.length){adErrs=errs;adMsg='Couldn’t save – fix these first:';renderAdmin();return;}
  const p=adPayload();
  if(!p.templates.length&&!Object.keys(p.foods).length
    &&!confirm(`This plan has no day templates or foods, so your days ${adFrom?`from ${fmtShort(adFrom)}`:'from the start'} will have no meal plan. Save it anyway?`))return;
  adBusy=true;adStatus();
  try{const from=adFrom||null, cur=(DEFS.myVersions||[]).find(v=>(v.from||null)===from);   /* the change this save replaces, as this tab has it */
    adSaved_(await api('PUT','/api/my/defaults',{...adPayload(),from},(cur&&cur.updatedAt)||null),from);}
  catch(err){if(!err.signedOut){adErrs=[err.message];adMsg='Couldn’t save:';}}
  adBusy=false;renderAdmin();
}
/* after a save: days (from the change's date) you haven't saved yet start again from the new plan */
function adSaved_(r,from){
  setDefaults(r);
  for(const d of Object.keys(S.days)) if((!from||d>=from)&&!LOGGED.has(d)&&!pending.has(d)){delete S.days[d];delete SAVED.days[d];}
  adPick(from===undefined?undefined:(DEFS.myVersions||[]).find(v=>v.from===from));
  adLoad();adMsg='';adErrs=[];
}
async function adDelete(from){
  const list=DEFS.myVersions||[],v=list.find(x=>x.from===from);if(!v)return;
  const prev=list[list.indexOf(v)-1];
  if(!confirm(`Delete the plan change from ${adWhen(from)}? Those days go back to ${prev?`the plan from ${adWhen(prev.from)}`:'having no plan'}.`))return;
  const was=v===adVer;
  if(was&&adDirty()&&!confirm('You have unsaved changes to this plan. Drop them?'))return;
  const keep=adVer&&adVer.from;
  try{const r=await api('DELETE','/api/my/defaults/'+(from||'start'));
    setDefaults(r);
    for(const d of Object.keys(S.days)) if((!from||d>=from)&&!LOGGED.has(d)&&!pending.has(d)){delete S.days[d];delete SAVED.days[d];}
    if(was){adPick();adLoad();}else adVer=(DEFS.myVersions||[]).find(x=>x.from===keep)||null;   /* the draft you're editing stays as it is */
  }catch(err){if(!err.signedOut)alert(err.message);return;}
  renderAdmin();
}
function adDownload(name,text,type){
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

/* ---------- plan files: CSV (one row per food) or JSON ---------- */
const CSV_COLS=['day_type','meal','meal_name','box','food','grams','locked','note','food_name'];
/* a cell starting with = + - @ (or tab / CR) would run as a formula in Excel or Sheets: keep it text */
function csvCell(v){v=String(v==null?'':v);if(/^[=+\-@\t\r]/.test(v))v="'"+v;return /[",;\t\n\r]/.test(v)?`"${v.replace(/"/g,'""')}"`:v;}
function planCsv(plan){
  const rows=[CSV_COLS.join(',')];
  AD.templates.forEach(({id,name})=>(plan[id]||[]).forEach(m=>{let first=true;
    const items=AD_BOXES.flatMap(([b])=>(m[b]||[]).map(i=>[b,i]));
    if(!items.length)items.push(['c',null]);
    items.forEach(([b,i])=>{rows.push([name,m.id,m.name,{p:'protein',c:'carbs',x:'fats'}[b],i?i.f:'',i?i.g:'',i&&i.lock?'yes':'',first?m.note||'':'',i?adFoodName(i.f):''].map(csvCell).join(','));first=false;});
  }));
  return rows.join('\r\n')+'\r\n';
}
/* the template a CSV's day_type names: by name or id, the old words for training / rest / Saturday, or a new one */
function csvTemplate(v,made){
  const k=v.trim().toLowerCase().replace(/[\s_-]+/g,' ');if(!k)return null;
  const all=AD.templates.concat(made);
  let t=all.find(x=>x.name.toLowerCase().replace(/[\s_-]+/g,' ')===k||x.id.toLowerCase()===k);
  const old={t:'T',training:'T',train:'T',r:'R',rest:'R',s:'S',saturday:'S',sat:'S','saturday training':'S'}[k];
  if(!t&&old)t=all.find(x=>x.id===old);
  if(!t){if(all.length>=AD_MAX_TPL)return null;
    let n=all.length+1,id;do{id='D'+n++;}while(all.some(x=>x.id===id));
    const n0=v.trim().slice(0,40);t={id,name:n0.charAt(0).toUpperCase()+n0.slice(1)};made.push(t);}
  return t.id;
}
function csvToPlan(text){
  const rows=GymCsv.parseCsv(text);const errs=[],made=[];   /* the separator the heading row uses: "152,5" stays one cell in a ; file */
  if(!rows.length)return {errs:['The file is empty.']};
  const head=rows[0].map(h=>h.trim().toLowerCase().replace(/[\s-]+/g,'_'));
  const col=n=>head.indexOf(n);
  ['day_type','meal','food','grams'].forEach(n=>{if(col(n)<0)errs.push(`Missing the "${n}" column. The first row must be the headings: ${CSV_COLS.slice(0,8).join(', ')}.`);});
  if(errs.length)return {errs};
  const byName={};Object.keys(AD.foods).concat(AD.pud?['pudding']:[]).forEach(id=>{byName[id]=id;byName[adFoodName(id).toLowerCase()]=id;});
  const boxOf=v=>({p:'p',protein:'p',c:'c',carb:'c',carbs:'c',x:'x',f:'x',fat:'x',fats:'x',additional_fats:'x'})[v.trim().toLowerCase().replace(/[\s-]+/g,'_')];
  const plan={};
  /* grams as written: 152.5 or 152,5; a lone 1,500 is read by the file's other amounts (or the separator), never guessed */
  const mark=GymCsv.decimalMark(rows.slice(1).map(r=>String(r[col('grams')]||'')))||(GymCsv.csvSep(text)===','?'.':null);
  rows.slice(1).forEach((r,ri)=>{
    const line=ri+2, get=n=>col(n)<0?'':String(r[col(n)]||'').trim().replace(/^'(?=[=+\-@\t\r])/,'');   /* the ' csvCell adds */
    const t=csvTemplate(get('day_type'),made);
    if(!t){errs.push(get('day_type')?`Line ${line}: day type "${get('day_type')}" would be a new day template, but a plan can have ${AD_MAX_TPL} at most.`:`Line ${line}: give the name of a day template in day_type.`);return;}
    const mid=get('meal');if(!mid){errs.push(`Line ${line}: meal number is missing.`);return;}
    const ms=plan[t]||(plan[t]=[]);
    let m=ms.find(x=>x.id===mid);
    if(!m){m={id:mid,name:get('meal_name')||`Meal ${mid}`,p:[],c:[],x:[]};ms.push(m);}
    if(get('note')&&!m.note)m.note=get('note');
    const fv=get('food');if(!fv)return;           /* a meal with no foods */
    const f=byName[fv.toLowerCase()];
    if(!f){errs.push(`Line ${line}: unknown food "${fv}". Use a food id or name from My foods, or add it there first.`);return;}
    const g=GymCsv.readNum(get('grams'),mark);
    if(g===GymCsv.AMBIGUOUS){errs.push(`Line ${line}: amount "${get('grams')}" could be ${get('grams').replace(',','')} or ${get('grams').replace(',','.')} – write it without the comma.`);return;}
    if(g==null||!Number.isFinite(g)||g<0||g>5000){errs.push(`Line ${line}: amount "${get('grams')}" isn't a number of grams (0 to 5000).`);return;}
    const grp=f==='pudding'?'c':(AD.foods[f]||{}).group;
    const b=get('box')?boxOf(get('box')):grp==='p'?'p':grp==='x'?'x':'c';
    if(!b){errs.push(`Line ${line}: box "${get('box')}" should be protein, carbs or fats.`);return;}
    m[b].push({f,g,lock:/^(y|yes|true|1|x|locked)$/i.test(get('locked'))});
  });
  if(!Object.keys(plan).length&&!errs.length)errs.push('No plan rows found under the headings.');
  return {plan,errs,made};
}
/* a plan file is shown before the server checks it: keep only what defaults.clean would (ids, numbers, known words) */
const AD_TPL_ID=/^[A-Za-z][A-Za-z0-9_]{0,15}$/,AD_FOOD_ID=/^[a-z][a-z0-9_]{0,31}$/;
const adOwnId=(o,id)=>!(id in Object.prototype)&&Object.prototype.hasOwnProperty.call(o,id);
const adNum=v=>{const n=+v;return Number.isFinite(n)?n:0;},adOpt=v=>v===''||v==null||!Number.isFinite(+v)?null:+v;
function adCleanFood(r){
  const o={n:String(r.n==null?'':r.n).slice(0,80)};
  ['k','p','c','f','d','step'].forEach(k=>{if(r[k]!==undefined)o[k]=adNum(r[k]);});
  ['min','max','order'].forEach(k=>{if(r[k]!==undefined)o[k]=adOpt(r[k]);});
  if(r.unit!==undefined)o.unit=r.unit==='ml'?'ml':'g';
  if(r.group!==undefined)o.group=['p','c','x'].includes(r.group)?r.group:'';
  if(r.free!==undefined)o.free=FREE_KINDS.includes(r.free)?r.free:'';
  return o;
}
const adCleanItem=i=>({f:String(i.f),g:adNum(i.g),lock:!!i.lock});
/* add templates a file (or the AI) brings; a known id keeps its place and takes the file's name */
/* rename: false for templates a file only implies (meals under T, R, S with no list) – yours keep their names */
function adTakeTemplates(list,rename=true){
  for(const t of Array.isArray(list)?list:[]){if(!t||typeof t.id!=='string'||!AD_TPL_ID.test(t.id))continue;const id=t.id,name=String(t.name||AD_LEGACY[id]||id).slice(0,40);
    const ex=adTpl(id);if(ex){if(rename)ex.name=name;continue;}
    if(AD.templates.length>=AD_MAX_TPL)continue;
    AD.templates.push({id,name});AD.plan[id]=AD.plan[id]||[];AD.targets[id]=AD.targets[id]||(adType&&AD.targets[adType]?{...AD.targets[adType]}:ZT());
    if(AD.templates.length===1)AD.schedule=DAYS.map(()=>id);}
  AD.schedule=AD.schedule.map(x=>adTpl(x)?x:AD.templates[0]?AD.templates[0].id:null);
}
/* load a plan-shaped object (a JSON file or the AI's reading of a PDF) into the draft; returns the templates it filled */
function adMeals(list){
  const items=v=>Array.isArray(v)?v.filter(i=>i&&typeof i==='object'&&i.f!=null).map(adCleanItem):[];
  return list.filter(m=>m&&typeof m==='object').map((m,mi)=>({id:String(m.id==null||m.id===''?mi+1:m.id).slice(0,8),   /* no number: its place, as the server does */name:String(m.name||'').slice(0,100),...(m.note?{note:String(m.note).slice(0,200)}:{}),
    p:items(m.p),c:items(m.c),x:items(m.x)}));
}
function adApplyJson(j){
  const full=j&&(j.plan||j.foods||j.schedule||j.targets||j.templates);
  const plan=full?j.plan:j;
  /* the day templates: as listed, or the old T / R / S a file uses; more than a plan can have is refused, not cut short */
  let tl=full&&Array.isArray(j.templates)?j.templates:null;
  const listed=!!tl;
  if(!tl){const used=new Set([...Object.keys(plan&&typeof plan==='object'?plan:{}),...Object.keys((full&&j.targets)||{}),...((full&&Array.isArray(j.schedule))?j.schedule:[])]);
    tl=Object.keys(AD_LEGACY).filter(t=>used.has(t)).map(id=>({id,name:AD_LEGACY[id]}));}
  const fresh=new Set(tl.filter(t=>t&&typeof t.id==='string'&&AD_TPL_ID.test(t.id)&&!adTpl(t.id)).map(t=>t.id));
  if(AD.templates.length+fresh.size>AD_MAX_TPL)throw new Error(`It has ${fresh.size} new day template${fresh.size>1?'s':''} and this plan has ${AD.templates.length} – a plan can have ${AD_MAX_TPL} at most. Delete some here or take some out of the file.`);
  if(full&&j.foods&&typeof j.foods==='object'){for(const [id,r] of Object.entries(j.foods)){if(r&&typeof r==='object'){
    if(id==='pudding'){AD.pud={...(AD.pud||{n:'Rice pudding (batch)',k:0,p:0,c:0,f:0,d:0,step:5,unit:'g',min:null,max:null,order:null,free:''}),group:['p','c','x'].includes(r.group)?r.group:'c'};continue;}
    if(!AD_FOOD_ID.test(id)||id in Object.prototype)continue;
    AD.foods[id]={...(AD.foods[id]||{n:id,k:0,p:0,c:0,f:0,group:'',unit:'g',min:null,max:null,order:null,d:0,step:5,free:''}),...adCleanFood(r)};}}}
  adTakeTemplates(tl,listed);
  if(full&&Array.isArray(j.schedule)&&j.schedule.length===7&&j.schedule.every(t=>typeof t==='string'&&adTpl(t)))AD.schedule=[...j.schedule];
  if(full&&j.free&&typeof j.free==='object')FREE_KINDS.forEach(x=>{if(j.free[x]!=null)AD.free[x]=!!j.free[x];});
  if(full&&j.targets&&typeof j.targets==='object')AD.templates.forEach(({id})=>{const v=adOwnId(j.targets,id)&&j.targets[id];
    if(v&&typeof v==='object')MAC.forEach(m=>{if(v[m]!==undefined)AD.targets[id][m]=adNum(v[m]);});});
  const got=[];
  if(plan&&typeof plan==='object'){AD.templates.forEach(({id})=>{if(!adOwnId(plan,id)||!Array.isArray(plan[id]))return;
      AD.plan[id]=adMeals(plan[id]);got.push(id);});
    if(got.length&&!got.includes(adType))adType=got[0];}
  return got;
}
async function adUpload(file){
  if(!file)return;adMsg='';adErrs=[];adNotes=[];
  if(file.size>1024*1024){adErrs=['That file is over 1 MB – is it the right one?'];renderAdmin();return;}
  const text=await file.text();
  if(/\.json$/i.test(file.name)||/^\s*\{/.test(text)){
    let j;try{j=JSON.parse(text);}catch{adErrs=['That JSON file couldn’t be read.'];renderAdmin();return;}
    let got;try{got=adApplyJson(j);}catch(e){adErrs=[e.message];adMsg=`${file.name} wasn’t loaded:`;renderAdmin();return;}
    if(!got.length&&!(j&&typeof j==='object'&&!Array.isArray(j)&&(j.foods||j.schedule||j.targets||j.templates))){
      adErrs=[`It has no meals for a day template (${AD.templates.map(t=>t.id).join(', ')||'none yet'}), foods, week or targets.`];adMsg=`${file.name} had nothing to load:`;renderAdmin();return;}
    adMsg=`Loaded ${file.name}. Check it below, then save.`;
  }else{
    const {plan,errs,made}=csvToPlan(text);
    if(errs.length){adErrs=errs;adMsg=`${file.name} wasn’t loaded:`;renderAdmin();return;}
    adTakeTemplates(made);
    const got=AD.templates.filter(({id})=>plan[id]);
    got.forEach(({id})=>{AD.plan[id]=plan[id];});
    if(got.length&&!got.some(t=>t.id===adType))adType=got[0].id;
    const left=AD.templates.filter(({id})=>!plan[id]);
    adMsg=`Loaded ${got.map(t=>t.name).join(', ')} from ${file.name}`+(made.length?` (new day template${made.length>1?'s':''}: ${made.map(t=>t.name).join(', ')})`:'')+
      (left.length?` – ${left.map(t=>t.name).join(', ')} kept as before`:'')+'. Check it below, then save.';
  }
  renderAdmin();
}

/* ---------- AI (OpenRouter) ---------- */
/* Only the super admin sees the AI settings (key, default model, a model per task); an account just needs to know whether reading is on. */
async function adAiLoad(){
  adAi={configured:aiOn};
  if(isAdmin){const r=await loadTry('ai',()=>api('GET','/api/admin/ai')).catch(()=>null);if(r){adAi=r;aiOn=r.configured;}}
  adAiRender();
  if(LOADERR.ai)$('#ad-aikeystate').innerHTML=loadErr('the AI settings','ai');
}
function adAiRender(){
  if(!adAi)return;
  const plan=(adAi.tasks||[]).find(t=>t.id==='plan');
  const busy=jobBusy('plan');
  $('#ad-aistate').textContent=busy?'Reading the plan – this can take a minute or two. You can leave this page; you’ll be told when it’s ready.'
    :adAi.configured?(plan?`Using ${plan.uses}`:'')
    :isAdmin?'Add an OpenRouter API key on the Super admin page (AI tab) to turn this on.':'The super admin needs to add an OpenRouter key first.';
  $('#ad-aibtn').classList.toggle('off',!adAi.configured||busy);
  $('#ad-aifile').disabled=!adAi.configured||busy;
  if(!adAi.tasks)return;
  $('#ad-aikeystate').innerHTML=adAi.configured?`<span class="chip ok">✓ Set up</span> Key ${esc(adAi.hint)}${adAi.source==='env'?' (from .env)':''}.`
    :'<span class="chip bad">Not set up</span> AI features are off for everyone until a key is saved.';
  $('#ad-key').placeholder=adAi.configured?'Paste a new key to replace it':'sk-or-…';
  $('#ad-keydel').hidden=adAi.source!=='admin';
  const md=$('#ad-model');
  if(document.activeElement!==md)md.value=adAi.model===adAi.defaultModel?'':adAi.model;
  md.placeholder=adAi.defaultModel;
  $('#ad-model-hint').textContent='Used for every task without its own model below.';
  const el=$('#ad-aitasks');
  if(!el.contains(document.activeElement))el.innerHTML=(adAi.tasks||[]).map(t=>`<label class="f admrow"><span class="lbl">${esc(t.name)}</span>
      <input id="ad-tm-${t.id}" data-task="${t.id}" autocomplete="off" spellcheck="false" value="${esc(t.model)}" placeholder="${esc(adAi.model)} (default)">
      <span class="sub">${esc(t.hint)}</span></label>`).join('');
}
$('#ad-keyform').addEventListener('submit',async e=>{
  e.preventDefault();const k=$('#ad-key').value.trim();if(!k){$('#ad-key').focus();return;}
  try{adAi=await api('PUT','/api/admin/ai',{key:k});aiOn=adAi.configured;$('#ad-key').value='';$('#ad-keymsg').textContent='Key saved.';}
  catch(err){if(!err.signedOut)$('#ad-keymsg').textContent=err.message;}
  adAiRender();
});
$('#ad-modelform').addEventListener('submit',async e=>{
  e.preventDefault();const models={};
  document.querySelectorAll('#ad-aitasks [data-task]').forEach(i=>{models[i.dataset.task]=i.value.trim();});
  try{adAi=await api('PUT','/api/admin/ai',{model:$('#ad-model').value.trim(),models});aiOn=adAi.configured;$('#ad-keymsg').textContent='Models saved.';document.activeElement.blur();}
  catch(err){if(!err.signedOut)$('#ad-keymsg').textContent=err.message;}
  adAiRender();
});
$('#ad-keydel').addEventListener('click',async()=>{
  if(!confirm('Remove the saved OpenRouter key? AI features stop working for everyone.'))return;
  try{adAi=await api('PUT','/api/admin/ai',{key:''});aiOn=adAi.configured;$('#ad-keymsg').textContent='Key removed.';}catch(err){if(!err.signedOut)$('#ad-keymsg').textContent=err.message;}
  adAiRender();
});
$('#ad-aifile').addEventListener('change',async e=>{
  const el=e.target, file=el.files&&el.files[0];el.value='';if(!file||jobBusy('plan'))return;
  if(file.size>10*1024*1024){adErrs=['That file is over 10 MB.'];adMsg='';renderAdmin();return;}
  adMsg='';adErrs=[];adNotes=[];
  adAiPend=null;jobSeen('plan');
  /* the AI is told the foods of the plan change open here, so it uses their ids */
  try{await jobStart('/api/my/ai-import'+(adVer?`?date=${adFrom||'1970-01-01'}`:''),'plan',file);}   /* read in the background: jobs.js brings the result to J_OPEN.plan */
  catch(err){if(err.signedOut)return;adMsg='The AI import didn’t work:';adErrs=[err.message];}
  adAiRender();renderAdmin();
});
J_BUSY.plan=adAiRender;
/* A finished read is not put into the plan at once: adAiPend holds it and the page shows what it would change (new,
   changed and unchanged day templates and foods, the week) against the plan open now, worked out afresh on every render.
   Nothing changes until "Use ticked"; a food of yours the AI gives other values for is taken only if ticked, and a
   template you've changed since opening it starts unticked. */
let adAiPend=null;
J_OPEN.plan=job=>{
  adErrs=[];adNotes=[];adAiPend=null;
  if(job.status!=='done'){adMsg='The AI import didn’t work:';adErrs=[job.error||'Something went wrong'];renderAdmin();return;}
  if(!AD){adPick();adLoad();}
  adMsg='';adAiPend={j:job.result,label:job.label||'your plan',on:{}};adNotes=job.result.notes||[];
  renderAdmin();
};
function adAiDiff(){
  const P=adAiPend, j=P.j, foods=[], tpls=[];
  const pick=(key,dflt)=>adOwnId(P.on,key)?P.on[key]:dflt;
  for(const [id,r] of Object.entries(j.foods&&typeof j.foods==='object'?j.foods:{})){
    if(!r||typeof r!=='object'||id==='pudding'||!AD_FOOD_ID.test(id)||id in Object.prototype)continue;
    const ai=adCleanFood(r), cur=AD.foods[id];
    const state=!cur?'new':Object.keys(ai).some(k=>ai[k]!==cur[k])?'changed':'same';
    foods.push({id,ai,cur,state,on:state==='new'||state==='changed'&&pick('f:'+id,false)});
  }
  for(const t of Array.isArray(j.templates)?j.templates:[]){
    if(!t||typeof t.id!=='string'||!AD_TPL_ID.test(t.id))continue;
    const id=t.id, name=String(t.name||AD_LEGACY[id]||id).slice(0,40), cur=adTpl(id);
    const meals=j.plan&&adOwnId(j.plan,id)&&Array.isArray(j.plan[id])?adMeals(j.plan[id]):null;
    const tg=j.targets&&adOwnId(j.targets,id)&&j.targets[id]&&typeof j.targets[id]==='object'?j.targets[id]:null;
    const tgSame=!tg||!cur||MAC.every(m=>tg[m]===undefined||adNum(tg[m])===(AD.targets[id]||{})[m]);
    const state=!cur?'new':(!meals||same(meals,AD.plan[id]||[]))&&tgSame&&cur.name===name?'same':'changed';
    const base=AD_BASE.templates.find(x=>x.id===id);
    const edited=!!cur&&(!base||base.name!==cur.name||!same(AD.plan[id],AD_BASE.plan[id])||!same(AD.targets[id],AD_BASE.targets[id]));
    tpls.push({id,name,cur,meals,state,edited,on:state!=='same'&&pick('t:'+id,!edited)});
  }
  const sch=Array.isArray(j.schedule)&&j.schedule.length===7&&!same(j.schedule,AD.schedule)?j.schedule:null;
  return {foods,tpls,sch,schOn:!!sch&&pick('s',true)};
}
function adAiPreview(){
  const el=$('#ad-aiprev');if(!el)return;
  el.hidden=!adAiPend;if(!adAiPend){el.innerHTML='';return;}
  const d=adAiDiff(), mealNames=ms=>ms&&ms.length?ms.map(m=>m.name||`Meal ${m.id}`).join(', '):'no meals';
  const box=(key,on,label)=>`<label class="adaipick"><input type="checkbox" data-ad="aipick" data-key="${esc(key)}"${on?' checked':''}> ${label}</label>`;
  const tl=d.tpls.filter(t=>t.state!=='same'), fl=d.foods.filter(f=>f.state==='changed'), nf=d.foods.filter(f=>f.state==='new');
  const sameT=d.tpls.filter(t=>t.state==='same').length, sameF=d.foods.filter(f=>f.state==='same').length;
  el.innerHTML=`<p class="admsg">AI read ${esc(adAiPend.label)}. Tick what to take – nothing changes until you press Use ticked, and nothing is saved until you save the plan.</p>
    ${tl.length?`<h4 class="lbl">Day templates</h4><ul class="adailist">${tl.map(t=>`<li>${box('t:'+t.id,t.on,t.state==='new'
      ?`<b>New:</b> ${esc(t.name)} – ${esc(mealNames(t.meals))}`
      :`<b>${esc(t.cur.name)}</b>${t.cur.name!==t.name?` → ${esc(t.name)}`:''}: replace yours (${esc(mealNames(AD.plan[t.id]))}) with the AI’s (${esc(mealNames(t.meals||AD.plan[t.id]))})${t.edited?' <span class="sub">– you’ve changed it since opening</span>':''}`)}</li>`).join('')}</ul>`:''}
    ${fl.length?`<h4 class="lbl">Your foods the AI gives other values for</h4><p class="sub">Yours are kept unless you tick one.</p><ul class="adailist">${fl.map(f=>`<li>${box('f:'+f.id,f.on,
      `Use the AI’s for <b>${esc(f.cur.n||f.id)}</b>: ${adFoodLine({...f.cur,...f.ai})} <span class="sub">(yours: ${adFoodLine(f.cur)})</span>`)}</li>`).join('')}</ul>`:''}
    ${nf.length?`<p>New food${nf.length>1?'s':''} added: ${esc(nf.map(f=>f.ai.n||f.id).join(', '))}.</p>`:''}
    ${d.sch?box('s',d.schOn,`Use the AI’s week: ${esc(DAYS.map((x,i)=>`${x} ${(adTpl(d.sch[i])||d.tpls.find(t=>t.id===d.sch[i])||{name:d.sch[i]}).name}`).join(', '))}`):''}
    ${sameT||sameF?`<p class="sub">Unchanged: ${[sameT?`${sameT} day template${sameT>1?'s':''}`:'',sameF?`${sameF} food${sameF>1?'s':''}`:''].filter(Boolean).join(', ')}.</p>`:''}
    ${!tl.length&&!fl.length&&!nf.length&&!d.sch?'<p>It matches the plan you have open – nothing to change.</p>':''}
    <div class="adtools"><button class="btn" type="button" data-ad="aiuse">Use ticked</button><button class="ghost" type="button" data-ad="aidrop">Discard</button></div>`;
}
function adAiUse(){
  const d=adAiDiff(), j=adAiPend.j, ids=new Set(d.tpls.filter(t=>t.on).map(t=>t.id));
  const only=o=>Object.fromEntries(Object.entries(o&&typeof o==='object'?o:{}).filter(([id])=>ids.has(id)));
  const foods={};d.foods.filter(f=>f.on).forEach(f=>{foods[f.id]=j.foods[f.id];});
  if(j.foods&&j.foods.pudding&&!AD.pud)foods.pudding=j.foods.pudding;
  let got;try{got=adApplyJson({foods,templates:(j.templates||[]).filter(t=>t&&ids.has(t.id)),plan:only(j.plan),targets:only(j.targets),schedule:d.schOn?j.schedule:undefined}).map(adTplName);}
  catch(e){adMsg='';adErrs=[e.message+' Untick some day templates.'];return;}   /* too many day templates: nothing taken, the preview stays */
  const nf=d.foods.filter(f=>f.on&&f.state==='new').length, cf=d.foods.filter(f=>f.on&&f.state==='changed').length;
  const took=[got.join(', '),nf?`${nf} new food${nf>1?'s':''}`:'',cf?`new values for ${cf} of your foods`:'',d.schOn&&same(AD.schedule,j.schedule)?'week schedule':''].filter(Boolean);
  adErrs=[];adMsg=took.length?`Took from ${adAiPend.label}: ${took.join(', ')}. Check it below, then save.`:'Nothing was ticked, so nothing changed.';
  adAiPend=null;jobSeen('plan');
}


/* ---------- Delete progress photos between two dates (account admin, your own photos) ---------- */
let pdTok=0, pdN=0;
async function pdCount(){
  const from=$('#ad-pd-from').value, to=$('#ad-pd-to').value, msg=$('#ad-pdmsg'), btn=$('#ad-pd-btn'), tok=++pdTok;
  pdN=0;btn.disabled=true;
  if(!isDate(from)||!isDate(to)){msg.textContent='';return;}
  if(from>to){msg.textContent='The From date is after the To date.';return;}
  msg.textContent='Counting…';
  try{const r=await api('GET',`/api/photos?from=${from}&to=${to}`);if(tok!==pdTok)return;
    pdN=r.photos.length;btn.disabled=!pdN;
    msg.textContent=pdN?`${pdN} photo${pdN>1?'s':''} from ${pYmd(from)} to ${pYmd(to)}.`:'No photos in that range.';}
  catch(err){if(tok===pdTok&&!err.signedOut)msg.textContent=err.message;}
}
['#ad-pd-from','#ad-pd-to'].forEach(s=>$(s).addEventListener('change',pdCount));
$('#ad-pdel').addEventListener('submit',async e=>{
  e.preventDefault();const from=$('#ad-pd-from').value, to=$('#ad-pd-to').value, btn=$('#ad-pd-btn');
  if(!pdN||!confirm(`Delete ${pdN} progress photo${pdN>1?'s':''} taken from ${fmtLong(from)} to ${fmtLong(to)}? This can’t be undone.`))return;
  btn.disabled=true;$('#ad-pdmsg').textContent='Deleting…';
  try{const r=await api('DELETE',`/api/photos?from=${from}&to=${to}`);
    PHOTOS=null;pPick=[];                      /* the Photos page loads again next time */
    $('#ad-pd-from').value=$('#ad-pd-to').value='';pdN=0;++pdTok;
    $('#ad-pdmsg').textContent=`Deleted ${r.deleted} photo${r.deleted===1?'':'s'}.`;}
  catch(err){if(!err.signedOut)$('#ad-pdmsg').textContent=err.message;btn.disabled=!pdN;}
});

/* ---------- Delete my account: the email typed to confirm, password or code again (the recheck dialog), then signed out ---------- */
$('#ad-del').addEventListener('submit',e=>{
  e.preventDefault();const email=$('#ad-del-email').value.trim(),msg=$('#ad-delmsg');
  if(email.toLowerCase()!==String(ME).toLowerCase()){msg.textContent=`Type your email (${ME}) exactly to confirm.`;return;}
  once(e.target,async()=>{
    msg.textContent='Deleting…';
    try{await api('DELETE','/api/my/account',{email});}
    catch(err){if(!err.signedOut)msg.textContent=err.message;return;}
    pending.clear();try{localStorage.removeItem(stashKey());}catch{}
    location.href='/login?bye=1';
  });
});

/* ---------- Daily checklist: the Dashboard's list (server/checklist.js) ---------- */
let clDraft=null, clDirty=false;
const CL_AUTO=[['','No'],['weight','When I log a weight'],['supps','When I log a supplement'],['gym','When I log a gym set']];
async function clLoad(){
  try{CL=await api('GET','/api/checklist');clDraft=CL.items.map(x=>({...x}));clDirty=false;}
  catch(e){if(!e.signedOut)$('#ad-clmsg').textContent='Couldn’t load your checklist: '+e.message;return;}
  clRender();
}
function clRender(){
  const el=$('#ad-cl');if(!el||!clDraft)return;
  const tpls=(AD&&AD.templates)||[];
  const showOpts=it=>[['all','Every day'],['training','Training days'],...tpls.map(t=>['tpl:'+t.id,`Only ${t.name} days`])]
    .concat(it.show.startsWith('tpl:')&&!tpls.some(t=>'tpl:'+t.id===it.show)?[[it.show,'A day template no longer in your plan']]:[])
    .map(([v,l])=>`<option value="${esc(v)}"${v===it.show?' selected':''}>${esc(l)}</option>`).join('');
  el.innerHTML=clDraft.length?clDraft.map((it,i)=>`<div class="adclrow">
      <label class="f adclname"><span class="lbl">Item</span><input data-cl="label" data-i="${i}" maxlength="60" value="${esc(it.label)}"></label>
      <label class="f"><span class="lbl">Shows on</span><select data-cl="show" data-i="${i}">${showOpts(it)}</select></label>
      <label class="f"><span class="lbl">Ticks itself</span><select data-cl="auto" data-i="${i}">${CL_AUTO.map(([v,l])=>`<option value="${v}"${v===it.auto?' selected':''}>${l}</option>`).join('')}</select></label>
      <span class="gmv"><button class="ghost" type="button" data-cl="up" data-i="${i}" aria-label="Move ${esc(it.label)} up"${i?'':' disabled'}>↑</button><button class="ghost" type="button" data-cl="down" data-i="${i}" aria-label="Move ${esc(it.label)} down"${i<clDraft.length-1?'':' disabled'}>↓</button><button class="x" type="button" data-cl="del" data-i="${i}" aria-label="Remove ${esc(it.label)}">×</button></span>
    </div>`).join(''):'<p>Your checklist is empty – add an item.</p>';
  $('#ad-clsave').disabled=!clDirty;
}
function clChanged(){clDirty=true;$('#ad-clsave').disabled=false;$('#ad-clmsg').textContent='';}
/* never an id used before (a removed item's ticks stay under its id, so a new item must not take it over) */
function clNewId(){let id;do id='c'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);while(clDraft.some(x=>x.id===id));return id;}
$('#v-admin').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-cl]');if(!b||!clDraft)return;
  const a=b.dataset.cl, i=+b.dataset.i;
  if(a==='add'){if(clDraft.length>=20){$('#ad-clmsg').textContent='A checklist can have 20 items at most.';return;}
    clDraft.push({id:clNewId(),label:'',show:'all',auto:''});clChanged();clRender();$(`#ad-cl input[data-i="${clDraft.length-1}"]`).focus();}
  else if(a==='del'){clDraft.splice(i,1);clChanged();clRender();}
  else if(a==='up'||a==='down'){const j=a==='up'?i-1:i+1;[clDraft[i],clDraft[j]]=[clDraft[j],clDraft[i]];clChanged();clRender();}
  else if(a==='save'||a==='reset'){
    if(a==='reset'&&!confirm('Go back to the default checklist? Your own items are replaced (ticks already made stay).'))return;
    const items=clDraft.filter(x=>x.label.trim()), msg=$('#ad-clmsg');
    b.disabled=true;
    try{CL=a==='reset'?await api('DELETE','/api/checklist',undefined,CL.updated):await api('PUT','/api/checklist',{items},CL.updated);
      clDraft=CL.items.map(x=>({...x}));clDirty=false;clRender();msg.textContent=a==='reset'?'Back to the default checklist.':'Checklist saved.';}
    catch(err){if(!err.signedOut)msg.textContent=err.message;}
    b.disabled=false;$('#ad-clsave').disabled=!clDirty;
  }
});
$('#v-admin').addEventListener('input',e=>{const d=e.target.dataset;if(d.cl==='label'&&clDraft){clDraft[+d.i].label=e.target.value;clChanged();}});
$('#v-admin').addEventListener('change',e=>{const d=e.target.dataset;if((d.cl==='show'||d.cl==='auto')&&clDraft){clDraft[+d.i][d.cl]=e.target.value;clChanged();}});

/* ---------- Share with your coach: read-only links with no password, live until a time you pick (server/shares.js) ---------- */
let SH=null, shNew=null;
const shWhen=iso=>new Date(iso).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'});
async function shLoad(){const r=await loadTry('sh',()=>api('GET','/api/shares')).catch(()=>null);SH=r?r.shares:null;shRender();}
function shRender(){
  $('#ad-shnew').innerHTML=shNew?`<p class="admsg">Link made – copy it now and send it to your coach. For your safety it isn’t shown again; make a new one if you lose it.</p>
    <div class="adlink"><input id="ad-sh-link" readonly value="${esc(shNew.url)}" aria-label="Coach link"><button type="button" class="ghost" data-sh="copy">Copy link</button>${navigator.share?'<button type="button" class="ghost" data-sh="send">Send…</button>':''}</div>`:'';
  if(!SH){$('#ad-shares').innerHTML=LOADERR.sh?loadErr('your coach links','sh'):'';return;}
  $('#ad-shares').innerHTML=SH.length?SH.map(x=>`<div class="aduser"><span class="who"><b>${esc(x.label||'Coach link')}</b>
      <span class="sub">${x.live?`Live until ${esc(shWhen(x.expires))}`:`Ran out ${esc(shWhen(x.expires))}`} · made ${esc(shWhen(x.created))}${x.used?` · last opened ${esc(shWhen(x.used))}`:' · not opened yet'}</span></span>
    <span class="chip ${x.live?'ok':'bad'}">${x.live?'Live':'Ran out'}</span>
    <span class="acts"><button type="button" class="ghost" data-sh="${x.live?'off':'del'}" data-id="${x.id}">${x.live?'Switch off':'Remove'}</button></span></div>`).join('')
    :'<p class="sub">No coach links yet.</p>';
}
/* when the link runs out: a length of time from now, or the end of a picked day (this browser's time) */
function shExpiry(){
  const v=$('#ad-sh-for').value;
  if(v==='date'){const d=$('#ad-sh-until').value;if(!isDate(d))return null;const t=parse(d);t.setHours(23,59,59,0);return t;}
  const n=+v.slice(1);return new Date(Date.now()+(v[0]==='h'?n*3600000:n*86400000));
}
/* a hidden date is disabled too, so a bad one left in it can't hold up "Make link" (the browser checks only enabled fields) */
$('#ad-sh-for').addEventListener('change',()=>{const on=$('#ad-sh-for').value==='date';$('#ad-sh-untilf').hidden=!on;
  const i=$('#ad-sh-until');i.disabled=!on;i.min=todayStr();i.max=addDays(todayStr(),365);if(on&&!i.value)i.value=addDays(todayStr(),7);});
$('#ad-share').addEventListener('submit',async e=>{
  e.preventDefault();const msg=$('#ad-shmsg'), btn=$('#ad-sh-btn'), t=shExpiry();
  if(!t){msg.textContent='Pick the day the link runs out.';return;}
  btn.disabled=true;msg.textContent='';
  try{shNew=await api('POST','/api/shares',{label:$('#ad-sh-label').value.trim(),expires:t.toISOString()});$('#ad-sh-label').value='';await shLoad();}
  catch(err){if(!err.signedOut)msg.textContent=err.message;}
  btn.disabled=false;
});
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-sh]');if(!b)return;const a=b.dataset.sh;
  if(a==='copy'){const i=$('#ad-sh-link');i.select();try{await navigator.clipboard.writeText(i.value);b.textContent='Copied';}catch{document.execCommand&&document.execCommand('copy');}return;}
  if(a==='send'){try{await navigator.share({title:'My Logbook Monster',url:$('#ad-sh-link').value});}catch{}return;}
  const x=SH&&SH.find(s=>String(s.id)===b.dataset.id);if(!x)return;
  if(a==='off'&&!confirm(`Switch off ${x.label?`“${x.label}”`:'this link'}? It stops working straight away.`))return;
  b.disabled=true;
  try{await api('DELETE',`/api/shares/${x.id}?key=${encodeURIComponent(x.key)}`);shNew=null;await shLoad();}catch(err){b.disabled=false;if(!err.signedOut){alert(err.message);await shLoad();}}
});

/* ---------- People: invites and accounts ---------- */
let AU=null, auLink=null;
const AU_STATUS={active:['ok','Active'],invited:['info','Invite sent'],expired:['bad','Invite expired']};
const auDate=s=>s?new Date(s.replace(' ','T')+'Z').toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'';
async function auLoad(){AU=await loadTry('au',()=>api('GET','/api/admin/users')).catch(()=>null);auRender();if(LG)lgRender();}
function auRender(){
  const m=$('#ad-ivmsg');
  m.innerHTML=auLink?`<p class="admsg">${esc(auLink.msg)}</p>${auLink.error?`<p class="aderr">${esc(auLink.error)} Send them this link yourself:</p>`:''}
    <div class="adlink"><input id="ad-iv-link" readonly value="${esc(auLink.link)}" aria-label="Invite link"><button type="button" class="ghost" data-au="copy">Copy link</button></div>`:'';
  if(!AU){$('#ad-users').innerHTML=LOADERR.au?loadErr('the accounts','au'):'';return;}
  if(!AU.email&&!auLink)m.innerHTML='<p class="sub">Email isn’t set up yet (see the Email tab), so you’ll get a link to send yourself.</p>';
  $('#ad-users').innerHTML=AU.users.map(u=>{const [c,t]=AU_STATUS[u.status]||['',''];
    const how=[u.password&&'password',u.google&&'Google'].filter(Boolean).join(' + ');
    const sub=u.status==='active'?(u.lastLogin?`Last signed in ${auDate(u.lastLogin)}`:'Not signed in yet')+(how?` · ${how}`:'')
      :`Invited ${u.invitedBy?'by '+u.invitedBy+' ':''}on ${auDate(u.created)}`;
    return `<div class="aduser" data-id="${u.id}"><span class="who"><b>${esc(u.name||u.email)}${u.you?' (you)':''}</b>${u.name?`<span class="sub">${esc(u.email)}</span>`:''}<span class="sub">${esc(sub)}</span></span>
      <span class="chip ${c}">${t}</span>${u.admin?'<span class="chip">Admin</span>':''}
      <span class="acts">${u.status!=='active'?`<button type="button" class="ghost" data-au="resend" data-id="${u.id}">${u.status==='expired'?'New invite':'Resend'}</button>`:''}
        ${u.you||u.admin?'':`<button type="button" class="ghost" data-au="remove" data-id="${u.id}">Remove</button>`}</span></div>`;}).join('');
}
function auResult(r){auLink={link:r.link,error:r.emailed?'':r.emailError,msg:r.emailed?`Invite emailed to ${r.email}.`:`Invite ready for ${r.email}.`};}
$('#ad-invite').addEventListener('submit',async e=>{
  e.preventDefault();const email=$('#ad-iv-email').value.trim();if(!email){$('#ad-iv-email').focus();return;}
  $('#ad-iv-btn').disabled=true;
  try{auResult(await api('POST','/api/admin/users',{email,name:$('#ad-iv-name').value.trim()}));$('#ad-iv-email').value=$('#ad-iv-name').value='';await auLoad();}
  catch(err){if(!err.signedOut){auLink=null;$('#ad-ivmsg').innerHTML=`<p class="aderr">${esc(err.message)}</p>`;}}
  $('#ad-iv-btn').disabled=false;
});
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-au]');if(!b)return;const a=b.dataset.au;
  const u=AU&&AU.users.find(x=>String(x.id)===b.dataset.id);
  if(a==='copy'){const i=$('#ad-iv-link');i.select();try{await navigator.clipboard.writeText(i.value);b.textContent='Copied';}catch{document.execCommand&&document.execCommand('copy');}return;}
  if(!u)return;
  b.disabled=true;
  try{
    if(a==='resend'){auResult(await api('POST',`/api/admin/users/${u.id}/invite`));}
    else if(a==='remove'){if(!confirm(auRemoveText(u))){b.disabled=false;return;}
      await api('DELETE',`/api/admin/users/${u.id}`);auLink=null;}
    await auLoad();
  }catch(err){b.disabled=false;if(!err.signedOut){alert(err.message);if(err.status===404)await auLoad();}}
});

/* everything removing an account deletes, said plainly – shared foods and supplements leave everyone's library */
function auRemoveText(u){
  const n=(k,w)=>`${k} ${w}${k===1?'':'s'}`;
  return `Remove ${u.email}? Everything in the account is deleted with it: days, history, weights, gym sets and workouts, supplements, checklist, coach links`
    +(u.photos?` and ${n(u.photos,'progress photo')} (the files too)`:', progress photos')+'.'
    +(u.shared?`\n\n${u.shared===1?'The food or supplement':`The ${u.shared} foods and supplements`} they shared with everyone will disappear from every other account’s library too.`:'')
    +'\n\nThis can’t be undone.';
}
/* ---------- Email: the account invites and notifications are sent from ---------- */
let AM=null;
const AM_PROV={gmail:['smtp.gmail.com',465],outlook:['smtp.office365.com',587]};
async function amLoad(){AM=await loadTry('am',()=>api('GET','/api/admin/email')).catch(()=>null);amFill();}
/* the form as filled from the settings in use; Save sends only the fields the person changed, so a value left as .env's stays from .env */
let AMF=null, amTlsSet=false;
const AM_FIELDS={from:'ad-m-from',fromName:'ad-m-name',host:'ad-m-host',port:'ad-m-port',secure:'ad-m-tls',user:'ad-m-user'};
const AM_LBL={host:'server',port:'port',secure:'security',user:'username',pass:'password',from:'send-from address',fromName:'sender name'};
function amVals(){const v={};for(const[k,id]of Object.entries(AM_FIELDS))v[k]=$('#'+id).value.trim();return v;}
function amFill(){
  /* a form that didn't load can't be saved over the settings in use */
  $('#ad-mailform').querySelectorAll('button[type=submit],button:not([type])').forEach(b=>{b.disabled=!AM;});
  if(!AM){$('#ad-mailstate').innerHTML=LOADERR.am?loadErr('the email settings','am'):'';return;}
  const src=AM.sources||{}, by=w=>Object.keys(AM_LBL).filter(k=>src[k]===w).map(k=>AM_LBL[k]).join(', ');
  const env=by('env'), saved=by('admin');
  $('#ad-mailstate').innerHTML=(AM.configured?`<span class="chip ok">✓ Set up</span> Sending from ${esc(AM.from)} via ${esc(AM.host)}.`
    :'<span class="chip bad">Not set up</span> Invites give you a link to send yourself until this is filled in.')
    +(saved||env?`<span class="sub adsrc">${saved?`Saved here: ${esc(saved)}.`:''}${saved&&env?' ':''}${env?`From .env: ${esc(env)}.`:''}</span>`:'');
  const host=AM.host||AM_PROV.gmail[0];
  $('#ad-m-from').value=AM.from||'';$('#ad-m-name').value=AM.fromName==='Logbook Monster'?'':AM.fromName||'';
  $('#ad-m-host').value=host;const port=AM.host?AM.port:AM_PROV.gmail[1];$('#ad-m-port').value=port;$('#ad-m-user').value=AM.user||'';$('#ad-m-pass').value='';
  $('#ad-m-tls').value=(AM.host?AM.secure:port===465)?'1':'0';amTlsSet=src.secure==='admin';
  $('#ad-m-prov').value=Object.keys(AM_PROV).find(k=>AM_PROV[k][0]===host)||'other';
  $('#ad-m-pass').placeholder=AM.hasPassword?`Saved${AM.passwordSource==='env'?' in .env':''} – type a new one to replace it`:'';
  $('#ad-m-del').hidden=AM.source!=='admin';
  if(!AM.configured)$('#ad-m-help').open=true;
  if(!$('#ad-m-to').value)$('#ad-m-to').value=ME||'';
  AMF=amVals();
}
/* the security follows the port until the person picks it */
function amPortTls(){if(!amTlsSet){const p=+$('#ad-m-port').value;if(p)$('#ad-m-tls').value=p===465?'1':'0';}}
$('#ad-m-port').addEventListener('input',amPortTls);
$('#ad-m-tls').addEventListener('change',()=>{amTlsSet=true;});
$('#ad-m-prov').addEventListener('change',e=>{const p=AM_PROV[e.target.value];if(p){$('#ad-m-host').value=p[0];$('#ad-m-port').value=p[1];amPortTls();}});
/* only what changed – or, with no server set up anywhere, the whole form (its defaults are a new setup) */
function amBody(){
  const v=amVals(),src=(AM&&AM.sources)||{},fresh=!(AM&&AM.host),body={};
  for(const k of Object.keys(AM_FIELDS))if(v[k]!==AMF[k]||(fresh&&v[k]!==''&&src[k]!=='env'))body[k]=k==='port'?(+v[k]||''):k==='secure'?v[k]==='1':v[k];
  if($('#ad-m-pass').value)body.pass=$('#ad-m-pass').value;
  return body;
}
$('#ad-mailform').addEventListener('submit',async e=>{
  e.preventDefault();const body=amBody();
  if(!Object.keys(body).length){$('#ad-mailmsg').textContent='Nothing changed.';return;}
  try{AM=await api('PUT','/api/admin/email',body);$('#ad-mailmsg').textContent='Email settings saved. Send a test to check them.';amFill();if(AU){AU.email=AM.configured;auRender();}}
  catch(err){if(!err.signedOut)$('#ad-mailmsg').textContent=err.message;}
});
$('#ad-m-del').addEventListener('click',async()=>{
  if(!confirm('Remove the saved email settings? Invites will stop being emailed.'))return;
  try{AM=await api('PUT','/api/admin/email',{from:'',fromName:'',host:'',port:'',secure:null,user:'',pass:''});$('#ad-mailmsg').textContent='Email settings removed.';amFill();if(AU){AU.email=AM.configured;auRender();}}
  catch(err){if(!err.signedOut)$('#ad-mailmsg').textContent=err.message;}
});
$('#ad-mailtest').addEventListener('submit',async e=>{
  e.preventDefault();$('#ad-m-testbtn').disabled=true;$('#ad-mailmsg').textContent='Sending…';
  try{const r=await api('POST','/api/admin/email/test',{to:$('#ad-m-to').value.trim()});$('#ad-mailmsg').textContent=`Test email sent to ${r.to}. Check the inbox (and spam).`;}
  catch(err){if(!err.signedOut)$('#ad-mailmsg').textContent=err.message;}
  $('#ad-m-testbtn').disabled=false;
});

/* ---------- Security log (server/audit.js): the whole log on Super admin › Security log, your own account's on Account admin ---------- */
const LG_EV={'signin.ok':'Signed in','signin.failed':'Failed sign-in','signin.locked':'Sign-in refused (locked)','signin.alert':'Alert: failed sign-ins',
  'second.asked':'Password right, code asked for','second.failed':'Wrong sign-in code','second.locked':'Sign-in code refused (locked)',
  'recovery.used':'Recovery code used','twostep.on':'Two-step sign-in on','twostep.off':'Two-step sign-in off','recheck.ok':'Confirmed it’s you',
  'recheck.failed':'Failed to confirm it’s you',signout:'Signed out','password.changed':'Password changed','google.linked':'Google linked','invite.created':'Invite made','invite.accepted':'Invite accepted',
  'account.removed':'Account removed','account.deleted':'Deleted their own account','ai.settings':'AI settings changed','email.settings':'Email settings changed','options.changed':'Options changed',
  export:'Data downloaded','day.deleted':'Day deleted','checklist.reset':'Checklist reset','photos.deleted':'Photos deleted','food.removed':'Shared food removed',
  'supp.removed':'Shared supplement removed','coach.created':'Coach link made','coach.off':'Coach link switched off','coach.used':'Coach link opened','ai.cap':'AI daily limit reached','ai.breaker':'AI service paused or back'};
let LG=null, ML=null;
const lgDetail=d=>Object.entries(d||{}).filter(([k])=>k!=='eh').map(([k,v])=>`${k}: ${Array.isArray(v)?v.join(', ')||'–':v}`).join(' · ');
const lgAcct=a=>a.email||`account #${a.id} (removed)`;
function lgRow(r,all){
  const who=all?[r.user&&lgAcct(r.user),r.actor&&(!r.user||r.actor.id!==r.user.id)&&`by ${lgAcct(r.actor)}`].filter(Boolean).join(' '):'';
  return `<div class="aduser"><span class="who"><b>${esc(LG_EV[r.event]||r.event)}</b><span class="sub">${esc([shWhen(r.at),who,r.ip&&'from '+r.ip].filter(Boolean).join(' · '))}</span>`
    +`${lgDetail(r.detail)?`<span class="sub">${esc(lgDetail(r.detail))}</span>`:''}</span></div>`;
}
$('#ad-lg-ev').insertAdjacentHTML('beforeend',Object.entries(LG_EV).map(([k,l])=>`<option value="${esc(k)}">${esc(l)}</option>`).join(''));
async function lgLoad(more){
  const p=new URLSearchParams(),ev=$('#ad-lg-ev').value,u=$('#ad-lg-user').value;
  if(ev)p.set('event',ev);if(u)p.set('user',u);if(more&&LG&&LG.next)p.set('before',LG.next);
  try{const r=await api('GET','/api/admin/log?'+p);LG=more&&LG?{rows:LG.rows.concat(r.rows),next:r.next}:r;delete LOADERR.lg;}
  catch(e){if(e.signedOut)return;LOADERR.lg=e.message;if(!more)LG={rows:[],next:null};}
  lgRender();
}
function lgRender(){
  const sel=$('#ad-lg-user');
  if(AU&&sel.options.length<2)sel.insertAdjacentHTML('beforeend',AU.users.map(u=>`<option value="${u.id}">${esc(u.email)}</option>`).join(''));
  $('#ad-log').innerHTML=(LOADERR.lg?loadErr('the log','lg'):'')+(LG?(LG.rows.length?LG.rows.map(r=>lgRow(r,true)).join(''):LOADERR.lg?'':'<p class="sub">Nothing logged for this filter.</p>'):'');
  $('#ad-lg-more').hidden=!(LG&&LG.next);
}
$('#ad-lgform').addEventListener('submit',e=>{e.preventDefault();lgLoad();});
$('#ad-lg-ev').addEventListener('change',()=>lgLoad());
$('#ad-lg-user').addEventListener('change',()=>lgLoad());
$('#ad-lg-more').addEventListener('click',()=>lgLoad(true));
async function mlLoad(more){
  ML=ML||{rows:[],next:null};
  try{const r=await api('GET','/api/my/log'+(more&&ML.next?'?before='+ML.next:''));ML=more?{rows:ML.rows.concat(r.rows),next:r.next}:r;delete LOADERR.ml;}
  catch(e){if(e.signedOut)return;LOADERR.ml=e.message;}
  $('#ad-mylog').innerHTML=(LOADERR.ml?loadErr('your sign-ins','ml'):'')+(ML.rows.length?ML.rows.map(r=>lgRow(r,false)).join(''):LOADERR.ml?'':'<p class="sub">Nothing logged yet.</p>');
  $('#ad-ml-more').hidden=!ML.next;
}
$('#ad-ml-more').addEventListener('click',()=>mlLoad(true));
