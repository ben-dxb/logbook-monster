'use strict';
/* Meal plan data and the balancing maths, carried over unchanged from the original calculator.
   Uses the global S (state) for the rice pudding batch and snack overrides. */

/* ---------- food data, per 100g (or 100ml for almond milk) ---------- */
const FOODS = {
  chicken:  {n:'Health Road chicken breast', k:171, p:31,   c:4,    f:3.4, d:31,   step:5, cat:'p', order:250},
  mince:    {n:'Health Road breast mince',   k:165, p:31.5, c:2,    f:3.4, d:31.5, step:5, cat:'p', order:250},
  livers:   {n:'Chicken livers (raw)',       k:119, p:16.9, c:0.7,  f:4.8, d:16.9, step:5, cat:'p', max:175},
  rawmince: {n:'Chicken breast mince (raw)', k:116, p:23.3, c:0,    f:2.5, d:23.3, step:5, cat:'p'},
  egg:      {n:'Egg (50g each)',             k:143, p:12.6, c:0.6,  f:9.6, d:12.6, step:50,cat:'p'},
  whites:   {n:'Egg whites',                 k:52,  p:10.9, c:0.7,  f:0.2, d:10.9, step:5, cat:'p'},
  cheese:   {n:'Cathedral City Lighter',     k:310, p:29.1, c:0.1,  f:21.5,d:29.1, step:5, cat:'p'},
  whey:     {n:'Amix whey isolate',          k:371, p:87.1, c:2,    f:1.1, d:87.1, step:1, cat:'p'},
  passata:  {n:'Passata',                    k:31,  p:1.5,  c:6,    f:0.1, d:0,    step:5, cat:'p'},
  paste:    {n:'Tomato paste',               k:82,  p:4.3,  c:15,   f:0.5, d:0,    step:5, cat:'p'},
  potato:   {n:'Boiled potatoes (Health Road)', k:77, p:1.8, c:17,  f:0.1, d:0,    step:5, cat:'c', order:400},
  pasta:    {n:'Pasta (Health Road, cooked)', k:158, p:5.8, c:30.9, f:0.9, d:0,    step:5, cat:'c', order:300},
  dates:    {n:'Dates',                      k:280, p:2.5,  c:75,   f:0.4, d:0,    step:1, cat:'c', max:45, spill:'syrup'},
  pudding:  {n:'Rice pudding (batch)',       k:0,   p:0,    c:0,    f:0,   d:0,    step:5, cat:'c', max:285, spill:'dates'},
  bakedpot: {n:'Potato, raw (baked at home)', k:77, p:1.8,  c:17,   f:0.1, d:0,    step:5, cat:'c'},
  sour:     {n:'Sourdough',                  k:270, p:10.8, c:51.9, f:2.4, d:0,    step:5, cat:'c'},
  cor:      {n:'Cream of rice (dry)',        k:360, p:6.5,  c:80,   f:1,   d:0,    step:5, cat:'c'},
  banana:   {n:'Banana (peeled)',            k:89,  p:1.1,  c:23,   f:0.3, d:0,    step:5, cat:'c'},
  coco:     {n:'Coco Pops',                  k:386, p:6.3,  c:84,   f:1.9, d:0,    step:5, cat:'c'},
  almond:   {n:'Alpro unsweetened almond',   k:13,  p:0.4,  c:0,    f:1.1, d:0,    step:10,cat:'c', unit:'ml'},
  syrup:    {n:'Date syrup',                 k:300, p:1,    c:74,   f:0.1, d:0,    step:1, cat:'c'},
  jam:      {n:'Strawberry jam',             k:242, p:0.4,  c:60,   f:0.1, d:0,    step:1, cat:'c'},
  biscoff:  {n:'Biscoff spread',             k:570, p:3,    c:57.3, f:38,  d:0,    step:1, cat:'c'},
  malties:  {n:'Malties hazelnut spread',    k:523, p:5.5,  c:59.6, f:28.5,d:0,    step:1, cat:'c'},
  digest:   {n:'Digestive biscuits',         k:478, p:7.1,  c:62.6, f:20.9,d:0,    step:1, cat:'c'},
  lurpak:   {n:'Lurpak Lighter',             k:516, p:0.3,  c:0.4,  f:57,  d:0,    step:1, cat:'c', max:15},
  avocado:  {n:'Avocado',                    k:160, p:2,    c:1.8,  f:14.7,d:0,    step:5, cat:'c', min:100},
};
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
const PROTEIN_SWAPS=['chicken','mince','livers','rawmince','egg','whites','cheese','whey'];
const CARB_SWAPS=['potato','pasta','dates','pudding','bakedpot','sour','cor','banana','coco','syrup','jam'];
const FAT_SWAPS=['lurpak','avocado','biscoff','malties'];
const BOXES=[['p','Protein'],['c','Carbs'],['x','Additional fats']];
const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const TYPE=['T','T','R','T','R','S','R'];
const SAUCE=['BBQ','Piri-piri','Curry','BBQ','Piri-piri','Curry','BBQ'];
const PIE_TARGETS={k:2980,p:250,c:360,f:60};
const COACH={T:{k:2980,p:250,c:360,f:60},S:{k:2980,p:250,c:360,f:60},R:{k:2740,p:250,c:300,f:60}};
const MAC=['k','p','c','f'];

