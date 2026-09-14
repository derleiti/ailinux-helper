'use strict';
let pyodide=null;
const INDEX='/v1/mcp/pyodide/v314.0.6/';
self.onmessage=async(e)=>{const m=e.data||{};try{if(m.type==='init'){if(!pyodide){importScripts(INDEX+'pyodide.js');pyodide=await loadPyodide({indexURL:INDEX,stdout:(x)=>self.postMessage({type:'stdout',text:String(x)}),stderr:(x)=>self.postMessage({type:'stderr',text:String(x)})});}self.postMessage({type:'ready',version:pyodide.version});return;}if(m.type==='run'){if(!pyodide)throw new Error('Python runtime is not initialized');const value=await pyodide.runPythonAsync(String(m.code||''));self.postMessage({type:'result',id:m.id,value:value==null?'':String(value)});}}catch(err){self.postMessage({type:'error',id:m.id||0,error:String(err&&err.stack||err)})}};
