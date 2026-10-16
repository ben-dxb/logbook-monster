'use strict';
/* Free TCP ports picked by the OS, synchronously so test files can use them in top-level constants.
   Test files run in parallel; fixed random ranges used to overlap and collide now and then. */
const { execFileSync } = require('node:child_process');

function freePorts(n) {
  const script = `const net=require('net');const s=[];let left=${n};
    for(let i=0;i<${n};i++){const v=net.createServer();s.push(v);v.listen(0,'127.0.0.1',()=>{if(--left===0){
      console.log(s.map(x=>x.address().port).join(','));s.forEach(x=>x.close());}});}`;
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split(',').map(Number);
}

module.exports = { freePorts };
