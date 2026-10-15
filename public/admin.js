'use strict';
/* Admin view: the baseline every new day starts from – meal plan (upload, edit, download),
   which weekdays are training or rest, day targets and food values. Uses helpers from app.js. */

const AD_TYPES=[['T','Training'],['R','Rest'],['S','Saturday training']];
const AD_BOXES=[['p','Protein'],['c','Carbs'],['x','Additional fats']];
let AD=null, adSaved='', adType='T', adMsg='', adErrs=[], adBusy=false;
let adAi=null, adAiBusy=false, adNotes=[];
const adOpen=new Set();                      /* food editors left open */

/* ---------- draft ---------- */
function builtinRecord(id){const F=BUILTIN.foods[id];const r={group:builtinGroup(id)};
  FOOD_FIELDS.forEach(k=>{if(k!=='group')r[k]=F[k]!=null?F[k]:(k==='unit'?'g':null);});return r;}
function builtinPlanData(){const keep=CUSTOM_PLAN;CUSTOM_PLAN=null;try{return planData();}finally{CUSTOM_PLAN=keep;}}
function adEditable(id){return id!=='pudding';}       /* pudding values come from the batch on the Day page */
function adLoad(){
  const foods={};Object.keys(FOODS).filter(adEditable).forEach(id=>{foods[id]=foodRecord(id);});
  AD={foods,schedule:[...TYPE],targets:clone(COACH),plan:planData(),custom:!!CUSTOM_PLAN};
  adSaved=JSON.stringify(adPayload());
}
/* only what differs from the built-in values is stored */
function adPayload(){
  const foods={};
  for(const [id,r] of Object.entries(AD.foods)){
    if(!BUILTIN.foods[id]||JSON.stringify(r)!==JSON.stringify(builtinRecord(id))) foods[id]=r;
  }
  return {foods,schedule:AD.schedule,targets:AD.targets,plan:AD.custom?AD.plan:null};
}
function adDirty(){return !!AD&&JSON.stringify(adPayload())!==adSaved;}
const adFoodName=id=>(AD.foods[id]||FOODS[id]||{n:id}).n;
function adMac(f,g){const F=f==='pudding'?FOODS.pudding:AD.foods[f];if(!F)return {k:0,p:0,c:0,f:0};
  return {k:F.k*g/100,p:F.p*g/100,c:F.c*g/100,f:F.f*g/100};}
function adPlanUses(id){return Object.values(AD.plan).some(ms=>ms.some(m=>['p','c','x'].some(b=>(m[b]||[]).some(i=>i.f===id))));}

