'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {installRestrictedDirectoryPolicy}=require('../file_picker_permissions');
const trusted=url=>{try{return new URL(url).origin==='https://api.ailinux.me'}catch{return false}};

async function runCase({origin='https://api.ailinux.me',isDirectory=true,response=2,throws=false,window=null}={}){
  const ses=new EventEmitter();
  const calls=[];
  const dlg={async showMessageBox(...args){calls.push(args);if(throws)throw Error('picker unavailable');return {response}}};
  installRestrictedDirectoryPolicy(ses,{isTrustedDocument:trusted,dialog:dlg,getWindow:()=>window});
  const code=await new Promise(resolve=>ses.emit('file-system-access-restricted',{}, {origin,isDirectory,path:'/home/zombie/Downloads'},resolve));
  return {code,calls};
}

test('restrict directory picker to the trusted app origin',async()=>{
  const bad=await runCase({origin:'https://evil.example',response:1});
  assert.equal(bad.code,'deny');assert.equal(bad.calls.length,0);
  const file=await runCase({isDirectory:false,response:1});
  assert.equal(file.code,'deny');assert.equal(file.calls.length,0);
});
test('protected folder picker can retry without locking up',async()=>{
  const result=await runCase({response:0});
  assert.equal(result.code,'tryAgain');
  assert.equal(result.calls.length,1);
  assert.equal(result.calls[0][0].cancelId,2);
  assert.match(result.calls[0][0].detail,/Downloads/);
});
test('protected folder requires explicit user approval',async()=>{
  assert.equal((await runCase({response:1})).code,'allow');
  assert.equal((await runCase({response:2})).code,'deny');
  assert.equal((await runCase({response:99})).code,'deny');
  assert.equal((await runCase({throws:true})).code,'deny');
});
test('dialog is attached to valid Electron parent window',async()=>{
  const parent={isDestroyed:()=>false};
  const out=await runCase({response:1,window:parent});
  assert.equal(out.calls[0][0],parent);
  assert.equal(out.calls[0][1].title,'AILinux Helper - Protected folder');
  const destroyed=await runCase({window:{isDestroyed:()=>true}});
  assert.equal(destroyed.calls[0].length,1);
});
