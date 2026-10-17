'use strict';
/* A small QR code encoder for the two-step set-up link (app.js tfQr): byte mode, error correction level M, versions 1–40,
   the mask with the lowest penalty – as ISO/IEC 18004 has it. QR.matrix(text) → rows of booleans (true = dark);
   QR.svg(text, {label}) → an <svg> string: one path, a white quiet zone of 4 modules, no style attributes (CSP-safe).
   One global, QR; also a CommonJS module for tests. */
const QR=(()=>{
  /* level M: error correction codewords per block and number of blocks, by version (index 0 unused) */
  const ECC=[0,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28];
  const BLOCKS=[0,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49];
  const M_BITS=0;   /* the format bits for level M */
  /* modules left for data and error correction once the fixed patterns are drawn */
  function rawModules(v){let r=(16*v+128)*v+64;if(v>=2){const n=Math.floor(v/7)+2;r-=(25*n-10)*n-55;if(v>=7)r-=36;}return r;}
  const dataCodewords=v=>Math.floor(rawModules(v)/8)-ECC[v]*BLOCKS[v];
  function alignAt(v){if(v===1)return [];const n=Math.floor(v/7)+2,size=v*4+17,step=v===32?26:Math.ceil((v*4+4)/(n*2-2))*2,out=[6];
    for(let p=size-7;out.length<n;p-=step)out.splice(1,0,p);return out;}
  /* GF(256) with x^8+x^4+x^3+x^2+1 */
  function mul(x,y){let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11d);z^=((y>>>i)&1)*x;}return z;}
  function divisor(deg){const r=new Array(deg).fill(0);r[deg-1]=1;let root=1;
    for(let i=0;i<deg;i++){for(let j=0;j<r.length;j++){r[j]=mul(r[j],root);if(j+1<r.length)r[j]^=r[j+1];}root=mul(root,2);}return r;}
  function remainder(data,div){const r=div.map(()=>0);for(const b of data){const f=b^r.shift();r.push(0);div.forEach((c,i)=>{r[i]^=mul(c,f);});}return r;}
  const bit=(x,i)=>((x>>>i)&1)!==0;

  function encode(text){
    const bytes=[...new TextEncoder().encode(String(text))];
    let v=1;for(;v<=40;v++){const cap=dataCodewords(v)*8,len=4+(v<10?8:16)+bytes.length*8;if(len<=cap)break;}
    if(v>40)throw new Error('Too long for a QR code');
    /* the bit stream: mode 0100 (bytes), the count, the bytes, a terminator, then padding to the capacity */
    const bits=[],put=(val,n)=>{for(let i=n-1;i>=0;i--)bits.push((val>>>i)&1);};
    put(4,4);put(bytes.length,v<10?8:16);bytes.forEach(b=>put(b,8));
    const cap=dataCodewords(v)*8;put(0,Math.min(4,cap-bits.length));put(0,(8-bits.length%8)%8);
    for(let p=0xec;bits.length<cap;p^=0xec^0x11)put(p,8);
    const data=[];for(let i=0;i<bits.length;i+=8)data.push(parseInt(bits.slice(i,i+8).join(''),2));
    /* split into blocks, add each block's error correction and interleave */
    const nb=BLOCKS[v],el=ECC[v],raw=Math.floor(rawModules(v)/8),short=nb-raw%nb,shortLen=Math.floor(raw/nb),div=divisor(el),blocks=[];
    for(let i=0,k=0;i<nb;i++){const d=data.slice(k,k+shortLen-el+(i<short?0:1));k+=d.length;const e=remainder(d,div);if(i<short)d.push(0);blocks.push(d.concat(e));}
    const words=[];for(let i=0;i<blocks[0].length;i++)blocks.forEach((b,j)=>{if(i!==shortLen-el||j>=short)words.push(b[i]);});
    return {v,words};
  }
  function build(v,words,mask){
    const size=v*4+17,m=[],fn=[];for(let y=0;y<size;y++){m.push(new Array(size).fill(false));fn.push(new Array(size).fill(false));}
    const set=(x,y,d)=>{m[y][x]=d;fn[y][x]=true;};
    for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0);}
    for(const [cx,cy] of [[3,3],[size-4,3],[3,size-4]])for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){
      const x=cx+dx,y=cy+dy,d=Math.max(Math.abs(dx),Math.abs(dy));if(x>=0&&x<size&&y>=0&&y<size)set(x,y,d!==2&&d!==4);}
    const al=alignAt(v),last=al.length-1;
    al.forEach((ax,i)=>al.forEach((ay,j)=>{if(i===0&&j===0||i===0&&j===last||i===last&&j===0)return;
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(ax+dx,ay+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);}));
    /* format bits (level and mask, BCH-protected), twice, and the dark module */
    const fd=(M_BITS<<3)|mask;let rem=fd;for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);
    const fb=((fd<<10)|rem)^0x5412;
    for(let i=0;i<=5;i++)set(8,i,bit(fb,i));
    set(8,7,bit(fb,6));set(8,8,bit(fb,7));set(7,8,bit(fb,8));
    for(let i=9;i<15;i++)set(14-i,8,bit(fb,i));
    for(let i=0;i<8;i++)set(size-1-i,8,bit(fb,i));
    for(let i=8;i<15;i++)set(8,size-15+i,bit(fb,i));
    set(8,size-8,true);
    if(v>=7){let r=v;for(let i=0;i<12;i++)r=(r<<1)^((r>>>11)*0x1f25);const vb=(v<<12)|r;
      for(let i=0;i<18;i++){const b=bit(vb,i),a=size-11+i%3,c=Math.floor(i/3);set(a,c,b);set(c,a,b);}}
    /* the codewords, in two-module columns zigzagging up and down from the right, skipping the timing column */
    let i=0;
    for(let right=size-1;right>=1;right-=2){if(right===6)right=5;
      for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){const x=right-j,up=((right+1)&2)===0,y=up?size-1-vert:vert;
        if(!fn[y][x]&&i<words.length*8){m[y][x]=bit(words[i>>>3],7-(i&7));i++;}}}
    const flip=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,x=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,
      (x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0][mask];
    for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(!fn[y][x]&&flip(x,y))m[y][x]=!m[y][x];
    return m;
  }
  /* how hard a symbol is to read: long runs, 2×2 blocks, finder-like patterns and an uneven dark/light balance */
  function penalty(m){
    const n=m.length;let p=0,dark=0;
    const lines=[];for(let y=0;y<n;y++){lines.push(m[y]);lines.push(m.map(r=>r[y]));}
    for(const l of lines){
      for(let i=0,run=1;i<n;i++){if(i+1<n&&l[i+1]===l[i])run++;else{if(run>=5)p+=run-2;run=1;}}
      const s=l.map(b=>b?1:0).join('');
      for(const pat of ['10111010000','00001011101'])for(let k=s.indexOf(pat);k>=0;k=s.indexOf(pat,k+1))p+=40;
    }
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){if(m[y][x])dark++;if(x+1<n&&y+1<n){const c=m[y][x];if(m[y][x+1]===c&&m[y+1][x]===c&&m[y+1][x+1]===c)p+=3;}}
    p+=10*Math.floor(Math.abs(dark*20-n*n*10)/(n*n));
    return p;
  }
  function matrix(text){
    const {v,words}=encode(text);let best=null,bp=Infinity;
    for(let k=0;k<8;k++){const m=build(v,words,k),p=penalty(m);if(p<bp){bp=p;best=m;}}
    return best;
  }
  const escAttr=t=>String(t).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  function svg(text,opts={}){
    const m=matrix(text),n=m.length,q=4,w=n+q*2;let d='';
    for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(m[y][x])d+=`M${x+q} ${y+q}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" role="img" aria-label="${escAttr(opts.label||'QR code')}" shape-rendering="crispEdges">`
      +`<rect width="${w}" height="${w}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  return {matrix,svg};
})();
if(typeof module!=='undefined')module.exports=QR;
