'use strict';
/* Foods view: the food library. Foods you enter yourself (per 100 g, per 100 ml or per item) with an
   optional recipe, and foods other people have shared. "Add to plan" puts one in a day's off-plan list.
   #foods, #foods/new, #foods/12 (edit one of yours). Uses helpers and LIB from app.js. */

let fFilter='all', fQuery='', fAdding=null, fMsg='', fTok=0;

const fById=id=>LIB.find(f=>f.id===id);
const fMacros=f=>`<b>${r0(f.k)}</b> kcal · P ${r1(f.p)} · C ${r1(f.c)} · F ${r1(f.f)}`;
function fSort(){LIB.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.id-b.id);LIBV++;}

async function renderFoods(args){
  if(view!=='foods')return;
  const tok=++fTok, box=$('#f-body'), [p]=args||[];
  if(p==='new'||/^\d+$/.test(p||'')){
    const food=p==='new'?null:fById(+p);
    if(p!=='new'&&!(food&&food.mine)){box.innerHTML=gHead('#foods','Food')+gEmpty('That food isn’t in your library.');return;}
    box.innerHTML=fEditPage(food);$('#f-name').focus();return;
  }
  box.innerHTML=fListPage();renderFoodList();
  try{const r=await api('GET','/api/foods');if(tok!==fTok||view!=='foods'||!r)return;LIB=r.foods;fSort();renderFoodList();}
  catch(e){if(!e.signedOut&&tok===fTok){fMsg='Couldn’t refresh the library: '+e.message;renderFoodList();}}
}

/* ---------- the list ---------- */
function fListPage(){
  const seg=[['all','All'],['mine','Mine'],['shared','Shared']].map(([v,l])=>`<button type="button" data-fa="filter" data-v="${v}" aria-pressed="${fFilter===v}">${l}</button>`).join('');
  return `<div class="gbar"><h2>Food Library</h2><a class="btn" href="#foods/new">New food</a></div>
    <p class="fintro">Foods you enter yourself, with their recipe if you like. Share one and everyone can add it to their plan. “Add to plan” puts it in a day’s off-plan list and the rest of the day rebalances around it.</p>
    <div class="ftools"><input id="f-q" type="search" placeholder="Search foods and recipes" aria-label="Search foods" value="${esc(fQuery)}">
      <div class="seg" role="group" aria-label="Show">${seg}</div></div>
    <div id="f-list" class="flist"></div>`;
}
function renderFoodList(){
  const el=$('#f-list');if(!el)return;
  const q=fQuery.trim().toLowerCase();
  const list=LIB.filter(f=>(fFilter==='all'||(fFilter==='mine')===f.mine)&&(!q||f.name.toLowerCase().includes(q)||f.recipe.toLowerCase().includes(q)));
  let h=fMsg?`<p class="note fmsg" role="status">${esc(fMsg)}</p>`:'';
  if(!LIB.length)h+=gEmpty('Nothing here yet. Tap “New food” to add one, or tick “Save to my food library” when you add something off plan on the Day page.');
  else if(!list.length)h+=gEmpty(fFilter==='shared'&&!q?'Nobody has shared a food yet.':fFilter==='mine'&&!q?'You haven’t added any foods yet.':'No foods match.');
  h+=list.map(fCard).join('');
  el.innerHTML=h;
}
function fCard(f){
  const tag=f.mine?(f.public?'<span class="chip ok">Shared</span>':'<span class="chip">Only you</span>')
    :`<span class="chip info">Shared${f.by?' by '+esc(f.by):''}</span>`;
  const canDel=f.mine||isAdmin;
  const adding=fAdding&&fAdding.id===f.id;
  return `<article class="fcard" data-id="${f.id}">
    <div class="fhead"><h3>${esc(f.name)}</h3>${tag}</div>
    <span class="ml">${fMacros(f)} <i>${libPer(f.unit)}</i></span>
    ${f.recipe?`<details class="frecipe"><summary>Recipe</summary><p>${esc(f.recipe)}</p></details>`:''}
    ${adding?fAddForm(f):`<div class="factions"><button class="btn" type="button" data-fa="add" data-id="${f.id}">Add to plan</button>
      ${f.mine?`<a class="ghost" href="#foods/${f.id}">Edit</a>`:''}
      ${canDel?`<button class="ghost" type="button" data-fa="del" data-id="${f.id}">${f.mine?'Delete':'Delete (admin)'}</button>`:''}</div>`}
  </article>`;
}
function fAddForm(f){
  const a=fAdding, m=libMac({u:f.unit,per:f},+a.qty||0);
  const ul=f.unit==='each'?'How many':f.unit==='ml'?'Millilitres':'Grams';
  return `<form class="fadd" id="f-addform" data-id="${f.id}">
    <label class="f"><span class="lbl">Day</span><input id="f-adate" type="date" value="${esc(a.date)}" required></label>
    <label class="f"><span class="lbl">${ul}</span><input id="f-aqty" type="number" inputmode="decimal" min="0" step="${f.unit==='each'?'0.5':'1'}" value="${esc(a.qty)}" required></label>
    <span class="ml fprev" id="f-aprev">${fMacros(m)}</span>
    <div class="factions"><button class="btn" type="submit">Add to plan</button><button class="ghost" type="button" data-fa="cancel">Cancel</button></div>
  </form>`;
}

