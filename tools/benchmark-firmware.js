const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),temporary=path.join(root,'.local','compiler-temp');
fs.mkdirSync(temporary,{recursive:true});
const env={...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary};
const binary=path.join(root,'.local','core-benchmark'+(process.platform==='win32'?'.exe':''));
for(const [command,args] of [[process.env.CXX||'g++',['-std=c++17','-O2','-Wall','-Wextra','-Werror','-I',path.join(root,'include'),path.join(root,'tools','benchmark-core.cpp'),'-o',binary]],[binary,[]]]){
  const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit'});
  if(result.error)console.error(result.error.message);
  if(result.status!==0)process.exit(result.status||1);
}
