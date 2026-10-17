'use strict';
/* Meal plan data and the balancing maths, carried over unchanged from the original calculator.
   Uses the global S (state) for the rice pudding batch and snack overrides. */

const clone=o=>JSON.parse(JSON.stringify(o));
/* ---------- foods in use, per 100g (or 100ml): the account's plan foods (applyDefaults) and library foods (app.js).
   Rice pudding is always here – its values come from the batch on the Daily Tracker. */
const PUDDING={n:'Rice pudding (batch)',k:0,p:0,c:0,f:0,d:0,step:5,max:285,spill:'dates'};
const FOODS={pudding:clone(PUDDING)};
/* when a serving cap is hit, the rest spills into another food the plan has */
const SPILL={pudding:'dates',dates:'syrup'};
/* rice pudding: worked out from the batch in the "Rice pudding batch" panel (per 100g of finished pudding) */
const PUD_DEFAULT={rice:100,almond:700,oat:500,custard:20,casein:80,weight:1150};
const PUD_ING={ /* per 100g, or per 100ml for the milks */
  rice:{k:360,p:7,c:79,f:0.8}, almond:{k:13,p:0.4,c:0,f:1.1}, oat:{k:59,p:1.1,c:6.6,f:3.0},
  custard:{k:351,p:0.4,c:86.2,f:0.1}, casein:{k:353,p:70.6,c:8.8,f:2.9}};
const CASEIN_MAX=20;
function pudBatch(){const b={...PUD_DEFAULT,...((typeof S!=='undefined'&&S.pud)||{})};
  const t={k:0,p:0,c:0,f:0};
  for(const x in PUD_ING) for(const m in t) t[m]+=PUD_ING[x][m]*(+b[x]||0)/100;
  return {b,t,d:70.6*(+b.casein||0)/100};}
function pudServe(){const {b}=pudBatch();const w=+b.weight||1,c=+b.casein||0;
  return c>0?Math.max(5,Math.floor(w*CASEIN_MAX/c/5)*5):Math.round(w/3/5)*5;}
function recalcPudding(){
  const {b,t,d}=pudBatch();const w=Math.max(1,+b.weight||1);
  Object.assign(FOODS.pudding,{k:t.k/w*100,p:t.p/w*100,c:t.c/w*100,f:t.f/w*100,d:d/w*100,max:pudServe()});
  const sn=SNACKS.find(x=>x.id==='pudding');
  if(sn) Object.assign(sn,{k:FOODS.pudding.k,p:FOODS.pudding.p,c:FOODS.pudding.c,f:FOODS.pudding.f});
}
/* off-plan snacks: per item ('each') or per 100g ('g'). est = estimate, check the label */
const SNACKS=[
  {id:'reese',n:"Reese's mini",u:'each',k:48,p:1.0,c:5.2,f:2.8},
  {id:'shortbread',n:'Walkers shortbread fingers (pack of 2)',u:'each',k:200,p:2.2,c:24.2,f:10.8},
  {id:'skittles',n:'Skittles 38g bag',u:'each',k:154,p:0,c:34.4,f:1.6},
  {id:'deemah',n:'Deemah date biscuit (pack of 2)',u:'each',k:78,p:1.0,c:13.2,f:2.4},
  {id:'scroll',n:'Starbucks iced cinnamon scroll',u:'each',k:384,p:4.2,c:57.1,f:15.2},
  {id:'cookie',n:'Starbucks triple chocolate cookie',u:'each',k:527,p:6.9,c:67.2,f:25.2,est:true},
  {id:'ricecake',n:'Rice cakes',u:'g',k:385,p:8,c:81,f:2.8},
  {id:'malties',n:'Malties hazelnut spread',u:'g',k:523,p:5.5,c:59.6,f:28.5},
  {id:'biscoff',n:'Biscoff spread',u:'g',k:570,p:3,c:57.3,f:38},
  {id:'pudding',n:'Rice pudding (batch)',u:'g',k:0,p:0,c:0,f:0},
];
function snackVal(id){const s=SNACKS.find(x=>x.id===id);return id==='pudding'?{...s}:{...s,...((S.snackOv||{})[id]||{})};}
function snackMac(id,q){const s=snackVal(id);const m=s.u==='g'?q/100:q;return {k:s.k*m,p:s.p*m,c:s.c*m,f:s.f*m};}
/* the foods each box lets you swap between (from each plan food's group) */
const PROTEIN_SWAPS=[];
const CARB_SWAPS=[];
const FAT_SWAPS=[];
const BOXES=[['p','Protein'],['c','Carbs'],['x','Additional fats']];
const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
/* the account's day templates [{id,name}], which one each weekday uses (Monday first) and each one's targets */
const TEMPLATES=[];
const TYPE=[null,null,null,null,null,null,null];
const COACH={};
const MAC=['k','p','c','f'];