/* ---------- the plan (d = weekday, 0 = Monday) ---------- */
const it=(f,g,lock=false)=>({f,g,lock,a:g}); /* a = the amount you chose (plan or your own edit); rebalancing always starts from it */
function breakfast(kind,lurpak,noCheese){
  const c=[it('sour',120,true)]; if(lurpak) c.push(it('lurpak',lurpak,false));
  if(kind==='eggs'){const p=[it('egg',50,true),it('whites',300,true)];if(!noCheese)p.push(it('cheese',30,true));
    return {id:'1',name:'Breakfast – egg & egg white on sourdough'+(noCheese?' (no cheese)':''),p,c};}
  const p=[it('rawmince',150,true),it('egg',50,true)];if(!noCheese)p.push(it('cheese',30,true));
  return {id:'1',name:'Breakfast – chicken mince omelette'+(noCheese?' (no cheese)':''),p,c};
}
/* spreads, Lurpak and avocado live in their own 'Additional fats' box */
function withFats(meals){return meals.map(m=>{const x=[...(m.x||[]),...m.c.filter(i=>FAT_SWAPS.includes(i.f))];return {...m,c:m.c.filter(i=>!FAT_SWAPS.includes(i.f)),x};});}
function planFor(d,bf,pie){return withFats(CUSTOM_PLAN&&CUSTOM_PLAN[TYPE[d]]?customPlan(TYPE[d]):planForRaw(d,bf,pie));}
function planForRaw(d,bf,pie){return builtinPlan(TYPE[d],SAUCE[d],bf,pie);}
function builtinPlan(t,sauce,bf,pie){
  const hrc=(g,pg)=>({id:'2',name:'Health Road chicken – '+sauce,p:[it('chicken',g)],c:[it('potato',pg)]});
  const hrm=(g,pg)=>({id:'4',name:'Health Road mince',p:[it('mince',g)],c:[it('pasta',pg)]});
  const cor=()=>({id:'3',name:'Cream of rice bowl',p:[],c:[it('cor',80),it('banana',100),it('biscoff',17)]});
  const m5=(w=30)=>({id:'5',name:'Coco Pops protein bowl',note:'Swap the Coco Pops to rice pudding if you like',p:[it('whey',w)],c:[it('coco',70),it('almond',300)]});
  if(t==='T') return [breakfast(bf,15),hrc(230,300),cor(),hrm(220,250),m5()];
  if(t==='S'){
    if(pie) return [breakfast(bf,0),hrc(210,300),
      {id:'3',name:'Lemon meringue cream of rice pie',note:'Recipe items are locked',p:[],c:[it('digest',75,true),it('banana',40,true),it('almond',20,true),it('cor',50,true),it('whites',66,true)]},
      hrm(180,250),m5()];
    return [breakfast(bf,15),hrc(230,300),cor(),hrm(200,250),m5()];
  }
  return [breakfast(bf,15),hrc(185,200),
    {id:'3',name:'Chicken livers (cook fresh)',note:'Livers capped at 175g raw',p:[it('livers',175,true),it('passata',200,true),it('paste',25,true)],c:[it('bakedpot',300)]},
    hrm(190,170),m5(25)];  /* 25g whey keeps rest-day direct protein inside 220g */
}
const clone=o=>JSON.parse(JSON.stringify(o));

/* ---------- admin defaults: food values, week schedule, targets and an uploaded plan ----------
   The built-in values above are the fallback; applyDefaults() layers the admin's saved defaults on top. */
let CUSTOM_PLAN=null;                       /* {T:[meals],R:[meals],S:[meals]} or null for the built-in plan */
const BUILTIN={foods:clone(FOODS),type:[...TYPE],coach:clone(COACH),
  swaps:{p:[...PROTEIN_SWAPS],c:[...CARB_SWAPS],x:[...FAT_SWAPS]}};
