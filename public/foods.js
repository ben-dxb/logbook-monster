'use strict';
/* Foods view: the food library. Whole meals and single ingredients you enter yourself (per 100 g, per 100 ml
   or per item) with an optional recipe, and foods other people have shared. Search, filters and sorting
   find one; "Add to plan" puts it in a meal or a day's off-plan list. AI can fill in values left blank – those are
   flagged (⚑) and tapping a flag shows the source the AI gave.
   Your meal plan is always in the library too, with nothing to enter: each meal in it as a whole meal and
   each food it uses as an ingredient, worked out from the plan in use, so they follow every plan change.
   Starter foods (STARTER in starter.js) are there for everyone too. A food weighed raw or cooked with a
   cooked yield can be shown either way: Weights switches the whole list, the Raw/Cooked buttons one card.
   #foods, #foods/new, #foods/12 (edit one of yours). Uses helpers and LIB from app.js. */

const F_KEY='lm.foodFilters';
const fF={kind:'all',who:'all',order:'name',tags:[],group:''};      /* filters, remembered per browser */
try{const s=JSON.parse(localStorage.getItem(F_KEY)||'null');if(s&&typeof s==='object')Object.assign(fF,s);if(!Array.isArray(fF.tags))fF.tags=[];}catch{}
if(!FOOD_GROUPS.includes(fF.group))fF.group='';
const fKeep=()=>{try{localStorage.setItem(F_KEY,JSON.stringify(fF));}catch{}};
let fQuery='', fAdding=null, fMsg='', fTok=0, fAiOn=false, fEdit=null;
const fOpen=new Set();                                     /* foods whose AI source is showing */
const fWt=new Map();                                       /* raw/cooked chosen on one card, by food id */
if(!['raw','cooked'].includes(fF.wt))fF.wt='raw';

/* ---------- your meal plan, as library entries ---------- */
function fHash(s){let h=5381;for(const ch of s)h=(h*33+ch.charCodeAt(0))>>>0;return h.toString(36);}
const fRound=x=>Math.round(x*10)/10;
function fPlanFoods(){
  const out=[], used=new Set(), meals=new Map();
  const ing=(id)=>{const F=FOODS[id];if(!planFood(id)||used.has(id))return;used.add(id);
    out.push({id:'plan:f:'+id,fid:id,plan:true,mine:false,public:false,ai:null,by:null,kind:'ingredient',
      name:F.n,unit:F.unit==='ml'?'ml':'g',group:SWAP_LISTS.x.includes(id)?'Fats':guessGroup(F.n),k:fRound(F.k),p:fRound(F.p),c:fRound(F.c),f:fRound(F.f),free:F.free||'',
      recipe:id==='pudding'?'Values from your rice pudding batch on the Daily Tracker page.':''});};
  /* every meal of every day template */
  for(const {id:t} of TEMPLATES){
    for(const m of planOf(t)){
      const items=['p','c','x'].flatMap(b=>m[b]||[]).filter(i=>FOODS[i.f]&&+i.g>0);
      if(!items.length)continue;
      const key=m.name+'|'+items.map(i=>i.f+':'+i.g).join(',');
      const e=meals.get(key)||{m,items,types:new Set()};e.types.add(t);meals.set(key,e);
    }
  }
  const names={};for(const e of meals.values())names[e.m.name]=(names[e.m.name]||0)+1;
  for(const [key,e] of meals){
    const tot={k:0,p:0,c:0,f:0};
    e.items.forEach(i=>{const F=FOODS[i.f];if(!isFree(i.f))for(const x in tot)tot[x]+=F[x]*i.g/100;ing(i.f);});   /* free sauces / veg count nothing, as on the Daily Tracker */
    const types=TEMPLATES.filter(t=>e.types.has(t.id)).map(t=>t.name);
    const days=types.length===TEMPLATES.length&&types.length>1?'every day template':fList(types);
    out.push({id:'plan:m:'+fHash(key),plan:true,mine:false,public:false,ai:null,by:null,kind:'meal',unit:'each',
      name:e.m.name+(names[e.m.name]>1?` (${days})`:''),k:fRound(tot.k),p:fRound(tot.p),c:fRound(tot.c),f:fRound(tot.f),days,
      recipe:e.items.map(i=>`${r0(i.g)}${FOODS[i.f].unit==='ml'?'ml':'g'} ${FOODS[i.f].n}`).join('\n')+(e.m.note?'\n\n'+e.m.note:'')});
  }
  /* the foods your plan lets you swap in */
  for(const g in SWAP_LISTS)SWAP_LISTS[g].forEach(ing);
  return out;
}
/* ---------- starter foods ---------- */
const F_STARTER=STARTER.map(x=>({id:'std:'+x.id,std:true,plan:false,mine:false,public:false,ai:null,by:null,kind:'ingredient',
  name:x.n,unit:x.u||'g',k:x.k,p:x.p,c:x.c,f:x.f,free:x.fr||'',recipe:'',group:x.g,state:x.s||'',yield:x.y||null,dry:x.s==='raw'&&x.g==='Grains and potatoes'&&!/potato/i.test(x.n)||/lentil/i.test(x.n),
  about:`${x.note?x.note+' ':''}Typical values from USDA FoodData Central (carbs include fibre) – check your pack.${x.y?` Cooked values assume it weighs about ${x.y}% of the ${x.s==='raw'&&/rice|pasta|quinoa|lentil/i.test(x.n)?'dry':'raw'} weight once cooked.`:''}`}));