/* ---------- rendering ---------- */
function renderAdmin(){
  if(view!=='admin')return;
  if(!AD){adLoad();adAiLoad();}
  const numIn=(id,val,attrs,label)=>`<input id="${id}" type="number" inputmode="decimal" min="0" value="${val==null?'':val}" ${attrs} aria-label="${esc(label)}">`;
  /* plan */
  $('#ad-planstate').innerHTML=AD.custom
    ?'<span class="chip info">Your plan</span> New days start from the plan below.'
    :'<span class="chip">Built-in plan</span> Edit an amount or upload a file to make your own.';
  $('#ad-restore').hidden=!AD.custom;
  $('#ad-upmsg').innerHTML=(adMsg?`<p class="admsg">${esc(adMsg)}</p>`:'')+(adErrs.length?`<ul class="aderr">${adErrs.slice(0,12).map(e=>`<li>${esc(e)}</li>`).join('')}${adErrs.length>12?`<li>…and ${adErrs.length-12} more</li>`:''}</ul>`:'')
    +(adNotes.length?`<details class="adnotes" open><summary>What the AI estimated or left out (${adNotes.length})</summary><ul>${adNotes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></details>`:'');
  $('#ad-types').innerHTML=AD_TYPES.map(([t,n])=>`<button type="button" data-ad="type" data-t="${t}" aria-pressed="${t===adType}">${n}</button>`).join('');
  const foodOpts=(sel,box)=>{const ids=Object.keys(AD.foods).concat(['pudding']).filter(f=>box==='x'?AD.foods[f]&&AD.foods[f].group==='x':!(AD.foods[f]&&AD.foods[f].group==='x'));
    if(sel&&!ids.includes(sel))ids.unshift(sel);
    return ids.map(f=>`<option value="${f}"${f===sel?' selected':''}>${esc(adFoodName(f))}</option>`).join('');};
  const meals=AD.plan[adType]||[];
  $('#ad-meals').innerHTML=meals.map((m,mi)=>`<section class="meal admeal">
      <header class="adhead"><span class="mn">Meal ${esc(m.id)}</span>
        <input id="ad-mn-${mi}" class="adname" data-ad="mname" data-m="${mi}" value="${esc(m.name)}" aria-label="Meal name">
        <button type="button" class="x" data-ad="mdel" data-m="${mi}" aria-label="Remove meal ${esc(m.id)}"${meals.length<2?' disabled':''}>×</button></header>
      <input id="ad-note-${mi}" class="adnote" data-ad="mnote" data-m="${mi}" value="${esc(m.note||'')}" placeholder="Note (optional)" aria-label="Meal note">
      <span class="ml" id="ad-mt-${mi}"></span>
      <div class="boxes">${AD_BOXES.map(([b,l])=>`<div class="box"><span class="lbl">${l}</span>
        ${(m[b]||[]).map((i,ii)=>{const u=(AD.foods[i.f]||FOODS[i.f]||{}).unit||'g';const k=`${adType}-${mi}-${b}-${ii}`;
          return `<div class="adrow"><select id="ad-f-${k}" data-ad="ifood" data-m="${mi}" data-b="${b}" data-i="${ii}" aria-label="Food">${foodOpts(i.f,b)}</select>
          <span class="amt">${numIn('ad-g-'+k,i.g,`step="1" data-ad="igram" data-m="${mi}" data-b="${b}" data-i="${ii}"`,'Amount')}<em>${u}</em></span>
          <label class="lock"><input type="checkbox" id="ad-l-${k}" data-ad="ilock" data-m="${mi}" data-b="${b}" data-i="${ii}"${i.lock?' checked':''}><span>Lock</span></label>
          <button type="button" class="x" data-ad="idel" data-m="${mi}" data-b="${b}" data-i="${ii}" aria-label="Remove">×</button></div>`;}).join('')||'<p class="empty">Nothing here</p>'}
        <div class="add"><select id="ad-a-${adType}-${mi}-${b}" data-ad="iadd" data-m="${mi}" data-b="${b}" aria-label="Add a food"><option value="">+ Add a food…</option>${foodOpts(null,b)}</select></div>
      </div>`).join('')}</div></section>`).join('')
    +`<div class="adplanfoot"><span class="ml" id="ad-tot"></span><button type="button" class="ghost" data-ad="madd">+ Add a meal</button></div>`;
  /* week & targets */
  $('#ad-week').innerHTML=DAYS.map((d,i)=>`<label class="f"><span class="lbl">${d}</span><select id="ad-wd-${i}" data-ad="wday" data-i="${i}">
      ${AD_TYPES.map(([t,n])=>`<option value="${t}"${AD.schedule[i]===t?' selected':''}>${t==='S'?'Training (Saturday plan)':n}</option>`).join('')}</select></label>`).join('');
  $('#ad-targets').innerHTML='<span></span><span class="lbl">kcal</span><span class="lbl">Protein g</span><span class="lbl">Carbs g</span><span class="lbl">Fat g</span>'+
    AD_TYPES.map(([t,n])=>`<span class="adtl">${n}</span>`+MAC.map(m=>numIn(`ad-tg-${t}-${m}`,AD.targets[t][m],`data-ad="target" data-t="${t}" data-k="${m}"`,`${n} ${m}`)).join('')).join('');
  /* foods */
  const groups={p:'Protein swaps',c:'Carb swaps',x:'Fat swaps','':'Not in a swap list'};
  $('#ad-foods').innerHTML=Object.entries(AD.foods).map(([id,r])=>{
    const edited=BUILTIN.foods[id]&&JSON.stringify(r)!==JSON.stringify(builtinRecord(id)), custom=!BUILTIN.foods[id];
    const fld=(k,label,attrs='')=>`<label class="f"><span class="lbl">${label}</span>${numIn(`ad-fd-${id}-${k}`,r[k],`step="any" data-ad="food" data-id="${id}" data-k="${k}" ${attrs}`,`${r.n} ${label}`)}</label>`;
    return `<details class="adfood" data-id="${id}"${adOpen.has(id)?' open':''}><summary><span class="adfn">${esc(r.n)}</span>
        ${custom?'<span class="chip info">Added</span>':edited?'<span class="chip info">Edited</span>':''}
        <span class="ml" id="ad-fs-${id}">${adFoodLine(r)}</span></summary>
      <div class="adfgrid">
        <label class="f adwide"><span class="lbl">Name</span><input id="ad-fd-${id}-n" data-ad="food" data-id="${id}" data-k="n" value="${esc(r.n)}"></label>
        ${fld('k',`kcal / 100${r.unit}`)}${fld('p','Protein')}${fld('c','Carbs')}${fld('f','Fat')}${fld('d','Direct protein')}
        ${fld('step','Step')}${fld('min','Min serving')}${fld('max','Max serving')}${fld('order','Daily order')}
        <label class="f"><span class="lbl">Unit</span><select id="ad-fd-${id}-unit" data-ad="food" data-id="${id}" data-k="unit">${['g','ml'].map(u=>`<option${r.unit===u?' selected':''}>${u}</option>`).join('')}</select></label>
        <label class="f"><span class="lbl">Swap list</span><select id="ad-fd-${id}-group" data-ad="food" data-id="${id}" data-k="group">${Object.entries(groups).map(([g,n])=>`<option value="${g}"${r.group===g?' selected':''}>${n}</option>`).join('')}</select></label>
      </div>
      <div class="adfact">${edited?`<button type="button" class="ghost" data-ad="freset" data-id="${id}">Back to built-in values</button>`:''}
        ${custom?`<button type="button" class="ghost" data-ad="fdel" data-id="${id}">Delete food</button>`:''}</div>
    </details>`;}).join('');
  adStatus();adTotals();
}
function adFoodLine(r){return `${r0(+r.k||0)} kcal · P ${r1(+r.p||0)} · C ${r1(+r.c||0)} · F ${r1(+r.f||0)} per 100${r.unit}`;}
function adTotals(){
  const meals=AD.plan[adType]||[];const tg=AD.targets[adType];
  meals.forEach((m,mi)=>{const el=$('#ad-mt-'+mi);if(el)el.innerHTML=macLine(sum(['p','c','x'].flatMap(b=>(m[b]||[]).map(i=>adMac(i.f,+i.g||0)))));});
  const t=sum(meals.flatMap(m=>['p','c','x'].flatMap(b=>(m[b]||[]).map(i=>adMac(i.f,+i.g||0)))));
  const el=$('#ad-tot');
  if(el)el.innerHTML=`<b>Plan as written:</b> ${r0(t.k)} kcal · P ${r1(t.p)} · C ${r1(t.c)} · F ${r1(t.f)} – target ${r0(+tg.k)} kcal · P ${r0(+tg.p)} · C ${r0(+tg.c)} · F ${r0(+tg.f)}. Each new day balances these amounts to its targets.`;
}
function adStatus(){
  const d=adDirty();
  $('#ad-status').innerHTML=adBusy?'<span class="chip info">Saving…</span>'
    :d?'<span class="chip bad">Unsaved changes</span> Nothing changes for your days until you save.'
    :'<span class="chip ok">✓ Saved</span> New days start from these defaults. Days already in your history keep their own amounts.';
  $('#ad-save').disabled=!d||adBusy;$('#ad-discard').hidden=!d;
}

