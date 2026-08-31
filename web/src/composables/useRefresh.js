import { onMounted,onUnmounted } from 'vue';
export function useRefresh(load){
 let timer;const refresh=()=>{if(!document.hidden)load();};
 onMounted(()=>{refresh();timer=setInterval(refresh,60000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);});
 onUnmounted(()=>{clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);});
}