/* ---------- add / edit ---------- */
function fEditPage(f){
  const v=f||{name:'',unit:'g',k:'',p:'',c:'',f:'',recipe:'',public:false};
  const unit=[['g','per 100 g'],['ml','per 100 ml'],['each','per item / portion']].map(([u,l])=>`<option value="${u}"${v.unit===u?' selected':''}>${l}</option>`).join('');
  return gHead('#foods',f?'Edit food':'New food')+`
    <form id="f-form" class="panel fform" data-id="${f?f.id:''}">
      <label class="f fwide"><span class="lbl">Name</span><input id="f-name" maxlength="80" required value="${esc(v.name)}" placeholder="e.g. Protein pancakes"></label>
      <label class="f fwide"><span class="lbl">Values are</span><select id="f-unit">${unit}</select></label>
      <label class="f"><span class="lbl">kcal</span><input id="f-k" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.k)}"></label>
      <label class="f"><span class="lbl">Protein g</span><input id="f-p" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.p)}"></label>
      <label class="f"><span class="lbl">Carbs g</span><input id="f-c" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.c)}"></label>
      <label class="f"><span class="lbl">Fat g</span><input id="f-f" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.f)}"></label>
      <label class="f fwide"><span class="lbl">Recipe (optional)</span><textarea id="f-recipe" rows="7" maxlength="4000" placeholder="Ingredients and method, e.g.&#10;60g oats&#10;30g whey&#10;2 eggs&#10;Blend, cook in a hot pan 2 minutes a side.">${esc(v.recipe)}</textarea></label>
      <label class="tog fwide"><input type="checkbox" id="f-public"${v.public?' checked':''}> Share with everyone – any account can see it and add it to their plan (only you can change it)</label>
      <p id="f-err" class="aderr fwide" role="alert" hidden></p>
      <div class="factions fwide"><button class="btn" type="submit">${f?'Save changes':'Add to library'}</button><a class="ghost" href="#foods">Cancel</a>
        ${f?`<button class="ghost fdel" type="button" data-fa="del" data-id="${f.id}">Delete</button>`:''}</div>
    </form>`;
}
async function fSave(form){
  const v=id=>$('#'+id).value, err=$('#f-err');
  const body={name:v('f-name'),unit:v('f-unit'),k:v('f-k'),p:v('f-p'),c:v('f-c'),f:v('f-f'),recipe:v('f-recipe'),public:$('#f-public').checked};
  const id=form.dataset.id, btn=form.querySelector('button[type=submit]');
  btn.disabled=true;err.hidden=true;
  try{
    const food=await api(id?'PUT':'POST','/api/foods'+(id?'/'+id:''),body);
    LIB=LIB.filter(x=>x.id!==food.id);LIB.push(food);fSort();
    fMsg=id?`Saved “${food.name}”.`:`Added “${food.name}” to your library.`;go('foods');
  }catch(e){btn.disabled=false;if(!e.signedOut){err.textContent=e.message;err.hidden=false;}}
}
async function fDelete(id){
  const f=fById(id);if(!f)return;
  if(!confirm(f.mine?`Delete “${f.name}” from your library? Days you've already added it to keep it.`:`Delete “${f.name}”${f.by?' (shared by '+f.by+')':''} from the library for everyone?`))return;
  try{await api('DELETE','/api/foods/'+id);}catch(e){if(!e.signedOut)alert(e.message);return;}
  LIB=LIB.filter(x=>x.id!==id);LIBV++;fMsg=`Deleted “${f.name}”.`;
  if(location.hash==='#foods')renderFoodList();else go('foods');
}

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-fa]');if(!b||view!=='foods')return;
  const a=b.dataset.fa;fMsg='';
  if(a==='filter'){fFilter=b.dataset.v;document.querySelectorAll('[data-fa=filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderFoodList();}
  else if(a==='add'){const f=fById(+b.dataset.id);fAdding={id:f.id,date:S.cur,qty:libDefault(f.unit)};renderFoodList();const q=$('#f-aqty');if(q)q.focus();}
  else if(a==='cancel'){fAdding=null;renderFoodList();}
  else if(a==='del'){fDelete(+b.dataset.id);}
});
document.addEventListener('input',e=>{
  if(view!=='foods')return;
  if(e.target.id==='f-q'){fQuery=e.target.value;renderFoodList();}
  else if(fAdding&&(e.target.id==='f-aqty'||e.target.id==='f-adate')){
    fAdding[e.target.id==='f-aqty'?'qty':'date']=e.target.value;
    const f=fById(fAdding.id);if(f&&e.target.id==='f-aqty')$('#f-aprev').innerHTML=fMacros(libMac({u:f.unit,per:f},+e.target.value||0));
  }
});
document.addEventListener('submit',async e=>{
  if(e.target.id==='f-form'){e.preventDefault();fSave(e.target);}
  else if(e.target.id==='f-addform'){
    e.preventDefault();const f=fById(+e.target.dataset.id),date=$('#f-adate').value,qty=+$('#f-aqty').value||0;
    if(!f)return;
    if(!isDate(date)||!(qty>0)){alert('Pick a day and an amount above 0.');return;}
    fAdding=null;await addFoodToDay(f,date,qty);
  }
});