/* ---------- the account's plan: foods, day templates (each with meals and targets), week and free foods ---------- */
const it=(f,g,lock=false)=>({f,g,lock,a:g}); /* a = the amount you chose (plan or your own edit); rebalancing always starts from it */
let PLAN={};                                /* {templateId:[meals]} */
let PUD_ON=false;                           /* rice pudding is one of the plan's foods */
/* Free foods: a food tagged free:'sauce' or free:'veg' (green veg) counts no macros while that kind is set free
   (cfg.free, kept with the plan, so each day uses the setting in effect on its date). */
const FREE_KINDS=['sauce','veg'];
const FREE={sauce:false,veg:false};
const isFree=f=>{const F=FOODS[f];return !!(F&&F.free&&FREE[F.free]);};
const SWAP_LISTS={p:PROTEIN_SWAPS,c:CARB_SWAPS,x:FAT_SWAPS};
const ZERO_TARGETS={k:0,p:0,c:0,f:0};
/* a plan's own entry only: a template or food id like "constructor" never finds Object.prototype's */
const own=(o,k)=>o&&typeof o==='object'&&Object.prototype.hasOwnProperty.call(o,k)?o[k]:undefined;
function foodGroup(id){for(const g in SWAP_LISTS)if(SWAP_LISTS[g].includes(id))return g;return '';}
/* a calculator food from a plan's food record */
function planFoodRec(id,r){
  const F={};
  ['n','k','p','c','f','d','step'].forEach(k=>{F[k]=+r[k]||0;});
  F.n=String(r.n||id);F.step=+r.step||1;['min','max','order'].forEach(k=>{if(r[k]!=null)F[k]=+r[k];});
  if(r.unit==='ml')F.unit='ml';
  if(FREE_KINDS.includes(r.free))F.free=r.free;
  return F;
}
/* Use a plan (one of the account's dated plan changes, or null for none). Library foods (L:…) are dropped too –
   app.js registers them again after. */
