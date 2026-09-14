'use strict';
const params=new URLSearchParams(location.hash.slice(1));
const code=params.get('code')||'';
document.getElementById('code').textContent=code||'No handoff code';
const openHelper=()=>{if(!code)return;location.href='ailinux-helper://handoff?code='+encodeURIComponent(code)};
document.getElementById('open').onclick=openHelper;
if(code&&/Android/i.test(navigator.userAgent))setTimeout(openHelper,100);
