/* Inspect only the files being published, never print potential secret values. */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const files = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden = /(^|\/)(\.env(?:\..*)?|node_modules|\.pio|\.local|output|project\.private\.config\.json|project\.(?:config\.)?local\.config\.json)(\/|$)|\.(?:pem|key|p12|pfx|bin|elf)$/i;
const secretPatterns = [/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{40,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bAKIA[A-Z0-9]{16}\b/,/\b(?:sk-proj-|sk-)[A-Za-z0-9_-]{30,}/];
const failures=[];
for(const file of [...new Set(files)]) {
  if(forbidden.test(file)&&!file.endsWith('.env.example')) {failures.push(file+': private/generated path');continue;}
  const absolute=path.join(root,file);
  if(!fs.existsSync(absolute)||!fs.statSync(absolute).isFile())continue;
  if(fs.statSync(absolute).size>2*1024*1024) {failures.push(file+': unexpectedly large file');continue;}
  const source=fs.readFileSync(absolute,'utf8');
  if(secretPatterns.some(pattern=>pattern.test(source))) failures.push(file+': possible secret');
  if(file.endsWith('project.config.json')) {
    try {const config=JSON.parse(source);if(config.appid&&config.appid!=='touristappid')failures.push(file+': real AppID must remain local');}
    catch(_){failures.push(file+': invalid JSON');}
  }
}
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log('PASS: public-source scan ('+[...new Set(files)].length+' files; secrets/private configs/build output excluded)');