/* ---------- editing ---------- */
const adMeal=el=>AD.plan[adType][+el.dataset.m];
const adItem=el=>adMeal(el)[el.dataset.b][+el.dataset.i];
function adPlanEdit(fn){fn();AD.custom=true;}
function adNewId(name){let base=String(name).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').replace(/^(?=[^a-z])/,'f_').slice(0,24)||'food';
  let id=base,n=2;while(AD.foods[id]||FOODS[id])id=`${base}_${n++}`;return id;}

document.addEventListener('input',e=>{
  const el=e.target, a=el.dataset.ad; if(!a||!AD)return;
  if(a==='igram'){adPlanEdit(()=>{adItem(el).g=Math.max(0,+el.value||0);});adTotals();}
  else if(a==='mname'){adPlanEdit(()=>{adMeal(el).name=el.value;});}
  else if(a==='mnote'){adPlanEdit(()=>{const m=adMeal(el);if(el.value)m.note=el.value;else delete m.note;});}
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
  if(a==='ilock'){adPlanEdit(()=>{adItem(el).lock=el.checked;});}
  else if(a==='ifood'){adPlanEdit(()=>{adItem(el).f=el.value;});renderAdmin();}
  else if(a==='iadd'){if(!el.value)return;const f=el.value,F=AD.foods[f]||FOODS[f];
    adPlanEdit(()=>{const m=adMeal(el);(m[el.dataset.b]=m[el.dataset.b]||[]).push({f,g:F.min||(F.step>=5?50:10),lock:false});});renderAdmin();}
  else if(a==='wday'){AD.schedule[+el.dataset.i]=el.value;}
  else if(a==='food'&&el.tagName==='SELECT'){AD.foods[el.dataset.id][el.dataset.k]=el.value;const s=$('#ad-fs-'+el.dataset.id);if(s)s.innerHTML=adFoodLine(AD.foods[el.dataset.id]);}
  else return;
  adStatus();
});
document.addEventListener('toggle',e=>{const d=e.target;if(d.classList&&d.classList.contains('adfood')){if(d.open)adOpen.add(d.dataset.id);else adOpen.delete(d.dataset.id);}},true);
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-ad]'); if(!b||!AD||b.tagName==='INPUT'||b.tagName==='SELECT')return;
  const a=b.dataset.ad;
  if(a==='type'){adType=b.dataset.t;}
  else if(a==='idel'){adPlanEdit(()=>{adMeal(b)[b.dataset.b].splice(+b.dataset.i,1);});}
  else if(a==='mdel'){const m=adMeal(b);if(!confirm(`Remove meal ${m.id} (${m.name}) from the ${AD_TYPES.find(x=>x[0]===adType)[1].toLowerCase()} plan?`))return;
    adPlanEdit(()=>{AD.plan[adType].splice(+b.dataset.m,1);});}
  else if(a==='madd'){adPlanEdit(()=>{const ms=AD.plan[adType];const n=ms.reduce((x,m)=>Math.max(x,parseInt(m.id,10)||0),0)+1;
    ms.push({id:String(n),name:'New meal',p:[],c:[],x:[]});});}
  else if(a==='freset'){AD.foods[b.dataset.id]=builtinRecord(b.dataset.id);}
  else if(a==='fdel'){const id=b.dataset.id;
    if(adPlanUses(id)){alert(`${adFoodName(id)} is in the meal plan. Take it out of the plan first.`);return;}
    delete AD.foods[id];adOpen.delete(id);}
  else if(a==='restore'){if(!confirm('Go back to the built-in meal plan? Your plan edits are dropped when you save.'))return;
    AD.plan=builtinPlanData();AD.custom=false;adMsg='Built-in plan restored – save to use it.';adErrs=[];}
  else if(a==='csv'){adDownload(`mealswap-plan-${todayStr()}.csv`,planCsv(AD.plan),'text/csv');return;}
  else if(a==='json'){adDownload(`mealswap-defaults-${todayStr()}.json`,JSON.stringify({...adPayload(),plan:AD.plan},null,2),'application/json');return;}
  else if(a==='discard'){adLoad();adMsg='';adErrs=[];adNotes=[];}
  else if(a==='save'){adSave();return;}
  else return;
  renderAdmin();
});
$('#ad-addfood').addEventListener('submit',e=>{
  e.preventDefault();const v=id=>$('#'+id).value;
  const n=v('ad-nf-n').trim();if(!n){$('#ad-nf-n').focus();return;}
  const group=v('ad-nf-g'),p=+v('ad-nf-p')||0;
  const id=adNewId(n);
  AD.foods[id]={group,n,k:+v('ad-nf-k')||0,p,c:+v('ad-nf-c')||0,f:+v('ad-nf-f')||0,d:group==='p'?p:0,step:group==='x'?1:5,unit:'g',min:null,max:null,order:null};
  adOpen.add(id);['ad-nf-n','ad-nf-k','ad-nf-p','ad-nf-c','ad-nf-f'].forEach(x=>{$('#'+x).value='';});
  renderAdmin();
  const d=document.querySelector(`.adfood[data-id="${id}"]`);if(d)d.scrollIntoView({block:'nearest'});
});
$('#ad-file').addEventListener('change',e=>{const el=e.target;adUpload(el.files&&el.files[0]).finally(()=>{el.value='';});});
window.addEventListener('beforeunload',e=>{if(adDirty()){e.preventDefault();e.returnValue='';}});

