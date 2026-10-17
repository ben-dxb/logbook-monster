'use strict';
/* Reads a workout history CSV exported from Setgraph (or Strong, Hevy and most other trackers) into
   sets for the Gym log: {name, reps, kg, note, at}. Columns are found by their headings, so the
   order doesn't matter. Runs in the browser before anything is sent, and in Node for the tests. */
/* One global, GymCsv, so nothing clashes with the names in app.js and admin.js. */
const GymCsv=(()=>{

/* RFC 4180-ish: quoted fields, "" inside quotes, CRLF or LF, comma / semicolon / tab. */
/* the separator is whichever of them the heading row uses most */
function csvSep(text){
  text=String(text||'').replace(/^﻿/,'');
  const first=text.slice(0,text.search(/\r?\n|$/));
  const count=c=>first.split(c).length;
  return [',',';','\t'].reduce((b,c)=>count(c)>count(b)?c:b,',');
}
function parseCsv(text){
  text=String(text||'').replace(/^﻿/,'');
  const sep=csvSep(text);
  const rows=[];let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){if(ch==='"'){if(text[i+1]==='"'){f+='"';i++;}else q=false;}else f+=ch;}
    else if(ch==='"'&&f==='')q=true;
    else if(ch===sep){row.push(f);f='';}
    else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(f);rows.push(row);row=[];f='';}
    else f+=ch;
  }
  if(f!==''||row.length){row.push(f);rows.push(row);}
  return rows.filter(r=>r.some(c=>c.trim()!==''));
}

/* Headings each field may have, best first. Compared lowercased with everything but letters and digits removed. */
const CSV_COLS={
  exercise:['exercisename','exercise','exercisetitle','exercisetype','movement','lift','name','title'],
  date:['datetime','timestamp','setdate','date','starttime','start','performedat','performed','createdat','created','workoutdate','day'],
  time:['time','settime','clock'],
  reps:['reps','repetitions','rep','repcount','numberofreps'],
  weight:['weightkg','weight','kg','load','weightlbs','weightlb','lbs','lb','resistance'],
  unit:['unit','units','weightunit','unitofmeasure'],
  note:['notes','note','setnotes','setnote','comment','comments'],
  label:['label','labels','tag','tags','settype'],
  order:['setorder','setindex','setnumber','set'],
};
const csvKey=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
const p2=n=>String(n).padStart(2,'0');
const MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
const monthNo=w=>{w=w.toLowerCase();return MONTHS[w.slice(0,4)]||MONTHS[w.slice(0,3)];};

function validDay(y,m,d){return m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate()&&y>=1970&&y<=2200;}
function localOf(dt){return `${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}T${p2(dt.getHours())}:${p2(dt.getMinutes())}:${p2(dt.getSeconds())}`;}
/* "17:43", "17:43:38", "5:43 PM" → [h, m, s] */
function readTime(s){
  const m=/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap])?\.?\s*m?\.?/i.exec(s||'');
  if(!m)return null;
  let h=+m[1];const ap=m[4]&&m[4].toLowerCase();
  if(ap==='p'&&h<12)h+=12;if(ap==='a'&&h===12)h=0;
  if(h>23||+m[2]>59||+(m[3]||0)>59)return null;
  return [h,+m[2],+(m[3]||0)];
}
/* Returns "YYYY-MM-DDTHH:MM:SS" in local time, or null. order is 'dmy' or 'mdy' for 03/04/2026. */
function readWhen(ds,ts,order){
  let s=String(ds||'').trim().replace(/\s+at\s+/i,' ').replace(/,/g,' ').replace(/\s+/g,' ');
  if(!s)return null;
  if(/^\d{9,13}(\.\d+)?$/.test(s)){const n=+s;return localOf(new Date(n<1e11?n*1000:n));}
  let y,mo,d,rest='';
  let m=/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](.*))?$/.exec(s);
  if(m){
    [y,mo,d]=[+m[1],+m[2],+m[3]];rest=m[4]||'';
    if(/(Z|[+-]\d{2}:?\d{2})$/i.test(rest)){const dt=new Date(`${m[1]}-${p2(mo)}-${p2(d)}T${rest.replace(/ /g,'')}`);if(!isNaN(dt))return localOf(dt);}
  }else if((m=/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?: (.*))?$/.exec(s))){
    const [a,b]=[+m[1],+m[2]];[d,mo]=order==='mdy'?[b,a]:[a,b];y=+m[3];if(y<100)y+=2000;rest=m[4]||'';
  }else if((m=/^(?:[a-z]+ )?(\d{1,2}) ([a-z]{3,9})\.? (\d{4})(?: (.*))?$/i.exec(s))&&monthNo(m[2])){
    d=+m[1];mo=monthNo(m[2]);y=+m[3];rest=m[4]||'';
  }else if((m=/^(?:[a-z]+ )?([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})(?: (.*))?$/i.exec(s))&&monthNo(m[1])){
    mo=monthNo(m[1]);d=+m[2];y=+m[3];rest=m[4]||'';
  }else return null;
  if(!validDay(y,mo,d))return null;
  const t=readTime(ts)||readTime(rest)||[12,0,0];
  return `${y}-${p2(mo)}-${p2(d)}T${p2(t[0])}:${p2(t[1])}:${p2(t[2])}`;
}
/* Numbers as exports write them: 12.5 or 12,5 (decimal comma), 1,025 / 1.025 / 1 025 / 1,025.5 / 1.025,5 (thousands), "80 kg".
   A single comma or dot before exactly three digits (1,025) could be either: the decimal mark the file uses elsewhere settles it
   (mark, from decimalMark), else a dot is a decimal point and a comma is left as AMBIGUOUS. Returns a number, null when blank,
   NaN when it isn't a number, or AMBIGUOUS. */
