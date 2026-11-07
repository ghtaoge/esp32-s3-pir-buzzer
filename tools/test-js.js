const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const directories=['tests','pc/tests','miniprogram/tests'];
const files=directories.flatMap(directory=>fs.existsSync(path.join(root,directory))
  ? fs.readdirSync(path.join(root,directory)).filter(file=>file.endsWith('.test.js')).map(file=>path.join(root,directory,file)) : []);
if(!files.length)throw new Error('No JavaScript tests found');
const result=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit'});
if(result.error)console.error(result.error.message);
process.exit(result.status===null?1:result.status);
