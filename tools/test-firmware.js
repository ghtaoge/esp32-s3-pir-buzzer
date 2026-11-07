const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const candidates=[process.env.CXX,'g++','C:/msys64/ucrt64/bin/g++.exe','C:/msys64/mingw64/bin/g++.exe','D:/msys64/ucrt64/bin/g++.exe','D:/msys64/mingw64/bin/g++.exe','C:/Users/taoge/.platformio/packages/toolchain-xtensa-esp-elf/bin/xtensa-esp32s3-elf-g++.exe'].filter(Boolean);
// Native tests must use a host compiler, not a cross compiler.
const compiler=candidates.find(candidate=>!candidate.includes('xtensa')&&spawnSync(candidate,['--version'],{encoding:'utf8'}).status===0);
if(!compiler){console.error('A native g++ compiler is required. Set CXX to its path.');process.exit(1);}
const temporary=path.join(root,'.local','compiler-temp');
fs.mkdirSync(temporary,{recursive:true});
const env={...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary};
const jsonCandidates=[process.env.ARDUINOJSON_INCLUDE,path.join(root,'.pio','libdeps','esp32-s3-n16r8','ArduinoJson','src'),path.join(root,'.local','ArduinoJson','src')].filter(Boolean);
const jsonInclude=jsonCandidates.find(directory=>fs.existsSync(path.join(directory,'ArduinoJson.h')));
const tests=fs.readdirSync(path.join(root,'tests')).filter(file=>file.endsWith('_test.cpp'));
if(!tests.length)throw new Error('No firmware tests found');
for(const file of tests){
  const executable=path.join(root,'.local',file.replace('.cpp',process.platform==='win32'?'.exe':''));
  if(file==='config_json_test.cpp'&&!jsonInclude){console.error('ArduinoJson headers are required: run PlatformIO build first, or set ARDUINOJSON_INCLUDE to the ArduinoJson 7.4.2 src directory.');process.exit(1);}
  const includes=['-I',path.join(root,'include'),...(jsonInclude?['-I',jsonInclude]:[])];
  const compiled=spawnSync(compiler,['-std=c++17','-O2','-Wall','-Wextra','-Werror',...includes,path.join(root,'tests',file),'-o',executable],{stdio:'inherit',env});
  if(compiled.status!==0)process.exit(compiled.status||1);
  const run=spawnSync(executable,[],{stdio:'inherit',env});if(run.status!==0)process.exit(run.status||1);
}
