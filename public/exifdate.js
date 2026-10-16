'use strict';
/* The date a picture was taken, from its own data: the EXIF DateTimeOriginal (else DateTimeDigitized, else DateTime)
   that cameras and phones write into JPEG, HEIC, WebP and PNG files, or failing that an XMP creation date.
   Only the start of the file is read (EXIF sits near the front), and the date is the camera's local date as written,
   with no time zone shift. One global, ExifDate, also used by tests. */
const ExifDate=(()=>{
const HEAD=512*1024;                                     /* bytes read from the start of each file */
const TAGS={0x9003:3,0x9004:2,0x0132:1};                 /* DateTimeOriginal beats DateTimeDigitized beats DateTime */

/* 'YYYY:MM:DD HH:MM:SS' (or with - or /) → 'YYYY-MM-DD' when it is a real date */
function day(s){
  const m=/^\s*(\d{4})[:\-/](\d{2})[:\-/](\d{2})/.exec(s||'');if(!m)return null;
  const d=`${m[1]}-${m[2]}-${m[3]}`, t=new Date(d+'T00:00:00Z');
  return !isNaN(t)&&t.toISOString().startsWith(d)&&+m[1]>=1900?d:null;
}

/* a TIFF block (the body of EXIF) starting at off: the best of the date tags in IFD0 and the Exif IFD */
function readTiff(b,off){
  if(off+8>b.length)return null;
  const le=b[off]===0x49&&b[off+1]===0x49, be=b[off]===0x4d&&b[off+1]===0x4d;if(!le&&!be)return null;
  const u16=p=>p+2>b.length?-1:le?b[p]|b[p+1]<<8:b[p]<<8|b[p+1];
  const u32=p=>p+4>b.length?-1:le?(b[p]|b[p+1]<<8|b[p+2]<<16)+b[p+3]*16777216:b[p]*16777216+(b[p+1]<<16|b[p+2]<<8|b[p+3]);
  if(u16(off+2)!==42)return null;
  let best=null,rank=0;const seen=new Set();
  const ifd=rel=>{
    if(rel<8||seen.has(rel))return;seen.add(rel);
    const p=off+rel, n=u16(p);if(n<0||n>500)return;
    for(let i=0;i<n;i++){
      const e=p+2+i*12, tag=u16(e), type=u16(e+2), count=u32(e+4);if(tag<0||count<0)return;
      if(tag===0x8769){ifd(u32(e+8));continue;}                     /* the Exif IFD */
      if(type===2&&TAGS[tag]>rank&&count>=10&&count<=64){
        const at=count<=4?e+8:off+u32(e+8);if(at+count>b.length)continue;
        let s='';for(let k=0;k<count&&b[at+k];k++)s+=String.fromCharCode(b[at+k]);
        const d=day(s);if(d){best=d;rank=TAGS[tag];}
      }
    }
  };
  ifd(u32(off+4));
  return best;
}

const at=(b,i,s)=>{for(let k=0;k<s.length;k++)if(b[i+k]!==s.charCodeAt(k))return false;return true;};

/* the date in a file's first bytes (a Uint8Array or Buffer), or null */
function fromBytes(b){
  if(!b||!b.length)return null;
  for(let i=0;i+14<b.length;i++){
    /* "Exif\0\0" then TIFF (JPEG APP1, HEIC, WebP), or a PNG eXIf chunk, whose body is TIFF */
    if(b[i]===0x45&&at(b,i,'Exif\0\0')){const d=readTiff(b,i+6);if(d)return d;}
    else if(b[i]===0x65&&at(b,i,'eXIf')){const d=readTiff(b,i+4);if(d)return d;}
  }
  /* XMP, written by editors and some phones */
  let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(b.length,i+8192)));
  const m=/(?:exif:DateTimeOriginal|photoshop:DateCreated|xmp:CreateDate)\s*(?:=\s*["']|>)\s*(\d{4}-\d{2}-\d{2})/.exec(s);
  return m?day(m[1]):null;
}

/* the date a File was taken, or null */
async function ofFile(file){
  try{return fromBytes(new Uint8Array(await file.slice(0,HEAD).arrayBuffer()));}catch{return null;}
}

return {fromBytes,ofFile,day};
})();
if(typeof module!=='undefined')module.exports=ExifDate;
