'use strict';
/* A coach link (/coach/<secret>): someone's logbook, read only, with no sign-in. The Timeline (timeline.js)
   draws the trend chart and the day cards; this page adds whose logbook it is, when the link runs out and a
   list of recent days. Everything comes from /coach/<secret>/api (server/shares.js), which only answers reads.
   #history/timeline/2026-10-15 opens that day's card, as in the app. */

const SHARED={token:(s=>{try{return decodeURIComponent(s);}catch{return s;}})(location.pathname.split('/')[2]||'')};   /* a garbled link: its API says it doesn't work */
SHARED.base='/coach/'+encodeURIComponent(SHARED.token);

/* ---------- the helpers timeline.js uses from app.js, admin.js, gym.js, photos.js and supps.js ---------- */
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);};
const addDays=(s,n)=>{const d=parse(s);d.setDate(d.getDate()+n);return ymd(d);};
const wdOf=s=>(parse(s).getDay()+6)%7;
const todayStr=()=>ymd(new Date());
/* a real date (not 2026-02-31) from 2000 to a year from today – what the server stores (server/dates.js) */
const lastDate=()=>{const d=new Date();d.setFullYear(d.getFullYear()+1);return ymd(d);};
const isDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&ymd(parse(s))===s&&s>='2000-01-01'&&s<=lastDate();
const fmtLong=s=>parse(s).toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
const fmtShort=s=>parse(s).toLocaleDateString(undefined,{day:'numeric',month:'short'});
const OLD_TYPES={T:'Training',R:'Rest',S:'Saturday training'};   /* day types before templates had names */
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const r0=x=>Math.round(x), r1=x=>(Math.round(x*10)/10).toFixed(1);
const gEmpty=t=>`<p class="empty">${esc(t)}</p>`;   /* plain text, as in gym.js */
const P_NAME={front:'Front',left:'Side – Left',right:'Side – Right',side:'Side',back:'Back',other:'Other'};
const pSrc=p=>`${SHARED.base}/api/photos/${p.id}/file?v=${encodeURIComponent(p.v)}`;
const pThumb=p=>p.tv?`${SHARED.base}/api/photos/${p.id}/thumb?v=${encodeURIComponent(p.tv)}`:pSrc(p);
const P_STYLE={relaxed:'Relaxed',front_relaxed:'Front relaxed',back_relaxed:'Back relaxed',front_double_biceps:'Front double biceps',
  back_double_biceps:'Back double biceps',most_muscular:'Most muscular'};
const pPoseName=p=>P_NAME[p]||p;
const pStyleName=s=>P_STYLE[s]||s;
const pStyleIn=(pose,s)=>s.startsWith(pose+'_')?pStyleName(s).replace(/^\w+ (.)/,(m,c)=>c.toUpperCase()):pStyleName(s);   /* as in photos.js */
const pLabel=p=>pPoseName(p.pose)+(p.style?' · '+pStyleIn(p.pose,p.style):'');
const sNum=n=>String(Math.round(n*1000)/1000);
const sUnitTxt=(u,n)=>/s$/.test(u)&&+n===1?u.slice(0,-1):u;
const sDose=(n,u)=>`${sNum(n)} ${sUnitTxt(u,n)}`;
let view='timeline', DEFS={mine:null,myVersions:[]};
/* the person's own plan changes each apply from a date (as in admin.js) */
function mineOn(date){let v=null;for(const x of DEFS.myVersions||[])if(!x.from||x.from<=date)v=x;return v;}
/* the day template a date's weekday uses, and a template's name, from the plan in effect on that date */
function typeOn(date){const v=mineOn(date),ids=((v&&v.templates)||[]).map(t=>t.id),s=v&&v.schedule,t=Array.isArray(s)?s[wdOf(date)]:null;
  return ids.includes(t)?t:ids[0]||null;}
function tnameOn(date,id){const v=mineOn(date),t=((v&&v.templates)||[]).find(x=>x.id===id);return t?t.name:OLD_TYPES[id]||'';}

