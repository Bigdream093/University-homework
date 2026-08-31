import test from 'node:test';
import assert from 'node:assert/strict';
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),clear:()=>map.clear(),values:()=>[...map.values()]};};
globalThis.localStorage=storage();globalThis.sessionStorage=storage();
localStorage.setItem('hw_user',JSON.stringify({id:77,role:'student'}));
const {default:api}=await import('../../web/src/api/request.js');
const {useUpload}=await import('../../web/src/composables/useUpload.js');
test('upload retries query persisted results before resending; payload is not kept as plaintext',async()=>{
 const transfer=useUpload();let uploads=0,queries=0,serverSaved=false;
 const originalRequest=api.request,originalGet=api.get;
 api.request=async config=>{uploads++;assert.equal(config.timeout,0);config.onUploadProgress({loaded:5,total:5});assert.equal(transfer.state.value,'正在保存，请勿重复提交');serverSaved=true;throw new Error('response lost');};
 api.get=async()=>{queries++;if(queries===1)throw new Error('network unavailable');return {data:{state:'succeeded',result:{id:1,receipt_no:'test-receipt'}}};};
 try{
 const args={url:'/assignments/1/submit',statusUrl:'/assignments/1/upload-status/',fields:{content:'sensitive answer'}};
 await assert.rejects(transfer.run(args),/response lost/);
 assert.equal(serverSaved,true);assert.ok(!sessionStorage.values().join().includes('sensitive answer'));
 const result=await transfer.run(args);assert.equal(result.receipt_no,'test-receipt');assert.equal(uploads,1);assert.equal(transfer.pending.value,false);
 }finally{api.request=originalRequest;api.get=originalGet;sessionStorage.clear();}
});
test('cancelled wait queries completion; current upload is protected from double click',async()=>{
 const transfer=useUpload(),originalRequest=api.request,originalGet=api.get;
 let release;api.request=async config=>new Promise((resolve,reject)=>{release=()=>reject(new Error('cancelled'));config.signal.addEventListener('abort',release);});
 api.get=async()=>({data:{state:'succeeded',result:{receipt_no:'already-saved'}}});
 try{
 const args={url:'/materials/1',method:'put',statusUrl:'/materials/1/upload-status/',fields:{title:'资料'}};
 const pending=transfer.run(args);await assert.rejects(transfer.run(args),/尚未结束/);transfer.cancel();
 const result=await pending;assert.equal(result.receipt_no,'already-saved');assert.equal(transfer.busy.value,false);
 }finally{api.request=originalRequest;api.get=originalGet;sessionStorage.clear();}
});

