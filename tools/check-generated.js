const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),target=path.join(root,'arduino','pir_buzzer');
const read=file=>fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
assert.equal(read(path.join(target,'sentinel_firmware.cpp')),read(path.join(root,'src','main.cpp')),'Arduino firmware is stale; run node tools/prepare-arduino.js');
for(const file of fs.readdirSync(path.join(root,'include')).filter(name=>name.endsWith('.h')))
  assert.equal(read(path.join(target,file)),read(path.join(root,'include',file)),'Arduino header is stale: '+file);
assert(fs.existsSync(path.join(target,'pir_buzzer.ino')),'Missing Arduino entry sketch');
console.log('PASS: Arduino folder contains the current firmware and every project header');