let fPlanCache=null;
/* the plan only changes when the defaults or the pudding batch do; recomputed on each list render */
const fAll=()=>[...(fPlanCache=fPlanFoods()),...F_STARTER,...LIB];
const fById=id=>(fPlanCache&&fPlanCache.find(f=>f.id===String(id)))||F_STARTER.find(f=>f.id===String(id))||LIB.find(f=>String(f.id)===String(id));

/* ---------- raw or cooked ---------- */
const fCanWt=f=>!!(f.state&&f.yield&&f.unit==='g');
const fWord=(f,st)=>st==='raw'?(f.dry?'dry':'raw'):'cooked';
/* the food as shown: values per 100 g in the state picked for its card, or for the whole list */
function fShown(f){
  if(!f||!f.state)return f;
  const want=fCanWt(f)?fWt.get(String(f.id))||fF.wt:f.state;
  const base=f.name.replace(/\s*\((raw|cooked|dry|uncooked)\)\s*$/i,'');
  const out={...f,shown:want,name:`${base} (${fWord(f,want)})`};
  if(want!==f.state){const m=want==='cooked'?100/f.yield:f.yield/100;for(const x of ['k','p','c','f'])out[x]=fRound(f[x]*m);}
  return out;
}
const M_NAME={k:'calories',p:'protein',c:'carbs',f:'fat'};
const fFlagged=(f,m)=>!!(f.ai&&f.ai.fields.includes(m));
function fMacros(f,flags){
  const v=(m,txt)=>flags&&fFlagged(f,m)
    ?`<button type="button" class="aiv" data-fa="src" data-id="${f.id}" aria-expanded="${fOpen.has(String(f.id))}" title="AI estimate – tap to see the source">⚑ ${txt}</button>`:txt;
  return `${v('k',`<b>${r0(f.k)}</b> kcal`)} · ${v('p','P '+r1(f.p))} · ${v('c','C '+r1(f.c))} · ${v('f','F '+r1(f.f))}`;
}
function fSort(){LIB.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.id-b.id);libRegister();}
const fList=list=>list.join(', ').replace(/, ([^,]*)$/,' and $1');