function applyDefaults(cfg){
  cfg=cfg||{};
  for(const id in FOODS) if(id!=='pudding') delete FOODS[id];
  FOODS.pudding=clone(PUDDING);
  const groups={p:[],c:[],x:[]};
  const foods=cfg.foods&&typeof cfg.foods==='object'?cfg.foods:{};
  PUD_ON=!!foods.pudding;
  for(const [id,r] of Object.entries(foods)){
    if(!r||typeof r!=='object')continue;
    if(id==='pudding'){if(r.unit==='ml')FOODS.pudding.unit='ml';if(FREE_KINDS.includes(r.free))FOODS.pudding.free=r.free;}
    else FOODS[id]=planFoodRec(id,r);
    if(groups[r.group])groups[r.group].push(id);
  }
  for(const [a,b] of Object.entries(SPILL)){if(FOODS[a]){if(FOODS[b])FOODS[a].spill=b;else delete FOODS[a].spill;}}
  for(const g in SWAP_LISTS)SWAP_LISTS[g].splice(0,SWAP_LISTS[g].length,...groups[g]);
  TEMPLATES.splice(0,TEMPLATES.length,...(Array.isArray(cfg.templates)?cfg.templates.filter(t=>t&&t.id).map(t=>({id:String(t.id),name:String(t.name||t.id)})):[]));
  const first=TEMPLATES.length?TEMPLATES[0].id:null;
  const sch=Array.isArray(cfg.schedule)&&cfg.schedule.length===7?cfg.schedule:[];
  for(let d=0;d<7;d++)TYPE[d]=TEMPLATES.some(t=>t.id===sch[d])?sch[d]:first;
  for(const k in COACH)delete COACH[k];
  TEMPLATES.forEach(t=>{COACH[t.id]={...ZERO_TARGETS,...(own(cfg.targets,t.id)||{})};});
  PLAN=cfg.plan&&typeof cfg.plan==='object'?cfg.plan:{};
  FREE_KINDS.forEach(x=>{FREE[x]=!!(cfg.free&&cfg.free[x]);});
  if(typeof recalcPudding==='function'&&typeof S!=='undefined')recalcPudding();
}
const hasTemplate=id=>TEMPLATES.some(t=>t.id===id);
const templateName=id=>{const t=TEMPLATES.find(x=>x.id===id);return t?t.name:'';};
/* a plan food (not a library food, nor one only kept for an old day – .gone) the account can pick in its plan's boxes */
const planFood=id=>!!FOODS[id]&&!FOODS[id].gone&&(id!=='pudding'||PUD_ON)&&!String(id).startsWith('L:');
/* the meals of a day template, ready to use; foods that no longer exist are left out. Fats and spreads go in their own box. */
function planOf(t){
  const meals=own(PLAN,t);
  return (Array.isArray(meals)?meals:[]).map(m=>{const o={id:String(m.id),name:m.name,p:[],c:[],x:[]};if(m.note)o.note=m.note;
    ['p','c','x'].forEach(b=>(m[b]||[]).forEach(i=>{if(FOODS[i.f])o[b==='c'&&FAT_SWAPS.includes(i.f)?'x':b].push(it(i.f,+i.g||0,!!i.lock));}));return o;});
}
/* the plan in use for each day template, as plain data (what the admin page shows and downloads) */
function planData(){
  const out={};
  TEMPLATES.forEach(({id})=>{out[id]=planOf(id).map(m=>({id:m.id,name:m.name,...(m.note?{note:m.note}:{}),
    ...Object.fromEntries(['p','c','x'].map(b=>[b,(m[b]||[]).map(i=>({f:i.f,g:i.g,lock:!!i.lock}))]))}));});
  return out;
}

/* A new day from a day template: the weekday's (d, 0 = Monday) unless one is named. No plan: no meals, no targets. */
function freshDay(d,t){
  if(!hasTemplate(t))t=TYPE[d];
  const meals=t?planOf(t):[];
  const D={type:t||null,auto:true,targets:{...(t?COACH[t]:ZERO_TARGETS)},meals,base:null,off:[]};
  solve(D,new Set(),{protect:true}); /* fit the plan around the pudding batch without touching direct protein */
  allItems(D).forEach(i=>{i.a=i.g;});
  D.base=clone(D.meals);
  return D;
}

/* ---------- maths ---------- */
function macOf(f,g){const F=FOODS[f];if(isFree(f))return {k:0,p:0,c:0,f:0,d:0};return {k:F.k*g/100,p:F.p*g/100,c:F.c*g/100,f:F.f*g/100,d:F.d*g/100};}
/* an off-plan entry carries its own values; one from a free food (o.free) counts nothing while that kind is free */
function offMac(o){return o.free&&FREE[o.free]?{k:0,p:0,c:0,f:0,d:0}:{k:+o.k||0,p:+o.p||0,c:+o.c||0,f:+o.f||0,d:0};}
function sum(list){const t={k:0,p:0,c:0,f:0,d:0};list.forEach(x=>{for(const m in t)t[m]+=x[m]||0});return t;}
function allItems(day){const a=[];day.meals.forEach(m=>BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>a.push(i))));return a;}
function dayTotals(day){return sum(allItems(day).map(i=>macOf(i.f,i.g)).concat(day.off.map(offMac)));}

function gauss(M,r){
  const n=r.length;const A=M.map((row,i)=>row.concat([r[i]]));
  for(let i=0;i<n;i++){
    let mx=i;for(let k=i+1;k<n;k++)if(Math.abs(A[k][i])>Math.abs(A[mx][i]))mx=k;
    [A[i],A[mx]]=[A[mx],A[i]];
    const piv=A[i][i]||1e-12;
    for(let k=i+1;k<n;k++){const fct=A[k][i]/piv;for(let j=i;j<=n;j++)A[k][j]-=fct*A[i][j];}
  }
  const x=new Array(n).fill(0);
  for(let i=n-1;i>=0;i--){let s=A[i][n];for(let j=i+1;j<n;j++)s-=A[i][j]*x[j];x[i]=s/(A[i][i]||1e-12);}
  return x;
}
/* Which protein the protein target is measured against: 'total' (every food) or 'direct' (meat, eggs, dairy, whey).
   An account setting (S.pBasis); off-plan food counts as no direct protein. */