async function adSave(){
  adBusy=true;adStatus();
  try{
    const r=await api('PUT','/api/admin/defaults',adPayload());
    applyDefaults(r);
    /* days you haven't saved yet start again from the new plan */
    for(const d of Object.keys(S.days)) if(!LOGGED.has(d)&&!pending.has(d)){delete S.days[d];delete SAVED.days[d];}
    adLoad();adMsg='';adErrs=[];
  }catch(err){if(!err.signedOut){adErrs=[err.message];adMsg='Couldn’t save:';}}
  adBusy=false;renderAdmin();
}
function adDownload(name,text,type){
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

/* ---------- plan files: CSV (one row per food) or JSON ---------- */
const CSV_COLS=['day_type','meal','meal_name','box','food','grams','locked','note','food_name'];
function csvCell(v){v=String(v==null?'':v);return /[",\n\r]/.test(v)?`"${v.replace(/"/g,'""')}"`:v;}
function planCsv(plan){
  const rows=[CSV_COLS.join(',')];
  AD_TYPES.forEach(([t])=>(plan[t]||[]).forEach(m=>{let first=true;
    const items=AD_BOXES.flatMap(([b])=>(m[b]||[]).map(i=>[b,i]));
    if(!items.length)items.push(['c',null]);
    items.forEach(([b,i])=>{rows.push([t,m.id,m.name,{p:'protein',c:'carbs',x:'fats'}[b],i?i.f:'',i?i.g:'',i&&i.lock?'yes':'',first?m.note||'':'',i?adFoodName(i.f):''].map(csvCell).join(','));first=false;});
  }));
  return rows.join('\r\n')+'\r\n';
}
function parseCsv(text){
  const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){const ch=text[i];
    if(q){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else q=false;}else cell+=ch;}
    else if(ch==='"')q=true;
    else if(ch===','||ch===';'||ch==='\t'){row.push(cell);cell='';}
    else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
    else cell+=ch;}
  if(cell!==''||row.length){row.push(cell);rows.push(row);}
  return rows.filter(r=>r.some(c=>c.trim()!==''));
}
function csvToPlan(text){
  const rows=parseCsv(text.replace(/^﻿/,''));const errs=[];
  if(!rows.length)return {errs:['The file is empty.']};
  const head=rows[0].map(h=>h.trim().toLowerCase().replace(/[\s-]+/g,'_'));
  const col=n=>head.indexOf(n);
  ['day_type','meal','food','grams'].forEach(n=>{if(col(n)<0)errs.push(`Missing the "${n}" column. The first row must be the headings: ${CSV_COLS.slice(0,8).join(', ')}.`);});
  if(errs.length)return {errs};
  const byName={};Object.keys(AD.foods).concat(['pudding']).forEach(id=>{byName[id]=id;byName[adFoodName(id).toLowerCase()]=id;});
  const typeOf=v=>({t:'T',training:'T',train:'T',r:'R',rest:'R',s:'S',saturday:'S',sat:'S',saturday_training:'S'})[v.trim().toLowerCase().replace(/[\s-]+/g,'_')];
  const boxOf=v=>({p:'p',protein:'p',c:'c',carb:'c',carbs:'c',x:'x',f:'x',fat:'x',fats:'x',additional_fats:'x'})[v.trim().toLowerCase().replace(/[\s-]+/g,'_')];
  const plan={};
  rows.slice(1).forEach((r,ri)=>{
    const line=ri+2, get=n=>col(n)<0?'':String(r[col(n)]||'').trim();
    const t=typeOf(get('day_type'));
    if(!t){errs.push(`Line ${line}: day type "${get('day_type')}" should be training, rest or saturday.`);return;}
    const mid=get('meal');if(!mid){errs.push(`Line ${line}: meal number is missing.`);return;}
    const ms=plan[t]||(plan[t]=[]);
    let m=ms.find(x=>x.id===mid);
    if(!m){m={id:mid,name:get('meal_name')||`Meal ${mid}`,p:[],c:[],x:[]};ms.push(m);}
    if(get('note')&&!m.note)m.note=get('note');
    const fv=get('food');if(!fv)return;           /* a meal with no foods */
    const f=byName[fv.toLowerCase()];
    if(!f){errs.push(`Line ${line}: unknown food "${fv}". Use a food id or name from the Foods list, or add it there first.`);return;}
    const g=+get('grams').replace(/[^\d.]/g,'');
    if(!Number.isFinite(g)||get('grams')===''||g>5000){errs.push(`Line ${line}: amount "${get('grams')}" isn't a number of grams.`);return;}
    const grp=(AD.foods[f]||{}).group;
    const b=get('box')?boxOf(get('box')):grp==='p'?'p':grp==='x'?'x':'c';
    if(!b){errs.push(`Line ${line}: box "${get('box')}" should be protein, carbs or fats.`);return;}
    m[b].push({f,g,lock:/^(y|yes|true|1|x|locked)$/i.test(get('locked'))});
  });
  if(!Object.keys(plan).length&&!errs.length)errs.push('No plan rows found under the headings.');
  return {plan,errs};
}
/* load a defaults-shaped object (a JSON file or the AI's reading of a PDF) into the draft */
function adApplyJson(j){
  const full=j&&(j.plan||j.foods||j.schedule||j.targets);
  const plan=full?j.plan:j;
  if(full&&j.foods&&typeof j.foods==='object'){for(const [id,r] of Object.entries(j.foods)){if(id!=='pudding'&&r&&typeof r==='object')AD.foods[id]={...(AD.foods[id]||{group:'',unit:'g',min:null,max:null,order:null,d:0,step:5}),...r};}}
  if(full&&Array.isArray(j.schedule)&&j.schedule.length===7&&j.schedule.every(t=>['T','R','S'].includes(t)))AD.schedule=[...j.schedule];
  if(full&&j.targets&&typeof j.targets==='object')AD_TYPES.forEach(([t])=>{if(j.targets[t])AD.targets[t]={...AD.targets[t],...j.targets[t]};});
  if(plan&&typeof plan==='object'){const got=AD_TYPES.filter(([t])=>Array.isArray(plan[t])&&plan[t].length);
    got.forEach(([t])=>{AD.plan[t]=plan[t].map(m=>({id:String(m.id),name:String(m.name||''),...(m.note?{note:String(m.note)}:{}),
      p:[...(m.p||[])],c:[...(m.c||[])],x:[...(m.x||[])]}));});
    if(got.length){AD.custom=true;if(!got.some(([t])=>t===adType))adType=got[0][0];}}
}
async function adUpload(file){
  if(!file)return;adMsg='';adErrs=[];adNotes=[];
  if(file.size>1024*1024){adErrs=['That file is over 1 MB – is it the right one?'];renderAdmin();return;}
  const text=await file.text();
  if(/\.json$/i.test(file.name)||/^\s*\{/.test(text)){
    let j;try{j=JSON.parse(text);}catch{adErrs=['That JSON file couldn’t be read.'];renderAdmin();return;}
    adApplyJson(j);
    adMsg=`Loaded ${file.name}. Check it below, then save.`;
  }else{
    const {plan,errs}=csvToPlan(text);
    if(errs.length){adErrs=errs;adMsg=`${file.name} wasn’t loaded:`;renderAdmin();return;}
    const got=AD_TYPES.filter(([t])=>plan[t]);
    got.forEach(([t])=>{AD.plan[t]=plan[t];});AD.custom=true;
    if(got.length&&!got.some(([t])=>t===adType))adType=got[0][0];
    adMsg=`Loaded ${got.map(([,n])=>n.toLowerCase()).join(', ')} plan${got.length>1?'s':''} from ${file.name}`+
      (got.length<3?` (${AD_TYPES.filter(([t])=>!plan[t]).map(([,n])=>n.toLowerCase()).join(' and ')} kept as before)`:'')+'. Check it below, then save.';
  }
  renderAdmin();
}

/* ---------- AI import (OpenRouter) ---------- */
async function adAiLoad(){try{adAi=await api('GET','/api/admin/ai');}catch(e){adAi=null;}adAiRender();}
function adAiRender(){
  if(!adAi)return;
  $('#ad-aistate').textContent=adAiBusy?'Reading the plan – this can take a minute or two…'
    :adAi.configured?`Using ${adAi.model}`:'Add an OpenRouter API key below to turn this on.';
  $('#ad-aibtn').classList.toggle('off',!adAi.configured||adAiBusy);
  $('#ad-aifile').disabled=!adAi.configured||adAiBusy;
  $('#ad-key').placeholder=adAi.configured?`Saved (${adAi.hint})${adAi.source==='env'?' – from .env':''}. Paste a new one to replace it`:'sk-or-…';
  if(document.activeElement!==$('#ad-model'))$('#ad-model').value=adAi.model;
  $('#ad-keydel').hidden=adAi.source!=='admin';
  if(!adAi.configured&&!$('#ad-keybox').open)$('#ad-keybox').open=true;
}
$('#ad-keyform').addEventListener('submit',async e=>{
  e.preventDefault();const body={model:$('#ad-model').value.trim()};const k=$('#ad-key').value.trim();if(k)body.key=k;
  try{adAi=await api('PUT','/api/admin/ai',body);$('#ad-key').value='';$('#ad-keymsg').textContent=k?'Key saved.':'Saved.';}
  catch(err){$('#ad-keymsg').textContent=err.message;}
  adAiRender();
});
$('#ad-keydel').addEventListener('click',async()=>{
  if(!confirm('Remove the saved OpenRouter key?'))return;
  try{adAi=await api('PUT','/api/admin/ai',{key:''});$('#ad-keymsg').textContent='Key removed.';}catch(err){$('#ad-keymsg').textContent=err.message;}
  adAiRender();
});
$('#ad-aifile').addEventListener('change',async e=>{
  const el=e.target, file=el.files&&el.files[0];el.value='';if(!file||adAiBusy)return;
  if(file.size>10*1024*1024){adErrs=['That file is over 10 MB.'];adMsg='';renderAdmin();return;}
  adAiBusy=true;adMsg='';adErrs=[];adNotes=[];adAiRender();renderAdmin();
  try{
    let r;
    try{r=await fetch('/api/admin/ai-import',{method:'POST',credentials:'same-origin',
      headers:{'content-type':file.type||'application/pdf','x-csrf-token':csrf},body:file});}
    catch{throw new Error('Can’t reach the server – is it still running?');}
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);
    adApplyJson(j);
    const got=AD_TYPES.filter(([t])=>j.plan&&j.plan[t]).map(([,n])=>n.toLowerCase());
    const nf=Object.keys(j.foods||{}).length;
    adMsg=`AI read ${file.name}: ${got.join(', ')} plan${got.length>1?'s':''}${nf?`, ${nf} new food${nf>1?'s':''}`:''}${j.targets&&Object.keys(j.targets).length?', targets':''}${j.schedule?', week schedule':''}. Check it below, then save.`;
    adNotes=j.notes||[];
  }catch(err){adMsg='The AI import didn’t work:';adErrs=[err.message];}
  adAiBusy=false;adAiRender();renderAdmin();
});
