// ==UserScript==
// @name         Associate Stow-FSAF
// @namespace    http://tampermonkey.net/
// @version      4.5.0
// @description  Stow FSAF analysis via API - clean edition
// @author       Pablllan (Pablo Chicano Llano)
// @match        https://logistics.amazon.co.uk/station/dashboard/*
// @match        https://logistics.amazon.*/station/dashboard/*
// @match        https://ui.eu.prod.svs.last-mile.amazon.dev/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      hooks.slack.com
// @connect      *.slack.com
// @updateURL    https://github.com/Pablllan5/Associate-Stow-FSAF/raw/refs/heads/main/Associate-Stow-FSAF.user.js
// @downloadURL  https://github.com/Pablllan5/Associate-Stow-FSAF/raw/refs/heads/main/Associate-Stow-FSAF.user.js
// ==/UserScript==
(function () {
'use strict';

const STORE_KEY = 'pab_stow_audit_api_v440';
const BTN_ID = 'pab-stow-fast-btn';
const PANEL_ID = 'pab-stow-fast-panel';
const MAX_CONCURRENT = 5;
const PPH_MIN_THRESHOLD = 200;

const clean = v => String(v || '').replace(/\u00a0/g, ' ').trim();

function getStore() {
  return GM_getValue(STORE_KEY, {
    running:false, selected:{}, associates:[], results:{}, sortBy:null, sortDir:'desc',
    startDate:null, endDate:null, workerComments:{}, showOnlyActive:false,
    webhookUrl:'', webhookMeetingUrl:'', searchFilter:'',
    breakExcludeMin:9, breakShowMax:30
  });
}
function getBreakLimitMs(){ return (getStore().breakExcludeMin||9)*60*1000; }
function getBreakShowMaxMs(){ return (getStore().breakShowMax||30)*60*1000; }
function setStore(s) { GM_setValue(STORE_KEY, s); }
function getApiKey() { return sessionStorage.getItem('boson.apiUsageKey'); }

async function apiPost(body) {
  const origin = location.origin.includes('logistics.amazon') ? location.origin : 'https://logistics.amazon.co.uk';
  const res = await fetch(`${origin}/station/proxyapigateway/data`, {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json;charset=UTF-8','X-API-Usage-Key':getApiKey(),'X-Requested-With':'XMLHttpRequest'},
    body:JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAllPackages(login, startTime, endTime) {
  let all=[], pt=null, pg=0;
  do {
    const d=await apiPost({resourcePath:"/os/getPackageHistoryForAssociate",httpMethod:"post",processName:"oculus",requestBody:{associateLoginId:login.includes('@')?login:`${login}@amazon.com`,pageSize:100,pageToken:pt,startTime,endTime}});
    all=all.concat(d.packageRecordList||[]);
    pt=d.nextPageToken||null;
    if(++pg>80)break;
  } while(pt);
  return all;
}

function isErr(r){return r.packageEventState===null&&r.scanContainer===null;}
function classifyErr(r){const l=clean(r.scanLocation||'');if(!l||l==='-')return'box';if(/^[A-Z]{1,2}\d{1,3}-\d{1,2}[A-Z]$/i.test(l))return'sourceZone';if(/^ES\d+$/i.test(l))return'tracking';return'box';}
function calcDpmo(e,s){return s>0?(e/s)*1000000:0;}

function pairAisles(aisleMap){
  const byLetter={};
  Object.entries(aisleMap).forEach(([aisle,count])=>{
    const m=aisle.match(/^([A-Z]+)(\d+)$/i);
    if(!m){if(!byLetter['?'])byLetter['?']={};byLetter['?'][aisle]=(byLetter['?'][aisle]||0)+count;return;}
    const letter=m[1].toUpperCase(),num=Number(m[2]);
    if(!byLetter[letter])byLetter[letter]={};
    byLetter[letter][num]=(byLetter[letter][num]||0)+count;
  });
  const pairs=[];
  Object.entries(byLetter).sort().forEach(([letter,nums])=>{
    const numbers=Object.keys(nums).map(Number).sort((a,b)=>a-b);
    const used=new Set();
    for(let i=0;i<numbers.length;i++){
      const n=numbers[i];if(used.has(n))continue;
      const partner=n%2===1?n+1:n-1;
      if(nums[partner]!==undefined&&!used.has(partner)){
        const lo=Math.min(n,partner),hi=Math.max(n,partner);
        pairs.push({label:`${letter}${lo}/${letter}${hi}`,count:(nums[n]||0)+(nums[partner]||0)});
        used.add(n);used.add(partner);
      }else{pairs.push({label:`${letter}${n}`,count:nums[n]||0});used.add(n);}
    }
  });
  return pairs.sort((a,b)=>b.count-a.count);
}

function calcTime(ts, cnt){
  const s=[...new Set(ts)].filter(Boolean).sort((a,b)=>a-b);
  if(s.length<2) return {pph:0, excludedBreakMinutes:0, breaks:[]};
  const BREAK_LIMIT=getBreakLimitMs(), BREAK_MAX=getBreakShowMaxMs();
  let ms=0, brk=0;
  const breaks=[];
  for(let i=1;i<s.length;i++){
    const d=s[i]-s[i-1];
    if(d>0 && d<=BREAK_LIMIT) ms+=d;
    else if(d>BREAK_LIMIT){
      brk+=d/60000;
      if(d<=BREAK_MAX) breaks.push({from:s[i-1], to:s[i], gap:Math.round(d/60000)});
    }
  }
  const min=ms/60000;
  return {pph:min>0?cnt/(min/60):0, excludedBreakMinutes:brk, breaks};
}

function analyze(packages){
  const stowed=[],errors=[],details=[],trkStow={},timestamps=[],dupDetails=[];
  for(const p of packages){
    if(p.packageEventState==='STOWED'){stowed.push(p);trkStow[p.trackingId]=(trkStow[p.trackingId]||0)+1;if(p.eventTime)timestamps.push(p.eventTime);}
    if(isErr(p)){const t=classifyErr(p);errors.push({trackingId:p.trackingId,type:t,ref:p.scanLocation||'-'});details.push({tracking:p.trackingId,ref:p.scanLocation||'-',type:t});}
  }
  let dupStowed=0;for(const[tid,c]of Object.entries(trkStow)){if(c>1){dupStowed+=(c-1);dupDetails.push({tracking:tid,count:c});}}
  let sz=0,bx=0,trk=0;for(const e of errors){if(e.type==='sourceZone')sz++;else if(e.type==='tracking')trk++;else bx++;}
  const tm=calcTime(timestamps,stowed.length);
  const aisleMap={};for(const p of stowed){const a=clean(p.scanLocation||'').split('-')[0]||'?';aisleMap[a]=(aisleMap[a]||0)+1;}
  return{stowed:stowed.length,errors:errors.length,sourceZoneErrors:sz,boxErrors:bx,trackingErrors:trk,duplicateStowed:dupStowed,duplicateDetails:dupDetails,details,aisleBreakdown:aisleMap,...tm};
}

function captureDates(){const d=decodeURIComponent(location.href),a=d.match(/"startDate":(\d+)/),b=d.match(/"endDate":(\d+)/);if(a&&b){const s=getStore();s.startDate=Number(a[1]);s.endDate=Number(b[1]);setStore(s);}}
function getStation(){const m=location.href.match(/stationCode=([A-Z0-9]+)/i);if(m)return m[1];const sel=document.getElementById('stations');return sel?.value||getStore().stationCode||null;}
function getCycle(){const m=(document.body?.innerText||'').match(/CYCLE_\d+/);return m?m[0]:'CYCLE_1';}

async function fetchAAs(){
  const sc=getStation(),cy=getCycle();if(!sc)throw new Error('No station.');
  const d=await apiPost({resourcePath:"svs/associates/data",httpMethod:"post",processName:"stow",requestBody:{filters:{"NODE":[sc],"CYCLE":[cy]},fieldsRequired:["NAME","STATUS","PERFORMANCE","LOCATION"]}});
  if(!d?.associates)return[];
  return d.associates.map(a=>({associate:a.alias?a.alias.split('@')[0]:'',active:(a.status||'').toUpperCase()==='ACTIVE'})).filter(x=>x.associate&&/^[a-z][a-z0-9_.-]{2,}$/i.test(x.associate));
}


function calcAvgPPH(results){
  const valid=Object.values(results||{}).filter(r=>r.pph>=PPH_MIN_THRESHOLD);
  if(!valid.length)return 0;
  return valid.reduce((a,r)=>a+r.pph,0)/valid.length;
}
function pphVsAvg(pph, avg){
  if(!avg||!pph||pph<PPH_MIN_THRESHOLD)return{pct:0,show:false};
  return{pct:((pph-avg)/avg)*100, show:true};
}

async function runQueue(q,sd,ed,cb){
  const res={};let done=0;
  for(let i=0;i<q.length;i+=MAX_CONCURRENT){
    await Promise.all(q.slice(i,i+MAX_CONCURRENT).map(async l=>{
      try{
        const p=await fetchAllPackages(l,sd,ed);
        res[l]=p.length?analyze(p):{stowed:0,errors:0,sourceZoneErrors:0,boxErrors:0,trackingErrors:0,duplicateStowed:0,duplicateDetails:[],details:[],aisleBreakdown:{},pph:0,excludedBreakMinutes:0,breaks:[],error:'REVISAR'};
      }catch(e){
        try{await new Promise(r=>setTimeout(r,1500));const p2=await fetchAllPackages(l,sd,ed);res[l]=p2.length?analyze(p2):{stowed:0,errors:0,sourceZoneErrors:0,boxErrors:0,trackingErrors:0,duplicateStowed:0,duplicateDetails:[],details:[],aisleBreakdown:{},pph:0,excludedBreakMinutes:0,breaks:[],error:'REVISAR'};}
        catch(e2){res[l]={stowed:0,errors:0,sourceZoneErrors:0,boxErrors:0,trackingErrors:0,duplicateStowed:0,duplicateDetails:[],details:[],aisleBreakdown:{},pph:0,excludedBreakMinutes:0,breaks:[],error:'REVISAR',reason:e2.message};}
      }
      done++;if(cb)cb(l,done,q.length);
    }));
    if(!getStore().running)break;
  }
  return res;
}

// ─── REPORTS ─────────────────────────────────────────────
function fmtNow(){const d=new Date();return`${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}

function buildReport(){
  const s=getStore(),R=s.results||{},C=s.workerComments||{};
  const rows=(s.associates||[]).filter(a=>R[a.associate]).map(a=>({login:a.associate,active:a.active,fb:C[a.associate]||'',...(R[a.associate]||{})}));
  const t={s:rows.reduce((a,r)=>a+(r.stowed||0),0),e:rows.reduce((a,r)=>a+(r.errors||0),0),sz:rows.reduce((a,r)=>a+(r.sourceZoneErrors||0),0),bx:rows.reduce((a,r)=>a+(r.boxErrors||0),0),trk:rows.reduce((a,r)=>a+(r.trackingErrors||0),0),x2:rows.reduce((a,r)=>a+(r.duplicateStowed||0),0)};
  const avg=calcAvgPPH(R);
  const sorted=[...rows].sort((a,b)=>(b.errors||0)-(a.errors||0));
  const hdrs=['ASSOCIATE','ACTIVO','STOWED','FSAF','DPMO','PPH','PPH_VS_AVG%','SZ','CAJA','TRACK','X2','BREAKS_9-30','STATUS','FEEDBACK'].join('\t');
  const xl=sorted.map(r=>{
    const vs=pphVsAvg(r.pph,avg);
    const breaksCount=(r.breaks||[]).length;
    const breaksMin=Math.round(r.excludedBreakMinutes||0);
    return[r.login,r.active?'Y':'N',r.stowed||0,r.errors||0,Math.round(calcDpmo(r.errors,r.stowed)),r.pph?Math.round(r.pph):'',vs.show?vs.pct.toFixed(1)+'%':'N/A',r.sourceZoneErrors||0,r.boxErrors||0,r.trackingErrors||0,r.duplicateStowed||0,`${breaksCount}p/${breaksMin}min`,r.error||'OK',r.fb].join('\t');
  }).join('\n');
  return`📦 STOW AUDIT\n${fmtNow()}\n\nStowed: ${t.s} | FSAF: ${t.e} | DPMO: ${Math.round(calcDpmo(t.e,t.s))} | X2: ${t.x2} | PPH Avg: ${Math.round(avg)}\nSZ: ${t.sz} | Caja: ${t.bx} | Track: ${t.trk}\n\nEXCEL:\n${hdrs}\n${xl}`;
}

function buildMeeting(){
  const s=getStore(),R=s.results||{},C=s.workerComments||{},sc=getStation()||'DQB2';
  const base=s.showOnlyActive?(s.associates||[]).filter(a=>a.active):(s.associates||[]);
  const rows=base.filter(a=>R[a.associate]&&!R[a.associate].error).map(a=>({login:a.associate,fb:C[a.associate]||'',...(R[a.associate]||{})}));
  const t={s:rows.reduce((a,r)=>a+(r.stowed||0),0),e:rows.reduce((a,r)=>a+(r.errors||0),0),sz:rows.reduce((a,r)=>a+(r.sourceZoneErrors||0),0),bx:rows.reduce((a,r)=>a+(r.boxErrors||0),0),trk:rows.reduce((a,r)=>a+(r.trackingErrors||0),0)};
  const avg=calcAvgPPH(R);
  const top3=[...rows].sort((a,b)=>(b.errors||0)-(a.errors||0)).slice(0,3);
  const now=new Date(),ds=`${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`,ts=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  let m=`📋 Reporte FSAF — ${sc} Night Shift\n🕐 ${ds}, ${ts} • CYCLE 1\n\n`;
  m+=`📦 Totales\n✅ Stowed: ${t.s}\n❌ FSAF: ${t.e}\n📊 DPMO: ${Math.round(calcDpmo(t.e,t.s))}\n⚡ PPH Medio: ${Math.round(avg)}\nSort Zone: ${t.sz} • Caja: ${t.bx} • Tracking: ${t.trk}\n`;
  m+=`\n🔥 Top 3 — Más FSAF\n`;
  top3.forEach((r,i)=>{
    const dp=calcDpmo(r.errors,r.stowed);
    const vs=pphVsAvg(r.pph,avg);
    const vsStr=vs.show?` (${vs.pct>=0?'+':''}${vs.pct.toFixed(0)}% vs media)`:'';
    m+=`\n${i+1}. ${r.login}\n⚡ PPH: ${Math.round(r.pph||0)}${vsStr}\n📊 DPMO: ${Math.round(dp)}\n❌ FSAF: ${r.errors}\nSort Zone: ${r.sourceZoneErrors}\nCaja: ${r.boxErrors}\nTracking: ${r.trackingErrors}\n`;
    if(r.fb)m+=`💬 ${r.fb}\n`;
  });
  return m;
}

function sendR(){const s=getStore();if(!s.webhookUrl){alert('Configura WH Report.');return;}GM_xmlhttpRequest({method:'POST',url:s.webhookUrl,headers:{'Content-Type':'application/json'},data:JSON.stringify({slack_message:buildReport()}),onload(r){alert(r.status<300?'Enviado.':'Error '+r.status);},onerror(){alert('Error red.');}});}
function sendM(){const s=getStore();if(!s.webhookMeetingUrl){alert('Configura WH Meeting.');return;}GM_xmlhttpRequest({method:'POST',url:s.webhookMeetingUrl,headers:{'Content-Type':'application/json'},data:JSON.stringify({slack_message:buildMeeting()}),onload(r){alert(r.status<300?'Enviado.':'Error '+r.status);},onerror(){alert('Error red.');}});}

// ─── CONFIG MODAL ──────────────────────────────────────────
function showConfig(){
  document.getElementById('pab-cfg-backdrop')?.remove();document.getElementById('pab-cfg-modal')?.remove();
  const s=getStore();
  const backdrop=document.createElement('div');backdrop.id='pab-cfg-backdrop';backdrop.style.cssText='position:fixed;inset:0;z-index:2147483648;background:rgba(0,0,0,.6);backdrop-filter:blur(4px)';
  const modal=document.createElement('div');modal.id='pab-cfg-modal';modal.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483649;background:#0f172a;border:2px solid #64748b;border-radius:16px;padding:24px;min-width:400px;color:white;font-family:Segoe UI,Arial,sans-serif;box-shadow:0 25px 60px rgba(0,0,0,.8)';
  modal.innerHTML=`<h3 style="margin:0 0 16px;font-size:16px;color:#94a3b8">⚙️ Configuración</h3>
  <label style="font-size:11px;color:#94a3b8;font-weight:800">Webhook Report (Slack)</label>
  <input id="cfg-wh-report" value="${s.webhookUrl||''}" style="width:100%;background:#1e293b;border:1px solid #334155;color:white;border-radius:8px;padding:8px;margin:4px 0 12px;font-size:12px">
  <label style="font-size:11px;color:#94a3b8;font-weight:800">Webhook Meeting (Slack)</label>
  <input id="cfg-wh-meeting" value="${s.webhookMeetingUrl||''}" style="width:100%;background:#1e293b;border:1px solid #334155;color:white;border-radius:8px;padding:8px;margin:4px 0 12px;font-size:12px">
  <label style="font-size:11px;color:#94a3b8;font-weight:800">⏸ Excluir pausas mayores de X minutos para calcular PPH (defecto: 9)</label>
  <input id="cfg-break-exclude" type="number" min="1" value="${s.breakExcludeMin||9}" style="width:100%;background:#1e293b;border:1px solid #334155;color:white;border-radius:8px;padding:8px;margin:4px 0 12px;font-size:12px">
  <label style="font-size:11px;color:#94a3b8;font-weight:800">⏸ Mostrar en detalle pausas de hasta X minutos (defecto: 30)</label>
  <input id="cfg-break-show" type="number" min="1" value="${s.breakShowMax||30}" style="width:100%;background:#1e293b;border:1px solid #334155;color:white;border-radius:8px;padding:8px;margin:4px 0 16px;font-size:12px">
  <div style="display:flex;gap:8px"><button id="cfg-save" style="flex:1;padding:10px;background:#22c55e;color:#111;border:0;border-radius:10px;font-weight:900;cursor:pointer">Guardar</button><button id="cfg-close" style="flex:1;padding:10px;background:#334155;color:white;border:0;border-radius:10px;font-weight:900;cursor:pointer">Cerrar</button></div>`;
  backdrop.onclick=()=>{backdrop.remove();modal.remove();};
  const container=document.fullscreenElement||document.webkitFullscreenElement||document.body;
  container.appendChild(backdrop);container.appendChild(modal);
  document.getElementById('cfg-save').onclick=()=>{const st=getStore();st.webhookUrl=document.getElementById('cfg-wh-report').value.trim();st.webhookMeetingUrl=document.getElementById('cfg-wh-meeting').value.trim();st.breakExcludeMin=Number(document.getElementById('cfg-break-exclude').value)||9;st.breakShowMax=Number(document.getElementById('cfg-break-show').value)||30;setStore(st);alert('✅ Guardado.');backdrop.remove();modal.remove();};
  document.getElementById('cfg-close').onclick=()=>{backdrop.remove();modal.remove();};
}

// ─── INFO MODAL ──────────────────────────────────────────────
function showInfo(login){
  document.getElementById('pab-info-backdrop')?.remove();document.getElementById('pab-info-modal')?.remove();
  const s=getStore(),r=s.results?.[login],a=(s.associates||[]).find(x=>x.associate===login);
  const dpmo=r?calcDpmo(r.errors,r.stowed):0,badge=`https://internal-cdn.amazon.com/badgephotos.amazon.com/?login=${login}`;
  const paired=r?.aisleBreakdown?pairAisles(r.aisleBreakdown):[];
  const avg=calcAvgPPH(s.results||{});
  const vs=pphVsAvg(r?.pph,avg);

  const bk=document.createElement('div');bk.id='pab-info-backdrop';bk.style.cssText='position:fixed;inset:0;z-index:2147483648;background:rgba(0,0,0,.6);backdrop-filter:blur(4px)';
  const m=document.createElement('div');m.id='pab-info-modal';m.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483649;background:#0f172a;border:2px solid #3b82f6;border-radius:16px;padding:20px;min-width:420px;max-width:520px;max-height:80vh;overflow:auto;color:white;font-family:Segoe UI,Arial,sans-serif;box-shadow:0 25px 60px rgba(0,0,0,.8)';
  m.innerHTML=`<button id="pab-info-x" style="position:absolute;top:10px;right:14px;background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer">✕</button>
  <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.1)"><img src="${badge}" style="width:60px;height:60px;border-radius:12px;border:2px solid #3b82f6;background:#1e293b" onerror="this.style.display='none'"><div><div style="font-size:18px;font-weight:900;color:#60a5fa">${login}</div><span style="font-size:11px;font-weight:800;padding:3px 8px;border-radius:999px;background:${a?.active?'#14532d':'#7f1d1d'};color:${a?.active?'#86efac':'#fca5a5'}">${a?.active?'● ACTIVE':'● INACTIVE'}</span></div></div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
  <div style="background:#1e293b;border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:#64748b;font-weight:800">STOWED</div><div style="font-size:20px;font-weight:900;margin-top:4px">${r?.stowed||0}</div></div>
  <div style="background:#1e293b;border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:#64748b;font-weight:800">PPH</div><div style="font-size:20px;font-weight:900;margin-top:4px;color:#22c55e">${r?.pph?r.pph.toFixed(0):'-'}${vs.show?` <span style="font-size:12px;color:${vs.pct>=0?'#22c55e':'#ef4444'}">(${vs.pct>=0?'+':''}${vs.pct.toFixed(0)}%)</span>`:''}</div></div>
  <div style="background:#1e293b;border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:#64748b;font-weight:800">FSAF</div><div style="font-size:20px;font-weight:900;margin-top:4px;color:${r?.errors>0?'#ef4444':'#22c55e'}">${r?.errors||0}</div></div>
  <div style="background:#1e293b;border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:#64748b;font-weight:800">DPMO</div><div style="font-size:20px;font-weight:900;margin-top:4px;color:${dpmo>5000?'#ef4444':dpmo>2000?'#facc15':'#22c55e'}">${Math.round(dpmo)}</div></div>
  <div style="background:#1e293b;border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:#64748b;font-weight:800">STOWED X2</div><div style="font-size:20px;font-weight:900;margin-top:4px;color:${r?.duplicateStowed>0?'#facc15':'#22c55e'}">${r?.duplicateStowed||0}</div></div>
  <div style="background:#1e293b;border-radius:10px;padding:10px;text-align:center"><div style="font-size:9px;color:#64748b;font-weight:800">SZ / BOX / TRK</div><div style="font-size:14px;font-weight:900;margin-top:6px">${r?.sourceZoneErrors||0} / ${r?.boxErrors||0} / ${r?.trackingErrors||0}</div></div>
  </div>
  ${r?.details?.length?`<div style="font-size:11px;color:#64748b;font-weight:800;margin:10px 0 6px">FSAF DETAILS (${r.details.length})</div><div style="max-height:130px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr><th style="color:#64748b;font-size:8px;padding:4px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left">#</th><th style="color:#64748b;font-size:8px;padding:4px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left">Tracking</th><th style="color:#64748b;font-size:8px;padding:4px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left">Ref</th><th style="color:#64748b;font-size:8px;padding:4px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left">Type</th></tr></thead><tbody>${r.details.slice(0,25).map((d,i)=>`<tr><td style="padding:3px;color:#e2e8f0">${i+1}</td><td style="padding:3px;color:#e2e8f0">${d.tracking}</td><td style="padding:3px;color:#e2e8f0">${d.ref}</td><td style="padding:3px;color:${d.type==='sourceZone'?'#60a5fa':d.type==='tracking'?'#facc15':'#f97316'}">${d.type}</td></tr>`).join('')}</tbody></table></div>`:''}
  ${r?.duplicateDetails?.length?`<div style="font-size:11px;color:#64748b;font-weight:800;margin:10px 0 6px">STOWED X2 DETAILS</div><div style="max-height:100px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr><th style="color:#64748b;font-size:8px;padding:4px;text-align:left">Tracking</th><th style="color:#64748b;font-size:8px;padding:4px;text-align:left">Times</th></tr></thead><tbody>${r.duplicateDetails.map(d=>`<tr><td style="padding:3px;color:#e2e8f0">${d.tracking}</td><td style="padding:3px;color:#facc15">${d.count}x</td></tr>`).join('')}</tbody></table></div>`:''}
  ${paired.length?`<div style="font-size:11px;color:#64748b;font-weight:800;margin:10px 0 6px">STOWED BY AISLE</div><div style="display:flex;flex-wrap:wrap;gap:6px">${paired.map(p=>`<span style="background:#1e293b;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:4px 8px;font-size:11px;font-weight:800"><span style="color:#60a5fa">${p.label}</span> <span style="color:#e2e8f0">${p.count}</span></span>`).join('')}</div>`:''}`;
  bk.onclick=()=>{bk.remove();m.remove();};document.body.appendChild(bk);document.body.appendChild(m);
  document.getElementById('pab-info-x').onclick=()=>{bk.remove();m.remove();};
}

// ─── CSS & PANEL ─────────────────────────────────────────────
function injectCSS(){
  if(document.getElementById('pab-css'))return;const c=document.createElement('style');c.id='pab-css';
  c.textContent=`#${BTN_ID}{position:fixed;right:20px;bottom:20px;z-index:2147483647;background:linear-gradient(135deg,#ff9900,#f59e0b);color:#111;border:0;border-radius:14px;padding:13px 20px;font-family:Arial,sans-serif;font-weight:900;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.35)}
#${PANEL_ID}{position:fixed;right:20px;bottom:80px;width:1180px;max-height:78vh;overflow:auto;z-index:2147483647;background:#111827;color:white;border:2px solid #ff9900;border-radius:16px;padding:16px;font-family:'Segoe UI',Arial,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.7);transition:all .3s}
#${PANEL_ID}:fullscreen{position:fixed!important;inset:0!important;width:100vw!important;max-height:100vh!important;height:100vh!important;border-radius:0!important;border:0!important;padding:20px;background:#111827}
#${PANEL_ID}:-webkit-full-screen{position:fixed!important;inset:0!important;width:100vw!important;max-height:100vh!important;height:100vh!important;border-radius:0!important;border:0!important;padding:20px;background:#111827}
#${PANEL_ID}.fs{position:fixed!important;inset:0!important;width:100vw!important;max-height:100vh!important;height:100vh!important;border-radius:0!important;border:0!important;padding:20px}
#${PANEL_ID} .hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.1)}
#${PANEL_ID} .tt{font-size:18px;font-weight:900;background:linear-gradient(135deg,#ff9900,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
#${PANEL_ID} button{border-radius:8px;padding:6px 11px;font-weight:800;cursor:pointer;margin:2px;font-size:11px;border:1px solid rgba(255,255,255,.15);transition:all .15s}
#${PANEL_ID} .bo{background:#ff9900;color:#111;border-color:#ff9900}
#${PANEL_ID} .bg{background:#14532d;border-color:#22c55e;color:#86efac}
#${PANEL_ID} .br{background:#7f1d1d;border-color:#ef4444;color:#fca5a5}
#${PANEL_ID} .bgy{background:#334155;color:#cbd5e1;border-color:#475569}
#${PANEL_ID} .bp{background:#831843;border-color:#db2777;color:#f9a8d4}
#${PANEL_ID} .bcfg{background:#334155;color:#94a3b8;border-color:#475569}
#${PANEL_ID} .bx{background:linear-gradient(135deg,#1e40af,#3b82f6);border:0;color:white;padding:8px 14px}
#${PANEL_ID} table{width:100%;border-collapse:collapse;font-size:12px}
#${PANEL_ID} th{text-align:left;color:#64748b;font-size:9px;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.1);padding:7px 5px;white-space:nowrap}
#${PANEL_ID} th.st{cursor:pointer;color:#fbbf24}
#${PANEL_ID} td{border-bottom:1px solid rgba(255,255,255,.05);padding:7px 5px;color:#e2e8f0}
#${PANEL_ID} tbody tr:hover{background:rgba(255,255,255,.03)}
#${PANEL_ID} .sm{font-size:13px;font-weight:800;margin-bottom:8px;color:#ff9900}
.bad{color:#ef4444;font-weight:900}.ok{color:#22c55e;font-weight:900}.warn{color:#facc15;font-weight:900}
#${PANEL_ID} td.an{color:#60a5fa;font-weight:900;font-size:13px}
#${PANEL_ID} .pb{width:100%;height:8px;background:#1e293b;border-radius:4px;margin-top:8px;overflow:hidden}
#${PANEL_ID} .pf{height:100%;background:linear-gradient(90deg,#ff9900,#f59e0b);border-radius:4px;transition:width .4s}
#${PANEL_ID} input[type="checkbox"]{transform:scale(1.2);accent-color:#ff9900}
#${PANEL_ID} .srch{background:#1e293b;border:1px solid #334155;color:white;border-radius:8px;padding:6px 10px;font-size:12px;width:160px}`;
  document.head.appendChild(c);
}

let _isFullscreen = false;
function toggleFullscreen(){
  try{
    const d=document,f=!!(d.fullscreenElement||d.webkitFullscreenElement);
    if(f){if(d.exitFullscreen)d.exitFullscreen();else if(d.webkitExitFullscreen)d.webkitExitFullscreen();}
    else{const el=document.getElementById(PANEL_ID);if(el?.requestFullscreen)el.requestFullscreen();else if(el?.webkitRequestFullscreen)el.webkitRequestFullscreen();}
  }catch(e){}
}

function showPanel(){
  injectCSS();document.getElementById(PANEL_ID)?.remove();
  const s=getStore();
  const avg=calcAvgPPH(s.results||{});

  // Filter by search
  let base=s.showOnlyActive?(s.associates||[]).filter(a=>a.active):(s.associates||[]);
  const filter=(s.searchFilter||'').toLowerCase();
  if(filter) base=base.filter(a=>a.associate.toLowerCase().includes(filter));

  const shown=sortAssociates(base,s);
  const tE=Object.values(s.results||{}).reduce((a,r)=>a+(r.errors||0),0);
  const tS=Object.values(s.results||{}).reduce((a,r)=>a+(r.stowed||0),0);
  const tX=Object.values(s.results||{}).reduce((a,r)=>a+(r.duplicateStowed||0),0);

  const p=document.createElement('div');p.id=PANEL_ID;
  p.innerHTML=`<div class="hd"><div class="tt">📦 Stow Audit Dashboard</div><div>
  <input id="z-search" class="srch" placeholder="🔍 Buscar AA..." value="${s.searchFilter||''}">
  <button id="z-ref" class="bo">Actualizar</button>
  <button id="z-act" class="bg">Activos</button><button id="z-all" class="bg">Todos</button>
  <button id="z-del" class="br">Borrar</button>
  <button id="z-cfg" class="bcfg">⚙️</button>
  <button id="z-ra" class="bo">Analizar activos</button><button id="z-rt" class="bo">Analizar todos</button><button id="z-stop" class="br">Stop</button>
  <button id="z-sr" class="bp">Slack Report</button><button id="z-sm" class="bp">Slack Meeting</button>
  <button id="z-exp" class="bx">⛶</button><button id="z-cls" class="bgy">✕</button>
  </div></div>
  <div class="sm">Estado: ${s.running?'Analizando...':'Parado'} · AAs: ${(s.associates||[]).length} · Stowed: ${tS} · FSAF: ${tE} · DPMO: ${Math.round(calcDpmo(tE,tS))} · X2: ${tX} · <span style="color:#22c55e">PPH Avg: ${Math.round(avg)}</span></div>
  <div class="sm">Fechas: ${s.startDate&&s.endDate?s.startDate+' → '+s.endDate:'NO CAPTURADAS'} ${!getApiKey()?'<span class="bad">⚠️ No API Key</span>':'<span class="ok">✅</span>'}</div>
  <div id="pab-pa"></div>
  <table><thead><tr><th>✓</th>${sL('active','Act',s)}${sL('associate','Associate',s)}${sL('stowed','Stowed',s)}${sL('pph','PPH',s)}${sL('dpmo','DPMO',s)}${sL('errors','FSAF',s)}${sL('sourceZoneErrors','SZ',s)}${sL('boxErrors','Caja',s)}${sL('trackingErrors','Track',s)}${sL('duplicateStowed','X2',s)}<th>Status</th><th>Acción</th></tr></thead>
  <tbody>${shown.length?shown.map(a=>{
    const r=s.results[a.associate],ck=s.selected?.[a.associate]?'checked':'',fb=s.workerComments?.[a.associate];
    const vs=r?pphVsAvg(r.pph,avg):{show:false};
    const pphStr=r?.pph?`${r.pph.toFixed(0)} <span style="font-size:10px;color:${vs.show?(vs.pct>=0?'#22c55e':'#ef4444'):'#64748b'}">${vs.show?`(${vs.pct>=0?'+':''}${vs.pct.toFixed(0)}%)`:''}</span>`:'-';
    return`<tr><td><input type="checkbox" class="pab-ck" data-l="${a.associate}" ${ck}></td><td class="${a.active?'ok':'bad'}">${a.active?'✅':'❌'}</td><td class="an"><img src="https://internal-cdn.amazon.com/badgephotos.amazon.com/?login=${a.associate}" style="width:26px;height:26px;border-radius:6px;vertical-align:middle;margin-right:5px;border:1px solid #334155" onerror="this.style.display='none'">${a.associate}${fb?' 📝':''}</td><td>${r?r.stowed:'-'}</td><td>${pphStr}</td><td>${r?Math.round(calcDpmo(r.errors,r.stowed)):'-'}</td><td class="${r?.errors>0?'bad':'ok'}">${r?r.errors:'-'}</td><td>${r?r.sourceZoneErrors:'-'}</td><td>${r?r.boxErrors:'-'}</td><td>${r?r.trackingErrors:'-'}</td><td class="${r?.duplicateStowed>0?'warn':'ok'}">${r?r.duplicateStowed:'-'}</td><td class="${r?.error?'warn':'ok'}">${r?(r.error||'OK'):'-'}</td><td><button class="pab-1" data-l="${a.associate}">▶</button><button class="pab-i" data-l="${a.associate}">Info</button><button class="pab-p" data-l="${a.associate}" style="${r?.breaks?.length?'background:#7f1d1d;border-color:#ef4444;color:#fca5a5':''}">⏸</button><button class="pab-fb" data-l="${a.associate}">💬</button></td></tr>`;
  }).join(''):'<tr><td colspan="13">Pulsa Actualizar.</td></tr>'}</tbody></table>`;

  document.body.appendChild(p);
  if(_isFullscreen) p.classList.add('fs');

  // Event bindings
  const $=id=>document.getElementById(id);
  $('z-cls').onclick=()=>{_isFullscreen=false;p.remove();};
  $('z-exp').onclick=toggleFullscreen;
  $('z-sr').onclick=sendR;$('z-sm').onclick=sendM;$('z-cfg').onclick=showConfig;
  $('z-act').onclick=()=>{const st=getStore();st.showOnlyActive=true;setStore(st);showPanel();};
  $('z-all').onclick=()=>{const st=getStore();st.showOnlyActive=false;setStore(st);showPanel();};
  $('z-del').onclick=()=>{if(!confirm('¿Borrar?'))return;const st=getStore();st.associates=[];st.results={};st.selected={};st.running=false;st.workerComments={};setStore(st);showPanel();};
  $('z-stop').onclick=()=>{const st=getStore();st.running=false;setStore(st);showPanel();};
  $('z-rt').onclick=()=>{const st=getStore();st.showOnlyActive=false;setStore(st);startRun(st.associates.map(a=>a.associate));};
  $('z-ra').onclick=()=>{const st=getStore();const a=st.associates.filter(x=>x.active).map(x=>x.associate);if(!a.length)return alert('No activos.');st.showOnlyActive=true;setStore(st);startRun(a);};
  $('z-ref').onclick=async()=>{const st=getStore();try{const f=await fetchAAs();if(!f.length){alert('No AAs.');return;}const map=new Map((st.associates||[]).map(a=>[a.associate,a]));f.forEach(a=>map.set(a.associate,{...map.get(a.associate),...a}));st.associates=Array.from(map.values());st.stationCode=getStation();st.running=false;if(!st.results)st.results={};if(!st.selected)st.selected={};if(!st.workerComments)st.workerComments={};setStore(st);showPanel();}catch(e){alert('Error: '+e.message);}};

  // Search filter - filter rows without re-rendering panel
  $('z-search').oninput=function(){
    const val=this.value.toLowerCase();
    const st=getStore();st.searchFilter=val;setStore(st);
    p.querySelectorAll('tbody tr').forEach(tr=>{
      const login=tr.querySelector('.pab-ck')?.dataset.l||tr.querySelector('.pab-1')?.dataset.l||'';
      tr.style.display=login.toLowerCase().includes(val)?'':'none';
    });
  };

  // Sort headers
  p.querySelectorAll('th.st').forEach(th=>{th.onclick=()=>{const st=getStore(),k=th.dataset.s;if(st.sortBy===k)st.sortDir=st.sortDir==='asc'?'desc':'asc';else{st.sortBy=k;st.sortDir=k==='associate'?'asc':'desc';}setStore(st);showPanel();};});
  // Checkboxes
  p.querySelectorAll('.pab-ck').forEach(c=>{c.onchange=()=>{const st=getStore();if(!st.selected)st.selected={};st.selected[c.dataset.l]=c.checked;setStore(st);};});
  // Individual run
  p.querySelectorAll('.pab-1').forEach(b=>{b.onclick=()=>startRun([b.dataset.l]);});
  // Info
  p.querySelectorAll('.pab-i').forEach(b=>{b.onclick=()=>showInfo(b.dataset.l);});
  // Breaks button
  p.querySelectorAll('.pab-p').forEach(b=>{b.onclick=()=>{
    const st=getStore(),r=st.results?.[b.dataset.l];
    const minExcl=st.breakExcludeMin||9,maxShow=st.breakShowMax||30;
    if(!r?.breaks?.length){alert(`${b.dataset.l}: Sin pausas ${minExcl}-${maxShow} min detectadas.`);return;}
    const list=r.breaks.map(br=>{
      const from=new Date(br.from).toLocaleTimeString();
      const to=new Date(br.to).toLocaleTimeString();
      return `${from} → ${to} (${br.gap} min)`;
    }).join('\n');
    alert(`Pausas ${minExcl}-${maxShow} min — ${b.dataset.l}\n\n${list}\n\nTotal: ${r.breaks.length} pausas, ${r.breaks.reduce((acc,x)=>acc+x.gap,0)} min`);
  };});
  // Feedback
  p.querySelectorAll('.pab-fb').forEach(b=>{b.onclick=()=>{const st=getStore(),v=prompt(`Feedback ${b.dataset.l}:`,st.workerComments?.[b.dataset.l]||'');if(v!==null){if(!st.workerComments)st.workerComments={};st.workerComments[b.dataset.l]=clean(v);setStore(st);showPanel();}};});
}

function sortAssociates(l,s){if(!s.sortBy)return l;return[...l].sort((a,b)=>{const ra=s.results?.[a.associate]||{},rb=s.results?.[b.associate]||{};const getVal=(r,k)=>k==='dpmo'?calcDpmo(r.errors||0,r.stowed||0):k==='associate'?null:k==='active'?null:Number(r[k]||0);const va=s.sortBy==='associate'?a.associate:s.sortBy==='active'?(a.active?1:0):getVal(ra,s.sortBy),vb=s.sortBy==='associate'?b.associate:s.sortBy==='active'?(b.active?1:0):getVal(rb,s.sortBy);if(typeof va==='string')return s.sortDir==='asc'?va.localeCompare(vb):vb.localeCompare(va);return s.sortDir==='asc'?va-vb:vb-va;});}
function sL(k,l,s){return`<th class="st" data-s="${k}">${l}${s.sortBy===k?(s.sortDir==='asc'?' ▲':' ▼'):''}</th>`;}

async function startRun(q){
  const s=getStore();
  if(!s.startDate||!s.endDate){const now=new Date(),sod=new Date(now);sod.setHours(0,0,0,0);s.startDate=sod.getTime();s.endDate=now.getTime()+3600000;setStore(s);}
  if(!getApiKey())return alert('No API Key.');
  if(!q.length)return alert('No AAs.');
  q.forEach(l=>delete s.results[l]);s.running=true;setStore(s);showPanel();
  const area=document.getElementById('pab-pa');if(area)area.innerHTML=`<div class="sm">⏳ 0/${q.length}</div><div class="pb"><div class="pf" id="pab-pf" style="width:0%"></div></div>`;
  const res=await runQueue(q,s.startDate,s.endDate,(l,d,t)=>{const f=document.getElementById('pab-pf'),a=document.getElementById('pab-pa');if(f)f.style.width=`${Math.round(d/t*100)}%`;if(a)a.querySelector('.sm').textContent=`⏳ ${d}/${t} (${l})`;});
  const fin=getStore();if(!fin.results)fin.results={};Object.assign(fin.results,res);fin.running=false;setStore(fin);showPanel();alert('✅ Listo.');
}

function createBtn(){injectCSS();if(document.getElementById(BTN_ID))return;const b=document.createElement('button');b.id=BTN_ID;b.textContent='📦 STOW ERRORS';b.onclick=showPanel;document.body.appendChild(b);}

if(location.hostname.includes('logistics.amazon')){captureDates();setInterval(createBtn,2000);}
if(location.hostname.includes('svs.last-mile.amazon.dev')||location.hostname.includes('logistics.amazon'))setInterval(createBtn,1000);

})();