function pKey(){return typeof S!=='undefined'&&S.pBasis==='direct'?'d':'p';}
/* Move the unlocked amounts as little as possible (in % terms) while hitting the day targets.
   Calories and carbs are matched; protein is only pulled up if it falls short; fat only pulled down if it goes over. */
function solveWith(day,items,free,on){
  const pk=pKey(), key=m=>m==='p'?pk:m;
  const tgt=MAC.map(m=>+day.targets[m]||0);
  const cw=[0.01,0.1,0.3,0.05].map((x,j)=>on[j]?x:0);
  let active=free.slice(); const pinned=new Map(); let sol=null;
  for(let iter=0;iter<25&&active.length;iter++){
    const fixed=sum(items.filter(i=>!active.includes(i)).map(i=>macOf(i.f,pinned.has(i)?pinned.get(i):i.g))
      .concat(day.off.map(offMac)));
    const b=MAC.map((m,j)=>tgt[j]-fixed[key(m)]);
    const A=MAC.map(m=>active.map(i=>FOODS[i.f][key(m)]/100));
    const n=active.length, M=[], r=[];
    for(let a=0;a<n;a++){
      M.push(new Array(n).fill(0));
      const w=3/Math.pow(Math.max(active[a]._x0,30),2);
      for(let c=0;c<n;c++){let s=0;for(let j=0;j<4;j++)s+=cw[j]*A[j][a]*A[j][c];M[a][c]=s+(a===c?w:0);}
      let s=0;for(let j=0;j<4;j++)s+=cw[j]*A[j][a]*b[j];r.push(s+w*active[a]._x0);
    }
    const x=gauss(M,r); let worst=-1,wv=0;
    active.forEach((i,a)=>{
      const v=Math.max(i._lo-x[a],x[a]-i._hi);
      if(v>0.01&&v>wv){wv=v;worst=a;}
    });
    if(worst>=0){const i=active[worst];pinned.set(i,x[worst]<i._lo?i._lo:i._hi);active=active.filter(z=>z!==i);continue;}
    sol=x;break;
  }
  const out=new Map();
  free.forEach(i=>out.set(i,i.g));
  if(sol) active.forEach((i,a)=>out.set(i,sol[a]));
  pinned.forEach((v,i)=>out.set(i,v));
  return out;
}
/* opts.protect: a carb-side change – direct protein foods are never moved, calories give way first.
   opts.on: which of calories, protein, carbs, fat to match from the start (default calories and carbs). */
function solve(day,held,opts={}){
  if(!day.auto) return;
  const items=allItems(day);
  const anc=i=>(i.a!=null?i.a:i.g);
  const eaten=new Set();day.meals.forEach(m=>{if(m.eaten)BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>eaten.add(i)));}); /* eaten meals never move */
  const free=items.filter(i=>anc(i)>0&&!i.lock&&!held.has(i)&&!eaten.has(i)&&!isFree(i.f)&&!(opts.protect&&FOODS[i.f].d>0));
  if(!free.length) return;
  const used=(f,except)=>items.filter(i=>i.f===f&&i!==except).reduce((s,i)=>s+i.g,0);
  free.forEach(i=>{
    const F=FOODS[i.f];
    i._lo=Math.max(F.min||0,Math.round(anc(i)*0.25)); /* never cut an item below a quarter of your amount */
    let hi=Math.min(F.max!=null?F.max:3000,Math.max(anc(i)*1.6,anc(i)+40));
    if(F.order!=null) hi=Math.min(hi,Math.max(0,F.order-used(i.f,i)));
    i._hi=Math.max(hi,i._lo); i._x0=anc(i); i.g=anc(i);
  });
  const on=opts.on?opts.on.slice():[1,0,1,0]; let out;
  for(let pass=0;pass<3;pass++){
    out=solveWith(day,items,free,on);
    const t=sum(items.map(i=>macOf(i.f,out.has(i)?out.get(i):i.g)).concat(day.off.map(offMac)));
    let changed=false;
    if(!opts.protect&&!on[1]&&t[pKey()]<(+day.targets.p||0)-3){on[1]=1;changed=true;}
    if(!on[3]&&t.f>(+day.targets.f||0)+0.5){on[3]=1;changed=true;}
    if(!changed)break;
  }
  free.forEach(i=>{const st=FOODS[i.f].step;const g=out.get(i);
    i.g=Math.max(i._lo,Math.min(i._hi,Math.round(g/st)*st));
    delete i._lo;delete i._hi;delete i._x0;});
}
/* Balance inside a meal while it is being edited ('Balance this meal as I edit' on the meal): keep the meal's calories where
   they were before the edit by moving its other foods. Foods you changed or added (i.ed) and locked foods stay put, direct
   protein never moves, and nothing outside the meal is touched. i.g0 keeps where a moved food was, to put it back. */