const AMBIGUOUS='ambiguous';
const numText=v=>String(v==null?'':v).trim().replace(/[\s\u00a0\u202f']/g,'').replace(/(kgs?|lbs?|reps?|g|ml)$/i,'');
const grouped=(s,t)=>new RegExp(`^\\d{1,3}(\\${t}\\d{3})+$`).test(s);
/* what one number says about the decimal mark: ',' or '.', or '' if it can't tell */
function markOf(v){
  const s=numText(v).replace(/^[+-]/,'');if(!/^[\d.,]*\d[\d.,]*$/.test(s))return '';
  const c=s.includes(','),d=s.includes('.');
  if(c&&d)return s.lastIndexOf(',')>s.lastIndexOf('.')?',':'.';
  if(!c&&!d)return '';
  const ch=c?',':'.',p=s.split(ch);
  if(p.length>2)return grouped(s,ch)?(ch===','?'.':','):'';
  if(p[1].length!==3||p[0].length>3||/^0/.test(p[0]))return ch;
  return '';
}
/* the decimal mark a set of numbers agree on, or null if none says or they disagree */
function decimalMark(values){const m=new Set(values.map(markOf).filter(Boolean));return m.size===1?[...m][0]:null;}
function readNum(v,mark){
  let s=numText(v);if(!s)return null;
  const neg=/^-/.test(s);s=s.replace(/^[+-]/,'');
  if(!/^[\d.,]*\d[\d.,]*$/.test(s))return NaN;
  const c=s.includes(','),d=s.includes('.');let n;
  if(!c&&!d)n=+s;
  else if(c&&d){const dec=s.lastIndexOf(',')>s.lastIndexOf('.')?',':'.',th=dec===','?'.':',',i=s.lastIndexOf(dec),a=s.slice(0,i),b=s.slice(i+1);
    if(!grouped(a,th)||!/^\d+$/.test(b))return NaN;n=+(a.split(th).join('')+'.'+b);}
  else{const ch=c?',':'.',p=s.split(ch);
    if(p.length>2){if(!grouped(s,ch))return NaN;n=+p.join('');}
    else if(!p[1])n=p[0]?+p[0]:NaN;   /* "10." */
    else{const k=markOf(s)||mark||(ch==='.'?'.':'');
      if(!k)return AMBIGUOUS;
      n=k===ch?+((p[0]||'0')+'.'+p[1]):grouped(s,ch)?+p.join(''):NaN;}}
  return Number.isFinite(n)?(neg?-n:n):NaN;
}

/* opts: {dateOrder:'dmy'|'mdy', unit:'kg'|'lb'} – only used where the file itself doesn't say. */
function readHistory(text,opts={}){
  const rows=parseCsv(text);
  if(rows.length<2)throw new Error('That file has no rows to read.');
  const head=rows[0].map(csvKey), col={}, used=new Set();
  for(const [k,names] of Object.entries(CSV_COLS)){
    for(const n of names){const i=head.indexOf(n);if(i>=0&&!used.has(i)){col[k]=i;used.add(i);break;}}
  }
  const missing=['exercise','date','reps'].filter(k=>col[k]==null);
  if(missing.length)throw new Error(`Couldn’t find the ${missing.join(', ')} column${missing.length>1?'s':''}. The first row should be headings such as Exercise, Date, Reps, Weight.`);
  const cell=(r,k)=>col[k]==null?'':String(r[col[k]]==null?'':r[col[k]]).trim();
  const body=rows.slice(1);
  /* 03/04/2026: day or month first? Any part above 12 settles it. */
  let order=opts.dateOrder||null, orderFound=false, ambiguous=false;
  for(const r of body){const m=/^\s*(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(cell(r,'date'));if(!m)continue;
    if(+m[1]>12){order='dmy';orderFound=true;break;}if(+m[2]>12){order='mdy';orderFound=true;break;}ambiguous=true;}
  if(!order)order='dmy';
  const weightKey=col.weight==null?'':head[col.weight];
  const unitFromHead=/lb/.test(weightKey)?'lb':/kg/.test(weightKey)?'kg':null;
  const unit=unitFromHead||opts.unit||'kg';
  let unitSeen=!!unitFromHead;
  /* the file's decimal mark, from its own numbers; a comma-separated file can't use bare decimal commas, so there a lone 1,025 is 1025 */
  const sep=csvSep(text), mark=decimalMark(body.flatMap(r=>[cell(r,'weight'),cell(r,'reps')]))||(sep===','?'.':null);
  const numWhy=(what,v,n)=>n===AMBIGUOUS?`${what} “${v}” could be ${v.replace(/[,.]/,'')} or ${v.replace(',','.')} – write it without the separator`:`${what} “${v}” isn’t a number`;
  const sets=[], skipped=[];
  body.forEach((r,ri)=>{
    const line=ri+2, name=cell(r,'exercise').replace(/\s+/g,' ').slice(0,80);
    if(!name){skipped.push({line,why:'no exercise name'});return;}
    const at=readWhen(cell(r,'date'),cell(r,'time'),order);
    if(!at){skipped.push({line,why:`date “${cell(r,'date').slice(0,30)}” not understood`});return;}
    const reps=readNum(cell(r,'reps'),mark);
    if(reps==null){skipped.push({line,why:`${name}: no reps (a timed or cardio set?)`});return;}
    if(!Number.isFinite(reps)){skipped.push({line,why:`${name}: ${numWhy('reps',cell(r,'reps'),reps)}`});return;}
    if(reps<0||reps>1000){skipped.push({line,why:`${name}: reps “${cell(r,'reps')}” should be from 0 to 1000`});return;}
    let kg=readNum(cell(r,'weight'),mark);
    if(kg==null)kg=0;
    if(!Number.isFinite(kg)){skipped.push({line,why:`${name}: ${numWhy('weight',cell(r,'weight'),kg)}`});return;}
    const u=cell(r,'unit').toLowerCase();
    if(u)unitSeen=true;
    /* kg, lb or stone; a unit the file names that isn't one of them leaves the row out rather than guessing kg */
    const per=!u?(unit==='lb'?0.45359237:1):/lb|pound/.test(u)?0.45359237:/kg|kilo/.test(u)?1:/^st(one)?s?$/.test(u)?6.35029318:null;
    if(per==null){skipped.push({line,why:`${name}: weight unit “${u.slice(0,12)}” not understood (kg, lb or st)`});return;}
    kg*=per;
    kg=Math.round(kg*100)/100;
    if(kg<-500||kg>2000){skipped.push({line,why:`${name}: weight out of range`});return;}
    const label=/^(normal|working|work)$/i.test(cell(r,'label'))?'':cell(r,'label');
    const note=[label,cell(r,'note')].filter(Boolean).join(' · ').replace(/\s+/g,' ').slice(0,300);
    const ord=readNum(cell(r,'order'),mark);
    sets.push({name,reps:Math.round(reps),kg,note,at,_o:Number.isFinite(ord)?ord:0,_i:ri});
  });
  /* oldest first; sets done at the same moment keep the file's set order */
  sets.sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:a.name.toLowerCase()<b.name.toLowerCase()?-1:a.name.toLowerCase()>b.name.toLowerCase()?1:(a._o-b._o)||(a._i-b._i));
  sets.forEach(s=>{delete s._o;delete s._i;});
  const names=[...new Map(sets.map(s=>[s.name.toLowerCase(),s.name])).values()];
  return {sets,skipped,names,columns:Object.fromEntries(Object.entries(col).map(([k,i])=>[k,rows[0][i]])),
    dateOrder:order,dateOrderAsk:ambiguous&&!orderFound,unit,unitAsk:!unitSeen&&col.weight!=null,
    noTime:col.time==null&&sets.length>0&&sets.every(s=>s.at.endsWith('T12:00:00')),
    from:sets.length?sets[0].at.slice(0,10):null,to:sets.length?sets[sets.length-1].at.slice(0,10):null};
}

/* Batches for the server: under ~200 kB and 2000 sets each (it takes 300 kB and 3000 sets), never
   splitting sets that share a time and exercise (the server compares those as a group to skip ones
   already imported). */
function importBatches(sets,max=200000,maxSets=2000){
  const out=[];let cur=[],size=0;
  const enc=new TextEncoder();   /* the server's limit is in bytes: Arabic or emoji take 2–4 each */
  sets.forEach((s,i)=>{const n=enc.encode(JSON.stringify(s)).length+1,prev=sets[i-1];
    const same=prev&&prev.at===s.at&&prev.name.toLowerCase()===s.name.toLowerCase();
    if(cur.length&&(size+n>max||cur.length>=maxSets)&&!same){out.push(cur);cur=[];size=0;}
    cur.push(s);size+=n;});
  if(cur.length)out.push(cur);
  return out;
}

return {parseCsv,csvSep,readWhen,readNum,decimalMark,AMBIGUOUS,readHistory,importBatches};
})();
if(typeof module!=='undefined')module.exports=GymCsv;