/* Reads only, from the link's own API. A link that has run out shows the "doesn't work" panel. */
async function api(method,url){
  if(method!=='GET')throw new Error('This link is read only');
  let r;
  try{r=await fetch(SHARED.base+url,{credentials:'omit'});}catch{throw new Error('Can’t reach the server – try again in a moment.');}
  const j=await r.json().catch(()=>({}));
  if(r.status===404&&j.gone){gone(j.error);const e=new Error(j.error);e.signedOut=true;throw e;}
  if(r.status===404)return null;
  if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);
  return j;
}
function gone(msg){
  $('#c-loading').hidden=true;$('#c-main').hidden=true;$('#c-gone').hidden=false;
  if(msg)$('#c-gonemsg').textContent=msg;
  const dlg=$('#t-card');if(dlg&&dlg.open)dlg.close();
}

function go(hash){if(location.hash==='#'+hash)route();else location.hash=hash;}
function route(){
  const m=/^#history\/timeline(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(location.hash);
  renderTimeline(m&&m[1]?[m[1]]:[]);
}

/* ---------- recent days: food against the targets, and weight ---------- */
let cDays=14, SUMS={}, WTS={};
const cUntil=iso=>new Date(iso).toLocaleString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'});
async function cLoadDays(){
  const to=todayStr(), from=addDays(to,-cDays+1);
  const [sums,wts]=await Promise.all([api('GET',`/api/days?from=${from}&to=${to}`),api('GET',`/api/weights?from=${from}&to=${to}`)]);
  SUMS={};(sums||[]).forEach(s=>{SUMS[s.date]=s;});
  WTS={};(wts||[]).forEach(w=>{WTS[w.date]=w.kg;});
  cRenderDays();
}
function cRenderDays(){
  const to=todayStr();let html='';
  for(let i=0;i<cDays;i++){
    const d=addDays(to,-i), s=SUMS[d], t=(s&&s.targets)||{}, kg=WTS[d];
    const kcal=s?`<b>${r0(s.k)}</b>${t.k?` / ${r0(t.k)}`:''} kcal`:'<span class="sub">Not logged</span>';
    const off=s&&t.k?s.k-t.k:null, dot=off==null?'':Math.abs(off)<=100?'<i class="dot on" title="On target">✓</i>':off>0?'<i class="dot over" title="Over">▲</i>':'<i class="dot under" title="Under">▼</i>';
    const mac=s?`P ${r0(s.p)} · C ${r0(s.c)} · F ${r0(s.f)}`:'';
    html+=`<a class="cday" href="#history/timeline/${d}"><span class="cdd"><b>${esc(parse(d).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'}))}</b><small>${esc((s&&s.tname)||tnameOn(d,(s&&s.type)||typeOn(d)))}</small></span>
      <span class="cdk">${dot}${kcal}</span><span class="cdm sub">${mac}</span><span class="cdw">${kg!=null?`${kg.toFixed(1)} kg`:''}</span></a>`;
  }
  $('#c-days').innerHTML=html;
}

async function start(){
  let info;
  try{info=await api('GET','/api/info');}catch(e){if(!e.signedOut){$('#c-loading').textContent='Couldn’t load this logbook: '+e.message;}return;}
  try{DEFS=(await api('GET','/api/defaults'))||DEFS;}catch{}
  applyDefaults(mineOn(todayStr()));   /* food names and the week as the person has them now */
  document.title=`${info.name} – Logbook Monster`;
  $('#c-who').textContent=`${info.name}’s logbook`;
  $('#c-until').textContent=`${info.label?info.label+' · ':''}Shared with you read only. This link works until ${cUntil(info.expires)}.`;
  $('#c-loading').hidden=true;$('#c-main').hidden=false;
  try{await cLoadDays();}catch(e){if(!e.signedOut)$('#c-days').innerHTML=gEmpty('Couldn’t load the days: '+e.message);}
  route();
}
$('#c-more').addEventListener('click',async()=>{cDays=Math.min(cDays+14,366);$('#c-more').hidden=cDays>=366;try{await cLoadDays();}catch{}});
window.addEventListener('hashchange',route);
document.addEventListener('DOMContentLoaded',start);