/* What the AI said, for a card or the edit form. */
function fSource(ai){
  if(!ai)return '';
  const meta=[ai.confidence?ai.confidence+' confidence':'',ai.model,ai.at].filter(Boolean).map(esc).join(' · ');
  return `<div class="aisrc"><p><b>⚑ AI estimate</b> of ${esc(fList(ai.fields.map(m=>M_NAME[m])))}${meta?` <span class="muted">· ${meta}</span>`:''}</p>
    <p><span class="lbl">Source</span> ${esc(ai.source)}</p>
    ${ai.basis.length?`<ul>${ai.basis.map(b=>`<li>${esc(b)}</li>`).join('')}</ul>`:''}
    ${ai.url?`<p><a href="${esc(ai.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(ai.url.replace(/^https:\/\//,'').slice(0,60))}</a> <span class="muted">(link given by the AI – not checked)</span></p>`:''}
    <p class="muted">Estimates can be off – check the label if you have it. Typing your own number removes the flag.</p></div>`;
}

async function renderFoods(args){
  if(view!=='foods')return;
  const tok=++fTok, box=$('#f-body'), [p]=args||[];
  if(p==='new'||/^\d+$/.test(p||'')){
    let food=p==='new'?null:fById(+p);
    if(p!=='new'&&!(food&&food.mine)){   /* added in another tab since the list was read? read it again before saying it isn't there */
      box.innerHTML=gHead('#foods','Food')+'<p class="note">Loading…</p>';
      try{await fFetch();}catch(e){if(e.signedOut)return;}
      if(tok!==fTok||view!=='foods')return;
      food=fById(+p);
      if(!(food&&food.mine)){box.innerHTML=gHead('#foods','Food')+gEmpty('That food isn’t in your library.');return;}
    }
    fEdit={ai:food&&food.ai?JSON.parse(JSON.stringify(food.ai)):null,unitSet:!!food};
    box.innerHTML=fEditPage(food);fPaintAi();fPaintState();$('#f-name').focus();return;
  }
  box.innerHTML=fListPage();renderFoodList();
  try{if(!await fFetch()||tok!==fTok||view!=='foods')return;renderFoodList();}
  catch(e){if(!e.signedOut&&tok===fTok){fMsg='Couldn’t refresh the library: '+e.message;renderFoodList();}}
}
async function fFetch(){const r=await api('GET','/api/foods');if(!r)return false;LIB=r.foods;fAiOn=!!r.ai;fSort();return true;}
/* back to this tab: the library again, in case another tab or device changed it (the list only – a form being filled in stays) */
document.addEventListener('visibilitychange',()=>{
  if(document.hidden||view!=='foods'||$('#f-form'))return;
  const tok=fTok;fFetch().then(ok=>{if(ok&&tok===fTok&&view==='foods'&&!$('#f-form'))renderFoodList();}).catch(()=>{});
});

/* ---------- filters ---------- */
const TAGS=[['hp','High protein'],['lc','Low calorie'],['recipe','Has recipe'],['ai','AI estimates']];
const ORDERS=[['name','A–Z'],['kcal','Fewest calories'],['protein','Most protein'],['ratio','Protein per calorie']];
const fRatio=f=>f.k>0?f.p*4/f.k:f.p>0?1:0;
/* a food's group: starter and plan foods carry one, other ingredients are guessed from the name; meals have none */
const fGroup=f=>f.kind==='meal'?'':f.group!=null?f.group:guessGroup(f.name);
const fTest={
  hp:f=>fRatio(f)>=0.3,                                    /* 30 % or more of the calories from protein */
  lc:f=>f.unit==='each'?f.k<=400:f.k<=100,                 /* a portion up to 400 kcal, or up to 100 kcal per 100 g/ml */
  recipe:f=>!!f.recipe,
  ai:f=>!!f.ai,
};
function fMatch(f,skipKind,skipGroup){
  const q=fQuery.trim().toLowerCase();
  return (skipKind||fF.kind==='all'||f.kind===fF.kind)
    &&(fF.who==='all'||(fF.who==='plan'?f.plan:fF.who==='starter'?f.std:fF.who==='mine'?f.mine:!f.mine&&!f.plan&&!f.std))
    &&fF.tags.every(t=>!fTest[t]||fTest[t](f))
    &&(skipGroup||!fF.group||fGroup(f)===fF.group)
    &&(!q||f.name.toLowerCase().includes(q)||f.recipe.toLowerCase().includes(q)||(!!f.by&&f.by.toLowerCase().includes(q)));
}
function fOrdered(list){
  const by={kcal:(a,b)=>a.k-b.k,protein:(a,b)=>b.p-a.p,ratio:(a,b)=>fRatio(b)-fRatio(a)}[fF.order];
  return list.slice().sort((a,b)=>(by?by(a,b):0)||a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
}
const fBusy=()=>fF.who!=='all'||fF.tags.length||fF.group||fQuery.trim()||fF.kind!=='all';

/* ---------- the list ---------- */
function fListPage(){
  const who=[['all','Everything'],['plan','My meal plan'],['starter','Starter foods'],['mine','Foods I added'],['shared','Shared with me']].map(([v,l])=>`<option value="${v}"${fF.who===v?' selected':''}>${l}</option>`).join('');
  const ord=ORDERS.map(([v,l])=>`<option value="${v}"${fF.order===v?' selected':''}>${l}</option>`).join('');
  const tags=TAGS.map(([v,l])=>`<button type="button" data-fa="tag" data-v="${v}" aria-pressed="${fF.tags.includes(v)}">${l}</button>`).join('');
  return `<div class="gbar"><h2>Food Library</h2><a class="btn" href="#foods/new">New food</a></div>
    <p class="fintro">Your meal plan is already here – every meal in it and every food it uses, kept up to date with the plan – along with common fitness foods to start from. “Weights” shows foods per 100 g raw or cooked. Add your own meals and ingredients too, with a recipe if you like. Share one and everyone can add it to their plan. “Add to plan” puts it in a meal or the off-plan list of any day, and the rest of the day rebalances around it. In the Daily Tracker you’ll also find them under “+ Add a food…” in every meal. Values marked ⚑ were estimated by AI – tap one to see where it came from.</p>
    <div class="seg fkinds" id="f-kinds" role="group" aria-label="Type"></div>
    <div class="ftools"><input id="f-q" type="search" placeholder="Search names, recipes and people" aria-label="Search foods" value="${esc(fQuery)}">
      <label class="fsel"><span class="lbl">Show</span><select id="f-who">${who}</select></label>
      <label class="fsel"><span class="lbl">Sort</span><select id="f-order">${ord}</select></label>
      <div class="fsel"><span class="lbl">Weights</span><div class="seg" role="group" aria-label="Show weights" id="f-wt">${fWtSeg(fF.wt,'wtall','')}</div></div></div>
    <div class="seg ftags" role="group" aria-label="Filters">${tags}</div>
    <div class="seg ftags fgroups" id="f-groups" role="group" aria-label="Food group"></div>
    <div class="fcount"><span id="f-count" role="status"></span><button type="button" class="ghost" data-fa="clear" id="f-clear">Clear filters</button></div>
    <div id="f-list" class="flist"></div>`;
}
function renderFoodList(){
  const el=$('#f-list');if(!el)return;
  /* the type tabs count what the other filters leave */
  const all=fAll().map(fShown), base=all.filter(f=>fMatch(f,true));
  const n={all:base.length,meal:base.filter(f=>f.kind==='meal').length,ingredient:base.filter(f=>f.kind!=='meal').length};
  $('#f-kinds').innerHTML=[['all','All'],['meal','Meals'],['ingredient','Ingredients']]
    .map(([v,l])=>`<button type="button" data-fa="kind" data-v="${v}" aria-pressed="${fF.kind===v}">${l} <small>${n[v]}</small></button>`).join('');
  /* the group chips count what the other filters leave too; tapping the one picked shows every group again */
  const inGroups=all.filter(f=>fMatch(f,false,true));
  $('#f-groups').innerHTML=FOOD_GROUPS.map(g=>[g,inGroups.filter(f=>fGroup(f)===g).length]).filter(([g,c])=>c||fF.group===g)
    .map(([g,c])=>`<button type="button" data-fa="group" data-v="${esc(g)}" aria-pressed="${fF.group===g}">${esc(g)} <small>${c}</small></button>`).join('');
  const list=fOrdered(base.filter(f=>fF.kind==='all'||f.kind===fF.kind));
  $('#f-count').textContent=all.length?`${list.length} of ${all.length} food${all.length===1?'':'s'}`:'';
  $('#f-clear').hidden=!fBusy();
  let h=fMsg?`<p class="note fmsg" role="status">${esc(fMsg)}</p>`:'';
  if(!all.length)h+=gEmpty('Nothing here yet. Tap “New food” to add a meal or an ingredient, or tick “Save to my food library” when you add something off plan on the Daily Tracker page.');
  else if(!list.length)h+=gEmpty(fF.who==='shared'&&!fQuery.trim()&&!fF.tags.length&&!fF.group?'Nobody has shared a food like that yet.':'No foods match. Try fewer filters.');
  /* A–Z gets letter headings once the list is long enough to scroll */
  let last='';
  for(const f of list){
    if(fF.order==='name'&&list.length>12){
      const l=(f.name[0]||'#').toUpperCase().replace(/[^A-Z]/,'#');
      if(l!==last){h+=`<h3 class="fletter">${esc(l)}</h3>`;last=l;}
    }
    h+=fCard(f);
  }
  el.innerHTML=h;
}
function fCard(f){
  const tag=f.std?`<span class="chip std">Starter · ${esc(f.group)}</span>`:f.plan?`<span class="chip plan">Your meal plan${f.days?' · '+esc(f.days):''}</span>`:f.mine?(f.public?'<span class="chip ok">Shared</span>':'<span class="chip">Only you</span>')
    :`<span class="chip info">Shared${f.by?' by '+esc(f.by):''}</span>`;
  const kind=f.kind==='meal'?'<span class="chip kind">Meal</span>':'<span class="chip kind">Ingredient</span>';
  const canDel=!f.plan&&!f.std&&(f.mine||isAdmin);
  const adding=fAdding&&fAdding.id===f.id;
  return `<article class="fcard" data-id="${f.id}">
    <div class="fhead"><h3>${esc(f.name)}</h3>${kind}${tag}${fFreeChip(f)}</div>
    <span class="ml">${fMacros(f,true)} <i>${libPer(f.unit)}${f.shown?' '+fWord(f,f.shown):''}</i></span>
    ${fCanWt(f)?`<div class="fwt"><div class="seg" role="group" aria-label="Weighed">${fWtSeg(f.shown,'wt',f.id,f)}</div><span class="muted">cooked ≈ ${f.yield}% of ${fWord(f,'raw')} weight</span></div>`:''}
    ${f.ai&&fOpen.has(String(f.id))?fSource(f.ai):''}
    ${f.about?`<details class="frecipe"><summary>About these values</summary><p>${esc(f.about)}</p></details>`:''}
    ${f.recipe?`<details class="frecipe"><summary>${f.kind==='meal'?'Recipe':'Notes'}</summary><p>${esc(f.recipe)}</p></details>`:''}
    ${adding?fAddForm(f):`<div class="factions"><button class="btn" type="button" data-fa="add" data-id="${f.id}">Add to plan</button>
      ${f.mine?`<a class="ghost" href="#foods/${f.id}">Edit</a>`:''}
      ${f.plan?'<a class="ghost" href="#account">Change in my plan</a>':''}
      ${canDel?`<button class="ghost" type="button" data-fa="del" data-id="${f.id}">${f.mine?'Delete':'Delete (admin)'}</button>`:''}</div>`}
  </article>`;
}
/* a sauce or green veg: says so, and whether your plan counts it as free (no macros) */
const F_FREE={sauce:'Sauce',veg:'Green veg'};
const fFreeChip=f=>F_FREE[f.free]?`<span class="chip kind">${F_FREE[f.free]}${FREE[f.free]?' · free':''}</span>`:'';
function fWtSeg(cur,act,id,f){
  return ['raw','cooked'].map(v=>`<button type="button" data-fa="${act}" data-v="${v}"${id!==''?` data-id="${esc(id)}"`:''} aria-pressed="${cur===v}">${v==='raw'?(f&&f.dry?'Dry':f?'Raw':'Raw / dry'):'Cooked'}</button>`).join('');
}
function fAddForm(f){
  const a=fAdding, m=libMac({u:f.unit,per:f},+a.qty||0);
  const ul=f.unit==='each'?'How many':f.unit==='ml'?'Millilitres':'Grams';
  return `<form class="fadd" id="f-addform" data-id="${f.id}">
    <label class="f"><span class="lbl">Day</span><input id="f-adate" type="date" value="${esc(a.date)}" required></label>
    <label class="f"><span class="lbl">${ul}</span><input id="f-aqty" type="number" inputmode="decimal" min="0" step="${f.unit==='each'?'0.5':'1'}" value="${esc(a.qty)}" required></label>
    <label class="f fwhere"><span class="lbl">Where</span><select id="f-awhere">${fWhereOpts(a.date,a.where)}</select></label>
    <span class="ml fprev" id="f-aprev">${fMacros(m)}</span>
    <div class="factions"><button class="btn" type="submit">Add to plan</button><button class="ghost" type="button" data-fa="cancel">Cancel</button></div>
  </form>`;
}

/* the meals of that day (as saved, or as the plan would start it), plus the off-plan list. A saved day not loaded yet is loaded
   first – its meals can differ from the plan's (another template, meals eaten), so the plan's are never offered for it. */
function fWhereOpts(date,sel){
  let meals=[];
  if(isDate(date)&&!S.days[date]&&LOGGED.has(date)){fWhereLoad(date);return `<option value="off">Off plan</option><option disabled>Loading that day’s meals…</option>`;}
  if(isDate(date)){try{meals=S.days[date]?S.days[date].meals:freshOn(date).meals;}catch{meals=[];}}
  return `<option value="off">Off plan</option>`+meals.map((m,mi)=>`<option value="${mi}"${String(mi)===String(sel)&&!m.eaten?' selected':''}${m.eaten?' disabled':''}>Meal ${esc(m.id)} – ${esc(m.name)}${m.eaten?' (eaten)':''}</option>`).join('');
}
const F_WHERE=new Set();
async function fWhereLoad(date){if(F_WHERE.has(date))return;F_WHERE.add(date);
  try{await loadDay(date);}finally{F_WHERE.delete(date);}
  const s=$('#f-awhere');if(s&&S.days[date]&&fAdding&&fAdding.date===date)s.innerHTML=fWhereOpts(date,fAdding.where);}

/* ---------- add / edit ---------- */
const fNotesLabel=k=>k==='meal'?'Recipe (optional)':'Notes (optional) – brand, where to buy';
function fEditPage(f){
  const v=f||{name:'',unit:fF.kind==='meal'?'each':'g',kind:fF.kind==='meal'?'meal':'ingredient',k:'',p:'',c:'',f:'',recipe:'',public:false};
  const unit=[['g','per 100 g'],['ml','per 100 ml'],['each','per item / portion']].map(([u,l])=>`<option value="${u}"${v.unit===u?' selected':''}>${l}</option>`).join('');
  const kinds=[['ingredient','Single ingredient'],['meal','Whole meal']].map(([k,l])=>`<button type="button" data-fa="fkind" data-v="${k}" aria-pressed="${v.kind===k}">${l}</button>`).join('');
  const box=(m,l)=>`<label class="f"><span class="lbl">${l} <span class="aimark" id="f-${m}-flag" hidden>⚑ AI</span></span><input id="f-${m}" type="number" inputmode="decimal" min="0" step="any" value="${esc(v[m])}"></label>`;
  return gHead('#foods',f?'Edit food':'New food')+`
    <form id="f-form" class="panel fform" data-id="${f?f.id:''}" data-ver="${f&&f.updated?esc(f.updated):''}" data-kind="${v.kind}">
      <label class="f fwide"><span class="lbl">Name</span><input id="f-name" maxlength="80" required value="${esc(v.name)}" placeholder="e.g. Protein pancakes, or Chicken breast (raw)"></label>
      <div class="f fwide"><span class="lbl">This is a</span><div class="seg" role="group" aria-label="Type">${kinds}</div></div>
      <label class="f fwide"><span class="lbl">Values are</span><select id="f-unit">${unit}</select></label>
      <label class="f fwide"><span class="lbl">Free food</span><select id="f-free">${[['','No – always counted'],...Object.entries(F_FREE)].map(([x,l])=>`<option value="${x}"${(v.free||'')===x?' selected':''}>${l}</option>`).join('')}</select>
        <span class="muted">A sauce or green veg counts no macros when your plan sets that kind free (Account admin).</span></label>
      <label class="f fstate"><span class="lbl">Weighed</span><select id="f-state">${[['','Neither (ready to eat)'],['raw','Raw / dry'],['cooked','Cooked']].map(([x,l])=>`<option value="${x}"${(v.state||'')===x?' selected':''}>${l}</option>`).join('')}</select></label>
      <label class="f fstate"><span class="lbl">Cooked weight, % of raw</span><input id="f-yield" type="number" inputmode="numeric" min="10" max="1000" step="1" value="${esc(v.yield==null?'':v.yield)}" placeholder="e.g. 75 chicken, 280 rice"></label>
      ${box('k','kcal')}${box('p','Protein g')}${box('c','Carbs g')}${box('f','Fat g')}
      ${fAiOn?`<div class="faifill fwide"><button class="ghost" type="button" data-fa="fill" id="f-fill">⚑ Fill blanks with AI</button>
        <span class="muted">Leave a box empty and AI estimates it from the name, the type and the recipe or notes. Its values are flagged so you can see the source.</span></div>`:''}
      <p id="f-aimsg" class="note fwide" role="status" hidden></p>
      <div id="f-aisrc" class="fwide"></div>
      <label class="f fwide"><span class="lbl" id="f-recipe-lbl">${fNotesLabel(v.kind)}</span><textarea id="f-recipe" rows="7" maxlength="4000" placeholder="Ingredients and method, e.g.&#10;60g oats&#10;30g whey&#10;2 eggs&#10;Blend, cook in a hot pan 2 minutes a side.">${esc(v.recipe)}</textarea></label>
      <label class="tog fwide"><input type="checkbox" id="f-public"${v.public?' checked':''}> Share with everyone – any account can see it and add it to their plan (only you can change it)</label>
      <p id="f-err" class="aderr fwide" role="alert" hidden></p>
      <div class="factions fwide"><button class="btn" type="submit">${f?'Save changes':'Add to library'}</button><a class="ghost" href="#foods">Cancel</a>
        ${f?`<button class="ghost fdel" type="button" data-fa="del" data-id="${f.id}">Delete</button>`:''}</div>
    </form>`;
}
/* Mark the boxes AI filled and show its source under them. */
/* raw / cooked only means something for foods weighed in grams; the yield only once one is picked */
function fPaintState(){
  const g=$('#f-unit').value==='g';
  $('#f-state').closest('label').hidden=!g;$('#f-yield').closest('label').hidden=!g||!$('#f-state').value;
}
function fPaintAi(){
  const ai=fEdit&&fEdit.ai;
  for(const m of ['k','p','c','f']){const on=!!(ai&&ai.fields.includes(m));$('#f-'+m+'-flag').hidden=!on;$('#f-'+m).classList.toggle('aifill',on);}
  $('#f-aisrc').innerHTML=fSource(ai);
}
async function fFill(btn){
  const v=id=>$('#'+id).value, msg=$('#f-aimsg'), err=$('#f-err');
  const body={name:v('f-name'),unit:v('f-unit'),kind:$('#f-form').dataset.kind,recipe:v('f-recipe'),state:v('f-state')};
  /* blank boxes and ones AI filled before get (re)estimated together, so one source covers them all */
  for(const m of ['k','p','c','f'])body[m]=fEdit.ai&&fEdit.ai.fields.includes(m)?'':v('f-'+m).trim();
  err.hidden=true;
  if(!body.name.trim()){err.textContent='Give the food a name first – AI works from it.';err.hidden=false;$('#f-name').focus();return;}
  btn.disabled=true;msg.hidden=false;msg.textContent='Asking AI…';
  /* the answer is for this form and this name: dropped if the form was closed or reopened (another food, New food) or renamed meanwhile */
  const form=$('#f-form'), ed=fEdit, here=()=>form.isConnected&&fEdit===ed;
  try{
    const r=await api('POST','/api/foods/ai-fill',body);
    if(!here())return;
    if(v('f-name')!==body.name){msg.textContent='The name changed while AI was looking – tap Fill blanks with AI again.';return;}
    for(const [m,x] of Object.entries(r.values))$('#f-'+m).value=x;
    if(r.yield&&!$('#f-yield').value.trim())$('#f-yield').value=r.yield;
    fEdit.ai=r.ai;fPaintAi();
    msg.textContent=`AI filled in ${fList(r.ai.fields.map(m=>M_NAME[m]))}. Check them – its source is below.`;
  }catch(e){if(!here())return;msg.hidden=true;if(!e.signedOut){err.textContent=e.message;err.hidden=false;}}
  finally{btn.disabled=false;}
}
async function fSave(form){
  const v=id=>$('#'+id).value, err=$('#f-err');
  const body={name:v('f-name'),unit:v('f-unit'),kind:form.dataset.kind,k:v('f-k'),p:v('f-p'),c:v('f-c'),f:v('f-f'),recipe:v('f-recipe'),public:$('#f-public').checked,ai:fEdit&&fEdit.ai,state:v('f-state'),yield:v('f-yield'),free:v('f-free')};
  const id=form.dataset.id, btn=form.querySelector('button[type=submit]');
  btn.disabled=true;err.hidden=true;
  try{
    const food=await api(id?'PUT':'POST','/api/foods'+(id?'/'+id:''),body,id&&form.dataset.ver||undefined);
    LIB=LIB.filter(x=>x.id!==food.id);LIB.push(food);fSort();
    fMsg=id?`Saved “${food.name}”.`:`Added “${food.name}” to your library.`;go('foods');
  }catch(e){btn.disabled=false;if(!e.signedOut){err.textContent=e.message+(fAiOn&&/calories or macros/.test(e.message)?' – or tap “Fill blanks with AI”.':'');err.hidden=false;
    if(e.conflict||/No such/.test(e.message))fFetch().catch(()=>{});}}   /* changed or gone elsewhere: the list shows it as it is now */
}
async function fDelete(id){
  const f=fById(id);if(!f)return;
  if(!confirm(f.mine?`Delete “${f.name}” from your library? Days you've already added it to keep it.`:`Delete “${f.name}”${f.by?' (shared by '+f.by+')':''} from the library for everyone?`))return;
  try{await api('DELETE','/api/foods/'+id);}catch(e){if(!e.signedOut)alert(e.message);return;}
  LIB=LIB.filter(x=>x.id!==id);libRegister();fMsg=`Deleted “${f.name}”.`;
  if(location.hash==='#foods')renderFoodList();else go('foods');
}

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-fa]');if(!b||view!=='foods')return;
  const a=b.dataset.fa;
  if(a==='src'){const id=b.dataset.id;if(fOpen.has(id))fOpen.delete(id);else fOpen.add(id);renderFoodList();
    const nb=document.querySelector(`.fcard[data-id="${id}"] [data-fa=src]`);if(nb)nb.focus();return;}
  if(a==='fill'){fFill(b);return;}
  if(a==='fkind'){
    const form=$('#f-form'),k=b.dataset.v;form.dataset.kind=k;
    form.querySelectorAll('[data-fa=fkind]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
    if(!fEdit.unitSet){$('#f-unit').value=k==='meal'?'each':'g';fPaintState();}
    $('#f-recipe-lbl').textContent=fNotesLabel(k);return;
  }
  fMsg='';
  if(a==='kind'){fF.kind=b.dataset.v;fKeep();renderFoodList();}
  else if(a==='tag'){const t=b.dataset.v;fF.tags=fF.tags.includes(t)?fF.tags.filter(x=>x!==t):[...fF.tags,t];fKeep();b.setAttribute('aria-pressed',String(fF.tags.includes(t)));renderFoodList();}
  else if(a==='group'){fF.group=fF.group===b.dataset.v?'':b.dataset.v;fKeep();renderFoodList();const nb=document.querySelector(`#f-groups [data-v="${CSS.escape(b.dataset.v)}"]`);if(nb)nb.focus();}
  else if(a==='clear'){Object.assign(fF,{kind:'all',who:'all',tags:[],group:''});fQuery='';fKeep();$('#f-q').value='';$('#f-who').value='all';
    document.querySelectorAll('[data-fa=tag]').forEach(x=>x.setAttribute('aria-pressed','false'));renderFoodList();}
  else if(a==='wtall'){fF.wt=b.dataset.v;fWt.clear();fKeep();$('#f-wt').innerHTML=fWtSeg(fF.wt,'wtall','');renderFoodList();}
  else if(a==='wt'){fWt.set(b.dataset.id,b.dataset.v);if(fAdding&&String(fAdding.id)===b.dataset.id)fAdding=null;renderFoodList();   /* your own foods have number ids */
    const nb=document.querySelector(`.fcard[data-id="${b.dataset.id}"] [data-fa=wt][data-v=${b.dataset.v}]`);if(nb)nb.focus();}
  else if(a==='add'){const f=fShown(fById(b.dataset.id));if(!f)return;fAdding={id:f.id,date:S.cur,qty:libDefault(f.unit),where:'off'};renderFoodList();const q=$('#f-aqty');if(q)q.focus();}
  else if(a==='cancel'){fAdding=null;renderFoodList();}
  else if(a==='del'){fDelete(+b.dataset.id);}
});
document.addEventListener('change',e=>{
  if(view!=='foods')return;
  if(e.target.id==='f-who'){fF.who=e.target.value;fKeep();renderFoodList();}
  else if(e.target.id==='f-order'){fF.order=e.target.value;fKeep();renderFoodList();}
  else if(e.target.id==='f-unit'&&fEdit){fEdit.unitSet=true;fPaintState();}
  else if(e.target.id==='f-state'&&fEdit){fPaintState();}
});
document.addEventListener('input',e=>{
  if(view!=='foods')return;
  const id=e.target.id;
  if(id==='f-q'){fQuery=e.target.value;renderFoodList();}
  else if(fEdit&&fEdit.ai&&/^f-[kpcf]$/.test(id)){   /* your own number replaces the AI's */
    const m=id.slice(2);fEdit.ai.fields=fEdit.ai.fields.filter(x=>x!==m);if(!fEdit.ai.fields.length)fEdit.ai=null;fPaintAi();
  }
  else if(fAdding&&id==='f-awhere'){fAdding.where=e.target.value;}
  else if(fAdding&&(id==='f-aqty'||id==='f-adate')){
    fAdding[id==='f-aqty'?'qty':'date']=e.target.value;
    if(id==='f-adate'){fAdding.where='off';$('#f-awhere').innerHTML=fWhereOpts(fAdding.date,'off');}
    const f=fShown(fById(fAdding.id));if(f&&id==='f-aqty')$('#f-aprev').innerHTML=fMacros(libMac({u:f.unit,per:f},+e.target.value||0));
  }
});
document.addEventListener('submit',async e=>{
  if(e.target.id==='f-form'){e.preventDefault();once(e.target,()=>fSave(e.target));}
  else if(e.target.id==='f-addform'){
    e.preventDefault();const f=fShown(fById(e.target.dataset.id)),date=$('#f-adate').value,qty=+$('#f-aqty').value||0;
    if(!f)return;
    if(!isDate(date)||!(qty>0)){alert('Pick a day and an amount above 0.');return;}
    const w=$('#f-awhere').value;
    await once(e.target,()=>{fAdding=null;return addFoodToDay(f,date,qty,w==='off'?null:+w);});   /* the day may load first: a second click waits */
  }
});