function balanceMeal(m){
  if(!m._snap)return;
  const items=x=>BOXES.flatMap(([b])=>x[b]||[]);
  const k=sum(items(m._snap).map(i=>macOf(i.f,i.g))).k;
  const held=new Set(items(m).filter(i=>i.ed));
  items(m).forEach(i=>{if(!i.ed&&i.g0==null)i.g0=i.g;});
  solve({auto:true,targets:{k,p:0,c:0,f:1e9},meals:[m],off:[]},held,{protect:true,on:[1,0,0,0]});
  items(m).forEach(i=>{if(i.ed||i.g0===i.g)delete i.g0;});
}
/* Put an amount of a food into a box, overflowing into the next food when a serving cap is hit. */
function placeMatched(box,f,macro,need,held,replace){
  const F=FOODS[f]; let g=F[macro]>0?need/F[macro]*100:0; let rest=0;
  if(F.max!=null&&g>F.max){rest=need-F.max*F[macro]/100;g=F.max;}
  if(F.min!=null&&g>0&&g<F.min)g=F.min;
  g=Math.round(g/F.step)*F.step;
  if(replace){replace.f=f;replace.g=g;replace.a=g;held.add(replace);} else {const n=it(f,g);box.push(n);held.add(n);}
  if(rest>0.5&&F.spill){
    const ex=box.find(i=>i.f===F.spill&&!held.has(i));
    if(ex){const nf=FOODS[F.spill];ex.g=Math.round((ex.g+rest/nf[macro]*100)/nf.step)*nf.step;ex.a=ex.g;held.add(ex);}
    else placeMatched(box,F.spill,macro,rest,held,null);
  }
}

/* ---------- checks ---------- */
function warnings(day){
  const w=[];const items=allItems(day);
  day.meals.forEach(m=>[...m.p,...m.c,...(m.x||[])].forEach(i=>{
    const F=FOODS[i.f];if(!F)return;
    if(F.max!=null&&!F.order&&i.g>F.max+0.1) w.push(i.f==='pudding'?`Meal ${m.id}: rice pudding is ${fmtG(i)} – over ${F.max}g goes past ${CASEIN_MAX}g casein`:`Meal ${m.id}: ${F.n} is ${fmtG(i)} – the limit is ${F.max}${F.unit||'g'} a serving`);
    if(F.min!=null&&i.g>0&&i.g<F.min) w.push(`Meal ${m.id}: ${F.n} is under ${F.min}${F.unit||'g'} – the minimum serving`);
  }));
  /* foods delivered in a set amount a day (daily order) */
  [...new Set(items.map(i=>i.f))].forEach(f=>{const F=FOODS[f];if(!F||F.order==null)return;
    const t=items.filter(i=>i.f===f).reduce((s,i)=>s+i.g,0);
    if(t>F.order+0.1) w.push(`${F.n}: ${Math.round(t)}${F.unit||'g'} today is more than the ${F.order}${F.unit||'g'} daily order`);
  });
  return w;
}
/* Health Road packs hold the meat in the plan plus sauce that isn't: weigh the whole pack and eat the
   same share of it as your share of the meat. g = meat you're having, pack = pack weight, meat = meat in the pack. */
function packPortion(g,pack,meat){return g>0&&pack>0&&meat>0?g/meat*pack:null;}
function fmtG(i){const u=FOODS[i.f].unit||'g';return Math.round(i.g)+u;}

/* for the server (FREE_KINDS) and the tests */
if(typeof module!=='undefined') module.exports={FOODS,FREE_KINDS,packPortion,applyDefaults,balanceMeal,macOf,sum,it};