const SWAP_LISTS={p:PROTEIN_SWAPS,c:CARB_SWAPS,x:FAT_SWAPS};
const FOOD_FIELDS=['n','k','p','c','f','d','step','unit','min','max','order','group'];
function builtinGroup(id){for(const g in BUILTIN.swaps)if(BUILTIN.swaps[g].includes(id))return g;return '';}
/* the editable view of a food: built-in fields plus which swap list it belongs to */
function foodRecord(id){const F=FOODS[id];const r={group:foodGroup(id)};
  FOOD_FIELDS.forEach(k=>{if(k!=='group')r[k]=F[k]!=null?F[k]:(k==='unit'?'g':null);});return r;}
function foodGroup(id){for(const g in SWAP_LISTS)if(SWAP_LISTS[g].includes(id))return g;return '';}
function applyDefaults(cfg){
  cfg=cfg||{};
  for(const id in FOODS) if(!BUILTIN.foods[id]) delete FOODS[id];
  for(const id in BUILTIN.foods) FOODS[id]=clone(BUILTIN.foods[id]);
  const groups={p:[...BUILTIN.swaps.p],c:[...BUILTIN.swaps.c],x:[...BUILTIN.swaps.x]};
  for(const [id,r] of Object.entries(cfg.foods||{})){
    const F=FOODS[id]||(FOODS[id]={cat:r.group==='p'?'p':'c'});
    ['n','k','p','c','f','d','step'].forEach(k=>{if(r[k]!=null)F[k]=r[k];});
    ['min','max','order'].forEach(k=>{if(r[k]!=null)F[k]=r[k];else delete F[k];});
    if(r.unit==='ml')F.unit='ml';else delete F.unit;
    if(r.group!=null){for(const g in groups)groups[g]=groups[g].filter(x=>x!==id);if(groups[r.group])groups[r.group].push(id);}
  }
  for(const g in SWAP_LISTS)SWAP_LISTS[g].splice(0,SWAP_LISTS[g].length,...groups[g]);
  const sch=Array.isArray(cfg.schedule)&&cfg.schedule.length===7?cfg.schedule:BUILTIN.type;
  TYPE.splice(0,7,...sch);
  for(const t in BUILTIN.coach) COACH[t]={...BUILTIN.coach[t],...((cfg.targets||{})[t]||{})};
  CUSTOM_PLAN=cfg.plan||null;
  if(typeof recalcPudding==='function'&&typeof S!=='undefined')recalcPudding();
}
/* meals of an uploaded plan for one day type; foods that no longer exist are left out */
function customPlan(t){
  return CUSTOM_PLAN[t].map(m=>{const o={id:String(m.id),name:m.name,p:[],c:[],x:[]};if(m.note)o.note=m.note;
    ['p','c','x'].forEach(b=>(m[b]||[]).forEach(i=>{if(FOODS[i.f])o[b].push(it(i.f,+i.g||0,!!i.lock));}));return o;});
}
/* the plan in use for each day type, as plain data (what the admin page shows and downloads) */
function planData(){
  const out={};
  ['T','R','S'].forEach(t=>{
    let meals;
    if(CUSTOM_PLAN&&CUSTOM_PLAN[t]) meals=withFats(customPlan(t));
    else{const d=BUILTIN.type.indexOf(t);meals=withFats(builtinPlan(t,SAUCE[d<0?0:d],'omelette',false));}
    out[t]=meals.map(m=>({id:m.id,name:m.name,...(m.note?{note:m.note}:{}),
      ...Object.fromEntries(['p','c','x'].map(b=>[b,(m[b]||[]).map(i=>({f:i.f,g:i.g,lock:!!i.lock}))]))}));
  });
  return out;
}

function freshDay(d){
  const meals=planFor(d,'omelette',false);
  const D={bf:'omelette',pie:false,auto:true,targets:{...COACH[TYPE[d]]},meals,base:null,off:[]};
  solve(D,new Set(),{protect:true}); /* fit the plan around the pudding batch without touching direct protein */
  allItems(D).forEach(i=>{i.a=i.g;});
  D.base=clone(D.meals);
  return D;
}

/* ---------- maths ---------- */
function macOf(f,g){const F=FOODS[f];return {k:F.k*g/100,p:F.p*g/100,c:F.c*g/100,f:F.f*g/100,d:F.d*g/100};}
function sum(list){const t={k:0,p:0,c:0,f:0,d:0};list.forEach(x=>{for(const m in t)t[m]+=x[m]||0});return t;}
function allItems(day){const a=[];day.meals.forEach(m=>BOXES.forEach(([b])=>(m[b]||[]).forEach(i=>a.push(i))));return a;}
function dayTotals(day){return sum(allItems(day).map(i=>macOf(i.f,i.g)).concat(day.off.map(o=>({k:+o.k||0,p:+o.p||0,c:+o.c||0,f:+o.f||0,d:0}))));}

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
/* Move the unlocked amounts as little as possible (in % terms) while hitting the day targets.
   Calories and carbs are matched; protein is only pulled up if it falls short; fat only pulled down if it goes over. */
