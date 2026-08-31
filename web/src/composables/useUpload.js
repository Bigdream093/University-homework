import { ref } from 'vue';
import api from '../api/request.js';
import { readUser } from '../utils/session.js';
export function newRequestId(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');}
export function intentSignature(value){const text=JSON.stringify(value);let a=2166136261,b=5381;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}return (a>>>0).toString(16)+(b>>>0).toString(16);}
export function useUpload(){
 const busy=ref(false),percent=ref(0),state=ref(''),pending=ref(false),loaded=ref(0),total=ref(null);let controller;
 async function run({url,statusUrl,method='post',fields={},file=null}){
 if(busy.value)throw new Error('当前上传尚未结束');
 const slot='upload:'+readUser()?.id+':'+url,signature=intentSignature({fields,file:file?{name:file.name,size:file.size,modified:file.lastModified}:null});
 let saved;try{saved=JSON.parse(sessionStorage.getItem(slot)||'null');}catch{}
 const previous=saved?.signature===signature;
 const intent=previous?saved:{key:newRequestId(),signature};
 sessionStorage.setItem(slot,JSON.stringify(intent));busy.value=true;pending.value=true;percent.value=0;loaded.value=0;total.value=null;
 try{
 if(previous){state.value='正在查询上次结果';const {data}=await api.get(statusUrl+intent.key);
 if(data.state==='succeeded'){state.value='已保存';pending.value=false;sessionStorage.removeItem(slot);return data.result;}
 if(data.state==='processing')throw new Error('服务器仍在处理，请稍后查询/重试');
 }
 const body=new FormData();for(const [k,v] of Object.entries(fields))body.append(k,v??'');if(file)body.append('file',file);
 controller=new AbortController();state.value='正在上传';
 const {data}=await api.request({url,method,data:body,timeout:0,signal:controller.signal,headers:{'Idempotency-Key':intent.key},onUploadProgress:e=>{loaded.value=e.loaded;total.value=e.total||null;percent.value=e.total?Math.min(100,Math.round(e.loaded/e.total*100)):0;state.value=percent.value>=100?'正在保存，请勿重复提交':'正在上传';}});
 state.value='已保存';pending.value=false;sessionStorage.removeItem(slot);return data;
 }catch(error){
 state.value='结果待确认，请查询/重试';
 try{const {data}=await api.get(statusUrl+intent.key);if(data.state==='succeeded'){state.value='已保存';pending.value=false;sessionStorage.removeItem(slot);return data.result;}if(data.state==='failed')state.value='保存失败，可以重试';}catch{}
 throw error;
 }finally{busy.value=false;controller=null;}
 }
 function cancel(){controller?.abort();state.value='已取消等待，正在确认服务器结果';}
 return {busy,percent,state,pending,loaded,total,run,cancel};
}