function solveWith(day,items,free,on){
  const tgt=MAC.map(m=>+day.targets[m]||0);
  const cw=[0.01,0.1,0.3,0.05].map((x,j)=>on[j]?x:0);
  let active=free.slice(); const pinned=new Map(); let sol=null;
  for(let iter=0;iter<25&&active.length;iter++){
    const fixed=sum(items.filter(i=>!active.includes(i)).map(i=>macOf(i.f,pinned.has(i)?pinned.get(i):i.g))
      .concat(day.off.map(o=>({k:+o.k||0,p:+o.p||0,c:+o.c||0,f:+o.f||0}))));
    const b=MAC.map((m,j)=>tgt[j]-fixed[m]);
    const A=MAC.map(m=>active.map(i=>FOODS[i.f][m]/100));
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
/* opts.protect: a carb-side change – direct protein foods are never moved, calories give way first */
function solve(day,held,opts={}){
  if(!day.auto) return;
  const items=allItems(day);
  const anc=i=>(i.a!=null?i.a:i.g);
  const free=items.filter(i=>anc(i)>0&&!i.lock&&!held.has(i)&&!(opts.protect&&FOODS[i.f].d>0));
  if(!free.length) return;
  const used=(f,except)=>items.filter(i=>i.f===f&&i!==except).reduce((s,i)=>s+i.g,0);
  free.forEach(i=>{
    const F=FOODS[i.f];
    i._lo=Math.max(F.min||0,Math.round(anc(i)*0.25)); /* never cut an item below a quarter of your amount */
    let hi=Math.min(F.max!=null?F.max:3000,Math.max(anc(i)*1.6,anc(i)+40));
    if(F.order!=null) hi=Math.min(hi,Math.max(0,F.order-used(i.f,i)));
    i._hi=Math.max(hi,i._lo); i._x0=anc(i); i.g=anc(i);
  });
  const on=[1,0,1,0]; let out;
  for(let pass=0;pass<3;pass++){
    out=solveWith(day,items,free,on);
    const t=sum(items.map(i=>macOf(i.f,out.has(i)?out.get(i):i.g)).concat(day.off.map(o=>({k:+o.k||0,p:+o.p||0,c:+o.c||0,f:+o.f||0}))));
    let changed=false;
    if(!opts.protect&&!on[1]&&t.p<(+day.targets.p||0)-3){on[1]=1;changed=true;}
    if(!on[3]&&t.f>(+day.targets.f||0)+0.5){on[3]=1;changed=true;}
    if(!changed)break;
  }
  free.forEach(i=>{const st=FOODS[i.f].step;const g=out.get(i);
    i.g=Math.max(i._lo,Math.min(i._hi,Math.round(g/st)*st));
    delete i._lo;delete i._hi;delete i._x0;});
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
    const F=FOODS[i.f];
    if(F.max!=null&&!F.order&&i.g>F.max+0.1&&!(m.pie&&i.f==='lurpak')) w.push(i.f==='pudding'?`Meal ${m.id}: rice pudding is ${fmtG(i)} – over ${F.max}g goes past ${CASEIN_MAX}g casein`:`Meal ${m.id}: ${F.n} is ${fmtG(i)} – the limit is ${F.max}g a serving`);
    if(F.min!=null&&i.g>0&&i.g<F.min) w.push(`Meal ${m.id}: avocado under ${F.min}g – the rest of it goes in the bin`);
  }));
  ['chicken','mince','potato','pasta'].forEach(f=>{
    const t=items.filter(i=>i.f===f).reduce((s,i)=>s+i.g,0);
    if(t>FOODS[f].order+0.1) w.push(`${FOODS[f].n}: ${Math.round(t)}g today is more than the ${FOODS[f].order}g Health Road sends`);
  });
  const lv=items.filter(i=>i.f==='livers').reduce((s,i)=>s+i.g,0);
  if(lv>175) w.push(`Livers: ${lv}g – keep to 175g raw (vitamin A)`);
  return w;
}
function fmtG(i){const u=FOODS[i.f].unit||'g';return Math.round(i.g)+u;}

/* lets the server check food ids against the same data */
if(typeof module!=='undefined') module.exports={FOODS,TYPE,COACH};
