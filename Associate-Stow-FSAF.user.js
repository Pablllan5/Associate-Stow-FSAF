// ==UserScript==
// @name         Associate Stow-FSAF
// @namespace    http://tampermonkey.net/
// @version      5.4.0
// @description  Stow FSAF analysis via API - v52 clean edition
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

// ─── CONSTANTS ────────────────────────────────────────────
const STORE_KEY     = 'pab_stow_audit_api_v440';
const BTN_ID        = 'pab-stow-fast-btn';
const PANEL_ID      = 'pab-stow-fast-panel';
const MAX_CONCURRENT = 5;
const PPH_MIN_THRESHOLD = 200;
const PPH_MAX_THRESHOLD = 700;

// ─── UTILS ────────────────────────────────────────────────
const clean  = v => String(v || '').replace(/ /g, ' ').trim();
const esc    = v => String(v || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sleep  = ms => new Promise(r => setTimeout(r, ms));
let _searchDebounce = null;

// ─── STORE ────────────────────────────────────────────────
function getStore() {
  return GM_getValue(STORE_KEY, {
    running: false, selected: {}, associates: [], results: {},
    sortBy: null, sortDir: 'desc', startDate: null, endDate: null,
    workerComments: {}, showOnlyActive: false,
    webhookUrl: '', webhookMeetingUrl: '', searchFilter: '',
    breakExcludeMin: 9, breakShowMax: 30, stationCode: null
  });
}
function setStore(s) { GM_setValue(STORE_KEY, s); }
function getApiKey() { return sessionStorage.getItem('boson.apiUsageKey'); }

// ─── API ──────────────────────────────────────────────────
async function apiPost(body) {
  const origin = location.origin.includes('logistics.amazon')
    ? location.origin : 'https://logistics.amazon.co.uk';
  const res = await fetch(`${origin}/station/proxyapigateway/data`, {
    method: 'POST', credentials: 'include',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'X-API-Usage-Key': getApiKey(),
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAllPackages(login, startTime, endTime) {
  let all = [], pt = null, pg = 0;
  do {
    const d = await apiPost({
      resourcePath: '/os/getPackageHistoryForAssociate',
      httpMethod: 'post', processName: 'oculus',
      requestBody: {
        associateLoginId: login.includes('@') ? login : `${login}@amazon.com`,
        pageSize: 100, pageToken: pt, startTime, endTime
      }
    });
    all = all.concat(d.packageRecordList || []);
    pt = d.nextPageToken || null;
    if (++pg > 80) break;
  } while (pt);
  return all;
}

// ─── CLASSIFICATION ───────────────────────────────────────
function isErr(r)       { return r.packageEventState === null && r.scanContainer === null; }
function classifyErr(r) {
  const l = clean(r.scanLocation || '');
  if (!l || l === '-') return 'box';
  if (/^NC\d+$/i.test(l)) return null;
  if (/^[A-Z]{1,2}\d{1,3}-\d{0,2}[A-Z]$/i.test(l)) return 'sourceZone';
  if (/^ES\d+$/i.test(l)) return 'tracking';
  return 'box';
}
function calcDpmo(e, s) { return s > 0 ? (e / s) * 1000000 : 0; }

// ─── PAIR AISLES ──────────────────────────────────────────
function pairAisles(aisleMap) {
  const byLetter = {};
  Object.entries(aisleMap).forEach(([aisle, count]) => {
    const m = aisle.match(/^([A-Z]+)(\d+)$/i);
    if (!m) { (byLetter['?'] = byLetter['?'] || {})[aisle] = (byLetter['?']?.[aisle] || 0) + count; return; }
    const letter = m[1].toUpperCase(), num = Number(m[2]);
    (byLetter[letter] = byLetter[letter] || {})[num] = (byLetter[letter][num] || 0) + count;
  });
  const pairs = [];
  Object.entries(byLetter).sort().forEach(([letter, nums]) => {
    const numbers = Object.keys(nums).map(Number).sort((a, b) => a - b);
    const used = new Set();
    for (const n of numbers) {
      if (used.has(n)) continue;
      const partner = n % 2 === 1 ? n + 1 : n - 1;
      if (nums[partner] !== undefined && !used.has(partner)) {
        const lo = Math.min(n, partner), hi = Math.max(n, partner);
        pairs.push({ label: `${letter}${lo}/${letter}${hi}`, count: (nums[n] || 0) + (nums[partner] || 0) });
        used.add(n); used.add(partner);
      } else { pairs.push({ label: `${letter}${n}`, count: nums[n] || 0 }); used.add(n); }
    }
  });
  return pairs.sort((a, b) => b.count - a.count);
}

// ─── TIME METRICS ─────────────────────────────────────────
function calcTime(ts, cnt, breakLimitMs, breakShowMaxMs) {
  const s = [...new Set(ts)].filter(Boolean).sort((a, b) => a - b);
  if (s.length < 2) return { pph: 0, excludedBreakMinutes: 0, breaks: [] };
  let ms = 0, brk = 0;
  const breaks = [];
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1];
    if (d > 0 && d <= breakLimitMs) ms += d;
    else if (d > breakLimitMs) {
      brk += d / 60000;
      if (d <= breakShowMaxMs) breaks.push({ from: s[i - 1], to: s[i], gap: Math.round(d / 60000) });
    }
  }
  const min = ms / 60000;
  return { pph: min > 0 ? cnt / (min / 60) : 0, excludedBreakMinutes: brk, breaks };
}

// ─── ANALYZE ──────────────────────────────────────────────
function analyze(packages, breakLimitMs, breakShowMaxMs) {
  const stowed = [], errors = [], details = [], trkStow = {}, timestamps = [], dupDetails = [];
  for (const p of packages) {
    if (p.packageEventState === 'STOWED') {
      stowed.push(p);
      trkStow[p.trackingId] = (trkStow[p.trackingId] || 0) + 1;
      if (p.eventTime) timestamps.push(p.eventTime);
    }
    if (isErr(p)) {
      const t = classifyErr(p);
      if (t === null) continue;
      errors.push({ trackingId: p.trackingId, type: t, ref: p.scanLocation || '-' });
      details.push({ tracking: p.trackingId, ref: p.scanLocation || '-', type: t });
    }
  }
  let dupStowed = 0;
  for (const [tid, c] of Object.entries(trkStow)) {
    if (c > 1) { dupStowed += c - 1; dupDetails.push({ tracking: tid, count: c }); }
  }
  let sz = 0, bx = 0, trk = 0;
  for (const e of errors) {
    if (e.type === 'sourceZone') sz++;
    else if (e.type === 'tracking') trk++;
    else bx++;
  }
  const tm = calcTime(timestamps, stowed.length, breakLimitMs, breakShowMaxMs);
  const aisleMap = {};
  for (const p of stowed) {
    const a = clean(p.scanLocation || '').split('-')[0] || '?';
    aisleMap[a] = (aisleMap[a] || 0) + 1;
  }
  return {
    stowed: stowed.length, errors: errors.length,
    sourceZoneErrors: sz, boxErrors: bx, trackingErrors: trk,
    duplicateStowed: dupStowed, duplicateDetails: dupDetails,
    details, aisleBreakdown: aisleMap, ...tm
  };
}

// ─── RUNNER ───────────────────────────────────────────────
async function runQueue(q, sd, ed, cb) {
  const res = {};
  let done = 0;
  const st = getStore();
  const breakLimitMs    = (st.breakExcludeMin || 9) * 60 * 1000;
  const breakShowMaxMs  = (st.breakShowMax    || 30) * 60 * 1000;
  const EMPTY = () => ({
    stowed: 0, errors: 0, sourceZoneErrors: 0, boxErrors: 0, trackingErrors: 0,
    duplicateStowed: 0, duplicateDetails: [], details: [], aisleBreakdown: {},
    pph: 0, excludedBreakMinutes: 0, breaks: [], error: 'REVISAR'
  });
  for (let i = 0; i < q.length; i += MAX_CONCURRENT) {
    await Promise.all(q.slice(i, i + MAX_CONCURRENT).map(async l => {
      try {
        const p = await fetchAllPackages(l, sd, ed);
        res[l] = p.length ? analyze(p, breakLimitMs, breakShowMaxMs) : { ...EMPTY(), reason: 'NO_DATA' };
      } catch (e) {
        try {
          await sleep(1500);
          const p2 = await fetchAllPackages(l, sd, ed);
          res[l] = p2.length ? analyze(p2, breakLimitMs, breakShowMaxMs) : { ...EMPTY(), reason: 'NO_DATA' };
        } catch (e2) { res[l] = { ...EMPTY(), reason: e2.message }; }
      }
      done++;
      if (cb) cb(l, done, q.length);
    }));
    if (!getStore().running) break;
  }
  return res;
}

// ─── STATION / CYCLE ──────────────────────────────────────
function getStation() {
  const m = location.href.match(/stationCode=([A-Z0-9]+)/i);
  if (m) return m[1];
  const sel = document.getElementById('stations');
  return sel?.value || getStore().stationCode || null;
}
function getCycle() {
  const m = (document.body?.innerText || '').match(/CYCLE_\d+/);
  return m ? m[0] : 'CYCLE_1';
}
function captureDates() {
  const d = decodeURIComponent(location.href);
  const a = d.match(/"startDate":(\d+)/), b = d.match(/"endDate":(\d+)/);
  if (a && b) { const s = getStore(); s.startDate = Number(a[1]); s.endDate = Number(b[1]); setStore(s); return; }
  // Auto: 00:00 today → 00:00 tomorrow
  const s = getStore();
  const sod = new Date(); sod.setHours(0,0,0,0);
  const eod = new Date(sod); eod.setDate(eod.getDate() + 1);
  s.startDate = sod.getTime(); s.endDate = eod.getTime();
  setStore(s);
}

async function fetchAAs() {
  const sc = getStation(), cy = getCycle();
  if (!sc) throw new Error('No station.');
  const d = await apiPost({
    resourcePath: 'svs/associates/data', httpMethod: 'post', processName: 'stow',
    requestBody: { filters: { NODE: [sc], CYCLE: [cy] }, fieldsRequired: ['NAME','STATUS','PERFORMANCE','LOCATION'] }
  });
  if (!d?.associates) return [];
  return d.associates
    .map(a => ({ associate: a.alias ? a.alias.split('@')[0] : '', active: (a.status||'').toUpperCase() === 'ACTIVE' }))
    .filter(x => x.associate && /^[a-z][a-z0-9_.-]{2,}$/i.test(x.associate));
}

// ─── REPORTS ──────────────────────────────────────────────
function calcAvgPPH(results) {
  const valid = Object.values(results || {}).filter(r => r.pph >= PPH_MIN_THRESHOLD && r.pph <= PPH_MAX_THRESHOLD);
  if (!valid.length) return 0;
  return valid.reduce((a, r) => a + r.pph, 0) / valid.length;
}
function pphVsAvg(pph, avg) {
  if (!avg || !pph || pph < PPH_MIN_THRESHOLD) return { pct: 0, show: false };
  return { pct: ((pph - avg) / avg) * 100, show: true };
}
function fmtNow() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function buildReport() {
  const s = getStore(), R = s.results || {}, C = s.workerComments || {};
  const rows = (s.associates || []).filter(a => R[a.associate])
    .map(a => ({ login: a.associate, active: a.active, fb: C[a.associate] || '', ...(R[a.associate] || {}) }));
  const t = {
    s:  rows.reduce((a,r) => a + (r.stowed||0), 0),
    e:  rows.reduce((a,r) => a + (r.errors||0), 0),
    sz: rows.reduce((a,r) => a + (r.sourceZoneErrors||0), 0),
    bx: rows.reduce((a,r) => a + (r.boxErrors||0), 0),
    trk:rows.reduce((a,r) => a + (r.trackingErrors||0), 0),
    x2: rows.reduce((a,r) => a + (r.duplicateStowed||0), 0)
  };
  const avg = calcAvgPPH(R);
  const sorted = [...rows].sort((a,b) => (b.errors||0) - (a.errors||0));
  const hdrs = ['ASSOCIATE','ACTIVO','STOWED','FSAF','DPMO','PPH','PPH_VS_AVG%','SZ','CAJA','TRACK','X2','BREAKS_9-30','STATUS','FEEDBACK'].join('\t');
  const xl = sorted.map(r => {
    const vs = pphVsAvg(r.pph, avg);
    return [r.login, r.active?'Y':'N', r.stowed||0, r.errors||0,
      Math.round(calcDpmo(r.errors, r.stowed)), r.pph ? Math.round(r.pph) : '',
      vs.show ? vs.pct.toFixed(1)+'%' : 'N/A',
      r.sourceZoneErrors||0, r.boxErrors||0, r.trackingErrors||0, r.duplicateStowed||0,
      `${(r.breaks||[]).length}p/${Math.round(r.excludedBreakMinutes||0)}min`,
      r.error||'OK', r.fb
    ].join('\t');
  }).join('\n');
  return `📦 STOW AUDIT\n${fmtNow()}\n\nStowed: ${t.s} | FSAF: ${t.e} | DPMO: ${Math.round(calcDpmo(t.e,t.s))} | X2: ${t.x2} | PPH Avg: ${Math.round(avg)}\nSZ: ${t.sz} | Caja: ${t.bx} | Track: ${t.trk}\n\nEXCEL:\n${hdrs}\n${xl}`;
}

function buildMeeting() {
  const s = getStore(), R = s.results || {}, C = s.workerComments || {}, sc = getStation() || 'STA';
  const base = s.showOnlyActive ? (s.associates||[]).filter(a=>a.active) : (s.associates||[]);
  const rows = base.filter(a => R[a.associate] && !R[a.associate].error)
    .map(a => ({ login: a.associate, fb: C[a.associate] || '', ...(R[a.associate]||{}) }));
  const t = {
    s:  rows.reduce((a,r) => a + (r.stowed||0), 0),
    e:  rows.reduce((a,r) => a + (r.errors||0), 0),
    sz: rows.reduce((a,r) => a + (r.sourceZoneErrors||0), 0),
    bx: rows.reduce((a,r) => a + (r.boxErrors||0), 0),
    trk:rows.reduce((a,r) => a + (r.trackingErrors||0), 0)
  };
  const avg = calcAvgPPH(R);
  const top3 = [...rows].sort((a,b) => (b.errors||0) - (a.errors||0)).slice(0,3);
  const now = new Date();
  const ds = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;
  const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  let m = `📋 Reporte FSAF — ${sc} Night Shift\n🕐 ${ds}, ${ts} • CYCLE 1\n\n`;
  m += `📦 Totales\n✅ Stowed: ${t.s}\n❌ FSAF: ${t.e}\n📊 DPMO: ${Math.round(calcDpmo(t.e,t.s))}\n⚡ PPH Medio: ${Math.round(avg)}\nSort Zone: ${t.sz} • Caja: ${t.bx} • Tracking: ${t.trk}\n`;
  m += `\n🔥 Top 3 — Más FSAF\n`;
  top3.forEach((r, i) => {
    const dp = calcDpmo(r.errors, r.stowed);
    const vs = pphVsAvg(r.pph, avg);
    const vsStr = vs.show ? ` (${vs.pct >= 0 ? '+' : ''}${vs.pct.toFixed(0)}% vs media)` : '';
    m += `\n${i+1}. ${r.login}\n⚡ PPH: ${Math.round(r.pph||0)}${vsStr}\n📊 DPMO: ${Math.round(dp)}\n❌ FSAF: ${r.errors}\nSort Zone: ${r.sourceZoneErrors}\nCaja: ${r.boxErrors}\nTracking: ${r.trackingErrors}\n`;
    if (r.fb) m += `💬 ${r.fb}\n`;
  });
  return m;
}

function sendSlack(url, payload) {
  GM_xmlhttpRequest({
    method: 'POST', url,
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ slack_message: payload }),
    onload: r => alert(r.status < 300 ? 'Enviado.' : 'Error ' + r.status),
    onerror: () => alert('Error de red.')
  });
}
function sendR() { const s = getStore(); if (!s.webhookUrl) { alert('Configura WH Report.'); return; } sendSlack(s.webhookUrl, buildReport()); }
function sendM() { const s = getStore(); if (!s.webhookMeetingUrl) { alert('Configura WH Meeting.'); return; } sendSlack(s.webhookMeetingUrl, buildMeeting()); }

// ─── CONFIG MODAL ─────────────────────────────────────────
function showConfig() {
  document.getElementById('pab-cfg-bk')?.remove();
  document.getElementById('pab-cfg-modal')?.remove();
  const s = getStore();
  const bk = document.createElement('div');
  bk.id = 'pab-cfg-bk';
  bk.className = 'pab-backdrop';
  const modal = document.createElement('div');
  modal.id = 'pab-cfg-modal';
  modal.className = 'pab-modal';
  modal.innerHTML = `
  <h3 style="margin:0 0 18px;font-size:15px;color:#94a3b8;font-weight:900">⚙️ Configuración</h3>
  <label class="cfg-label">Webhook Report (Slack)</label>
  <input id="cfg-wh-r" class="cfg-input" value="${esc(s.webhookUrl||'')}">
  <label class="cfg-label">Webhook Meeting (Slack)</label>
  <input id="cfg-wh-m" class="cfg-input" value="${esc(s.webhookMeetingUrl||'')}">
  <label class="cfg-label">Excluir pausas mayores de X min para PPH (defecto: 9)</label>
  <input id="cfg-bex" class="cfg-input" type="number" min="1" value="${s.breakExcludeMin||9}">
  <label class="cfg-label">Mostrar pausas de hasta X min en detalle (defecto: 30)</label>
  <input id="cfg-bsh" class="cfg-input" type="number" min="1" value="${s.breakShowMax||30}">
  <div style="display:flex;gap:8px;margin-top:18px">
    <button id="cfg-save" class="pab-btn-save">Guardar</button>
    <button id="cfg-close" class="pab-btn-cancel">Cerrar</button>
  </div>`;
  bk.onclick = () => { bk.remove(); modal.remove(); };
  const container = document.fullscreenElement || document.body;
  container.appendChild(bk); container.appendChild(modal);
  document.getElementById('cfg-save').onclick = () => {
    const st = getStore();
    st.webhookUrl        = document.getElementById('cfg-wh-r').value.trim();
    st.webhookMeetingUrl = document.getElementById('cfg-wh-m').value.trim();
    st.breakExcludeMin   = Number(document.getElementById('cfg-bex').value) || 9;
    st.breakShowMax      = Number(document.getElementById('cfg-bsh').value) || 30;
    setStore(st); bk.remove(); modal.remove();
    alert('✅ Guardado.');
  };
  document.getElementById('cfg-close').onclick = () => { bk.remove(); modal.remove(); };
}

// ─── INFO MODAL ───────────────────────────────────────────
function showInfo(login) {
  document.getElementById('pab-info-bk')?.remove();
  document.getElementById('pab-info-modal')?.remove();
  const s   = getStore(), r = s.results?.[login];
  const a   = (s.associates||[]).find(x => x.associate === login);
  const avg = calcAvgPPH(s.results||{});
  const vs  = r ? pphVsAvg(r.pph, avg) : { show: false };
  const dpmo = r ? calcDpmo(r.errors, r.stowed) : 0;
  const dpmoColor = dpmo > 5000 ? '#ef4444' : dpmo > 2000 ? '#facc15' : '#22c55e';
  const paired = r?.aisleBreakdown ? pairAisles(r.aisleBreakdown) : [];

  const bk = document.createElement('div');
  bk.id = 'pab-info-bk'; bk.className = 'pab-backdrop';
  const modal = document.createElement('div');
  modal.id = 'pab-info-modal'; modal.className = 'pab-modal pab-modal-wide';

  const vsStr = vs.show
    ? `<span style="font-size:12px;font-weight:900;color:${vs.pct>=0?'#22c55e':'#ef4444'}">(${vs.pct>=0?'+':''}${vs.pct.toFixed(0)}%)</span>`
    : '';

  modal.innerHTML = `
  <button id="pab-info-x" class="pab-modal-close">✕</button>
  <div class="info-header">
    <img class="info-avatar" src="https://internal-cdn.amazon.com/badgephotos.amazon.com/?login=${esc(login)}" onerror="this.style.display='none'">
    <div>
      <div class="info-name">${esc(login)}</div>
      <span class="info-badge" style="background:${a?.active?'#14532d':'#7f1d1d'};color:${a?.active?'#86efac':'#fca5a5'}">${a?.active?'● ACTIVE':'● INACTIVE'}</span>
    </div>
  </div>
  <div class="info-grid">
    <div class="info-stat"><div class="info-stat-label">STOWED</div><div class="info-stat-val">${r?.stowed||0}</div></div>
    <div class="info-stat"><div class="info-stat-label">PPH</div><div class="info-stat-val" style="color:#22c55e">${r?.pph?r.pph.toFixed(0):'-'} ${vsStr}</div></div>
    <div class="info-stat"><div class="info-stat-label">FSAF</div><div class="info-stat-val" style="color:${r?.errors>0?'#ef4444':'#22c55e'}">${r?.errors||0}</div></div>
    <div class="info-stat"><div class="info-stat-label">DPMO</div><div class="info-stat-val" style="color:${dpmoColor}">${Math.round(dpmo)}</div></div>
    <div class="info-stat"><div class="info-stat-label">STOWED X2</div><div class="info-stat-val" style="color:${r?.duplicateStowed>0?'#facc15':'#22c55e'}">${r?.duplicateStowed||0}</div></div>
    <div class="info-stat"><div class="info-stat-label">SZ / BOX / TRK</div><div class="info-stat-val" style="font-size:14px">${r?.sourceZoneErrors||0} / ${r?.boxErrors||0} / ${r?.trackingErrors||0}</div></div>
  </div>
  ${r?.details?.length ? `
  <div class="info-section-title">FSAF Details (${r.details.length})</div>
  <div style="max-height:140px;overflow:auto;border-radius:8px;border:1px solid rgba(255,255,255,.08)">
    <table class="info-table"><thead><tr><th>#</th><th>Tracking</th><th>Ref</th><th>Type</th></tr></thead>
    <tbody>${r.details.slice(0,25).map((d,i)=>`<tr><td>${i+1}</td><td>${esc(d.tracking)}</td><td>${esc(d.ref)}</td><td style="color:${d.type==='sourceZone'?'#60a5fa':d.type==='tracking'?'#facc15':'#f97316'}">${esc(d.type)}</td></tr>`).join('')}</tbody>
    </table>
  </div>` : ''}
  ${r?.duplicateDetails?.length ? `
  <div class="info-section-title">Stowed X2 Details</div>
  <div style="max-height:90px;overflow:auto;border-radius:8px;border:1px solid rgba(255,255,255,.08)">
    <table class="info-table"><thead><tr><th>Tracking</th><th>Veces</th></tr></thead>
    <tbody>${r.duplicateDetails.map(d=>`<tr><td>${esc(d.tracking)}</td><td style="color:#facc15">${d.count}x</td></tr>`).join('')}</tbody>
    </table>
  </div>` : ''}
  ${paired.length ? `
  <div class="info-section-title">Stowed por pasillo</div>
  <div style="display:flex;flex-wrap:wrap;gap:6px">
    ${paired.map(p=>`<span class="aisle-chip"><span style="color:#60a5fa">${esc(p.label)}</span> <span>${p.count}</span></span>`).join('')}
  </div>` : ''}
  ${r?.breaks?.length ? `
  <div class="info-section-title">Pausas ${(s.breakExcludeMin||9)}-${(s.breakShowMax||30)} min</div>
  <div style="font-size:11px;color:#94a3b8;line-height:1.8">
    ${r.breaks.map(b=>`${new Date(b.from).toLocaleTimeString('es')} → ${new Date(b.to).toLocaleTimeString('es')} <b style="color:white">(${b.gap} min)</b>`).join('<br>')}
  </div>` : ''}`;

  bk.onclick = () => { bk.remove(); modal.remove(); };
  const container = document.fullscreenElement || document.body;
  container.appendChild(bk); container.appendChild(modal);
  document.getElementById('pab-info-x').onclick = () => { bk.remove(); modal.remove(); };
}

// ─── SORT ─────────────────────────────────────────────────
function sortAssociates(list, s) {
  if (!s.sortBy) return list;
  return [...list].sort((a, b) => {
    const ra = s.results?.[a.associate] || {}, rb = s.results?.[b.associate] || {};
    const getV = (r, k) => k === 'dpmo' ? calcDpmo(r.errors||0, r.stowed||0) : Number(r[k] || 0);
    const va = s.sortBy === 'associate' ? a.associate : s.sortBy === 'active' ? (a.active?1:0) : getV(ra, s.sortBy);
    const vb = s.sortBy === 'associate' ? b.associate : s.sortBy === 'active' ? (b.active?1:0) : getV(rb, s.sortBy);
    if (typeof va === 'string') return s.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return s.sortDir === 'asc' ? va - vb : vb - va;
  });
}
function sL(k, l, s) {
  return `<th class="sortable" data-s="${k}">${l}${s.sortBy===k?(s.sortDir==='asc'?' ▲':' ▼'):''}</th>`;
}

// ─── CSS ──────────────────────────────────────────────────
function injectCSS() {
  if (document.getElementById('pab-stow-css')) return;
  const style = document.createElement('style');
  style.id = 'pab-stow-css';
  style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');

#${BTN_ID}{
  position:fixed;right:16px;bottom:16px;z-index:2147483647;
  background:linear-gradient(135deg,#ff9900,#e07b00);
  color:#111;border:0;border-radius:12px;padding:10px 18px;
  font-family:'Inter',Arial,sans-serif;font-size:12px;font-weight:900;
  cursor:pointer;box-shadow:0 6px 24px rgba(255,153,0,.4);
  transition:transform .15s,box-shadow .15s;letter-spacing:.3px;
}
#${BTN_ID}:hover{transform:translateY(-2px);box-shadow:0 10px 32px rgba(255,153,0,.55);}

#${PANEL_ID}{
  position:fixed;right:18px;bottom:76px;width:1200px;max-height:80vh;
  overflow:auto;z-index:2147483647;
  background:#080d17;color:white;
  border:1.5px solid rgba(255,153,0,.5);border-radius:18px;
  padding:18px;font-family:'Inter',Arial,sans-serif;
  box-shadow:0 24px 70px rgba(0,0,0,.75);
  scrollbar-width:thin;scrollbar-color:#ff9900 #0f172a;
}
#${PANEL_ID}.fullscreen{
  position:fixed!important;inset:0!important;width:100vw!important;
  max-height:100vh!important;height:100vh!important;
  border-radius:0!important;border:0!important;padding:20px;
  display:flex!important;flex-direction:column!important;overflow:hidden!important;
}
#${PANEL_ID}.fullscreen .fs-scroll{
  flex:1 1 0;overflow-y:auto;overflow-x:auto;
  scrollbar-width:thin;scrollbar-color:#ff9900 #0f172a;
  min-height:0;
}
#${PANEL_ID} .head{
  display:flex;justify-content:space-between;align-items:center;
  margin-bottom:12px;gap:8px;flex-wrap:wrap;
  padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.08);
}
#${PANEL_ID} .title{
  font-size:18px;font-weight:900;
  background:linear-gradient(135deg,#ff9900,#ffd580);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  letter-spacing:-.3px;
}
#${PANEL_ID} .actions{display:flex;flex-wrap:wrap;gap:4px;align-items:center;}
#${PANEL_ID} button{
  border-radius:8px;padding:5px 11px;font-weight:700;cursor:pointer;
  font-size:11px;border:1px solid rgba(255,255,255,.12);
  font-family:'Inter',Arial,sans-serif;transition:all .15s;
  background:#111827;color:#e2e8f0;
}
#${PANEL_ID} button:hover{background:#1e293b;border-color:rgba(255,255,255,.25);}
#${PANEL_ID} .btn-orange{background:linear-gradient(135deg,#b45309,#d97706);color:#fff;border-color:transparent;font-weight:800;}
#${PANEL_ID} .btn-orange:hover{background:linear-gradient(135deg,#92400e,#b45309);}
#${PANEL_ID} .btn-green{background:#14532d;border-color:#22c55e;color:#86efac;}
#${PANEL_ID} .btn-green:hover{background:#166534;}
#${PANEL_ID} .btn-red{background:#7f1d1d;border-color:#ef4444;color:#fca5a5;}
#${PANEL_ID} .btn-red:hover{background:#991b1b;}
#${PANEL_ID} .btn-purple{background:#2e1065;border-color:#7c3aed;color:#c4b5fd;}
#${PANEL_ID} .btn-purple:hover{background:#3b0764;}
#${PANEL_ID} .btn-pink{background:#500724;border-color:#db2777;color:#f9a8d4;}
#${PANEL_ID} .btn-pink:hover{background:#831843;}
#${PANEL_ID} .btn-blue{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;border-color:transparent;padding:6px 14px;}
#${PANEL_ID} .btn-blue:hover{background:linear-gradient(135deg,#1e40af,#3b82f6);}
#${PANEL_ID} .btn-cfg{background:#1e293b;color:#94a3b8;border-color:#334155;}

#${PANEL_ID} .stats-bar{
  background:linear-gradient(135deg,#0f172a,#111827);
  border:1px solid rgba(255,255,255,.07);border-radius:12px;
  padding:10px 14px;margin-bottom:10px;
  display:flex;flex-wrap:wrap;gap:12px;align-items:center;
}
#${PANEL_ID} .stat-chip{display:flex;flex-direction:column;align-items:center;min-width:60px;}
#${PANEL_ID} .stat-chip-label{font-size:8px;text-transform:uppercase;color:#64748b;font-weight:700;letter-spacing:.6px;}
#${PANEL_ID} .stat-chip-val{font-size:16px;font-weight:900;color:white;margin-top:2px;}
#${PANEL_ID} .stat-chip-val.orange{color:#ff9900;}
#${PANEL_ID} .stat-chip-val.red{color:#ef4444;}
#${PANEL_ID} .stat-chip-val.green{color:#22c55e;}
#${PANEL_ID} .stat-divider{width:1px;height:36px;background:rgba(255,255,255,.08);}

#${PANEL_ID} .progress-wrap{margin-bottom:10px;}
#${PANEL_ID} .progress-label{font-size:11px;color:#94a3b8;font-weight:700;margin-bottom:4px;}
#${PANEL_ID} .progress-bar{width:100%;height:7px;background:#1e293b;border-radius:999px;overflow:hidden;}
#${PANEL_ID} .progress-fill{height:100%;background:linear-gradient(90deg,#ff9900,#fbbf24);border-radius:999px;transition:width .35s ease;}

#${PANEL_ID} .search-box{
  background:#0f172a;border:1px solid #334155;color:white;
  border-radius:8px;padding:5px 10px;font-size:12px;
  font-family:'Inter',Arial,sans-serif;width:170px;
}
#${PANEL_ID} .search-box:focus{outline:none;border-color:#ff9900;}

#${PANEL_ID} table{width:100%;border-collapse:collapse;font-size:12px;}
#${PANEL_ID} thead{position:sticky;top:0;z-index:2;background:#080d17;}
#${PANEL_ID}.fullscreen thead{background:#080d17;}
#${PANEL_ID} th{
  text-align:left;color:#475569;font-size:9px;text-transform:uppercase;
  letter-spacing:.6px;border-bottom:1px solid rgba(255,255,255,.08);
  padding:9px 7px;white-space:nowrap;font-weight:700;
}
#${PANEL_ID} th.sortable{cursor:pointer;color:#f59e0b;}
#${PANEL_ID} th.sortable:hover{color:#fde68a;}
#${PANEL_ID} td{
  border-bottom:1px solid rgba(255,255,255,.04);
  padding:8px 7px;vertical-align:middle;color:#e2e8f0;
}
#${PANEL_ID} tbody tr{transition:background .1s;}
#${PANEL_ID} tbody tr:hover{background:rgba(255,255,255,.04);}
#${PANEL_ID} tbody tr.row-risk-high{background:rgba(239,68,68,.06);}
#${PANEL_ID} tbody tr.row-risk-high:hover{background:rgba(239,68,68,.1);}
#${PANEL_ID} tbody tr.row-risk-med{background:rgba(251,191,36,.04);}
#${PANEL_ID} tbody tr.row-risk-med:hover{background:rgba(251,191,36,.08);}
#${PANEL_ID} .c-bad{color:#ef4444;font-weight:800;}
#${PANEL_ID} .c-ok{color:#22c55e;font-weight:700;}
#${PANEL_ID} .c-warn{color:#facc15;font-weight:800;}
#${PANEL_ID} .c-muted{color:#475569;}
#${PANEL_ID} .c-name{color:#60a5fa;font-weight:800;font-size:13px;}
#${PANEL_ID} .aa-avatar{width:28px;height:28px;border-radius:7px;vertical-align:middle;margin-right:7px;border:1px solid #1e293b;}
#${PANEL_ID} .dpmo-pill{
  display:inline-block;padding:2px 8px;border-radius:999px;
  font-size:11px;font-weight:800;
}

/* Modals shared */
.pab-backdrop{position:fixed;inset:0;z-index:2147483648;background:rgba(0,0,0,.65);backdrop-filter:blur(5px);}
.pab-modal{
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  z-index:2147483649;background:#0c1424;
  border:1.5px solid rgba(59,130,246,.5);border-radius:18px;
  padding:22px;min-width:420px;max-width:520px;max-height:82vh;overflow:auto;
  color:white;font-family:'Inter',Arial,sans-serif;
  box-shadow:0 28px 70px rgba(0,0,0,.85);
  scrollbar-width:thin;scrollbar-color:#3b82f6 #0f172a;
}
.pab-modal-wide{min-width:460px;max-width:540px;}
.pab-modal-close{
  position:absolute;top:12px;right:16px;background:none;border:none;
  color:#64748b;font-size:18px;cursor:pointer;font-family:'Inter',Arial,sans-serif;
}
.pab-modal-close:hover{color:white;}

/* Info modal internals */
.info-header{display:flex;align-items:center;gap:14px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,.08);}
.info-avatar{width:62px;height:62px;border-radius:14px;border:2px solid #3b82f6;background:#1e293b;}
.info-name{font-size:18px;font-weight:900;color:#60a5fa;letter-spacing:-.2px;}
.info-badge{font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px;display:inline-block;margin-top:5px;}
.info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;}
.info-stat{background:#111827;border-radius:12px;padding:11px;text-align:center;border:1px solid rgba(255,255,255,.06);}
.info-stat-label{font-size:8px;color:#475569;text-transform:uppercase;font-weight:700;letter-spacing:.5px;}
.info-stat-val{font-size:19px;font-weight:900;margin-top:5px;line-height:1.1;}
.info-section-title{font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:.5px;margin:12px 0 7px;}
.info-table{width:100%;border-collapse:collapse;font-size:11px;}
.info-table th{color:#475569;font-size:8px;text-transform:uppercase;padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left;}
.info-table td{padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.04);color:#e2e8f0;}
.aisle-chip{background:#111827;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:4px 9px;font-size:11px;font-weight:700;}

/* Config modal inputs */
.cfg-label{display:block;font-size:10px;color:#94a3b8;font-weight:700;margin-bottom:4px;letter-spacing:.4px;}
.cfg-input{
  display:block;width:100%;background:#111827;border:1px solid #1e293b;color:white;
  border-radius:9px;padding:8px 11px;margin-bottom:14px;font-size:12px;
  font-family:'Inter',Arial,sans-serif;box-sizing:border-box;
}
.cfg-input:focus{outline:none;border-color:#ff9900;}
.pab-btn-save{flex:1;padding:10px;background:linear-gradient(135deg,#14532d,#22c55e);color:white;border:0;border-radius:10px;font-weight:800;cursor:pointer;font-family:'Inter',Arial,sans-serif;font-size:12px;}
.pab-btn-save:hover{background:linear-gradient(135deg,#166534,#16a34a);}
.pab-btn-cancel{flex:1;padding:10px;background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:10px;font-weight:700;cursor:pointer;font-family:'Inter',Arial,sans-serif;font-size:12px;}
.pab-btn-cancel:hover{background:#334155;}
`;
  document.head.appendChild(style);
}

// ─── PANEL ────────────────────────────────────────────────
function showPanel() {
  injectCSS();
  let p = document.getElementById(PANEL_ID);
  const reuse = !!p;
  if (!p) { p = document.createElement('div'); p.id = PANEL_ID; }

  const s   = getStore();
  const avg = calcAvgPPH(s.results || {});
  const filter = (s.searchFilter || '').toLowerCase();
  let base = s.showOnlyActive ? (s.associates||[]).filter(a => a.active) : (s.associates||[]);
  if (filter) base = base.filter(a => a.associate.toLowerCase().includes(filter));
  const shown = sortAssociates(base, s);

  const tS  = Object.values(s.results||{}).reduce((a,r) => a+(r.stowed||0), 0);
  const tE  = Object.values(s.results||{}).reduce((a,r) => a+(r.errors||0), 0);
  const tX  = Object.values(s.results||{}).reduce((a,r) => a+(r.duplicateStowed||0), 0);
  const tDP = Math.round(calcDpmo(tE, tS));
  const failedLogins = Object.entries(s.results||{}).filter(([,r]) => r.error).map(([l]) => l);

  // Rows
  const rows = shown.map(a => {
    const r    = s.results[a.associate];
    const ck   = s.selected?.[a.associate] ? 'checked' : '';
    const fb   = s.workerComments?.[a.associate];
    const vs   = r ? pphVsAvg(r.pph, avg) : { show: false };
    const dpmo = r ? calcDpmo(r.errors, r.stowed) : 0;
    const dpmoColor = dpmo > 5000 ? '#ef4444' : dpmo > 2000 ? '#facc15' : '#22c55e';
    const dpmoLabel = dpmo > 5000 ? 'red' : dpmo > 2000 ? 'warn' : 'ok';
    const rowClass  = r && r.errors > 4 ? 'row-risk-high' : r && r.errors > 1 ? 'row-risk-med' : '';
    const pphStr = r?.pph
      ? `${r.pph.toFixed(0)} <span style="font-size:10px;font-weight:700;color:${vs.show?(vs.pct>=0?'#22c55e':'#ef4444'):'#475569'}">${vs.show?(vs.pct>=0?'+':'')+vs.pct.toFixed(0)+'%':''}</span>`
      : '-';
    return `<tr class="${rowClass}">
      <td><input type="checkbox" class="pab-ck" data-l="${esc(a.associate)}" ${ck} style="accent-color:#ff9900;transform:scale(1.15)"></td>
      <td class="${a.active?'c-ok':'c-bad'}">${a.active?'✅':'❌'}</td>
      <td class="c-name">
        <img class="aa-avatar" src="https://internal-cdn.amazon.com/badgephotos.amazon.com/?login=${esc(a.associate)}" onerror="this.style.display='none'">
        ${esc(a.associate)}${fb?' 📝':''}
      </td>
      <td>${r ? r.stowed : '<span class="c-muted">-</span>'}</td>
      <td>${r ? pphStr : '<span class="c-muted">-</span>'}</td>
      <td class="${r?.errors>0?'c-bad':'c-ok'}">${r ? r.errors : '<span class="c-muted">-</span>'}</td>
      <td class="${r?.sourceZoneErrors>0?'c-warn':'c-muted'}">${r ? r.sourceZoneErrors : '-'}</td>
      <td class="${r?.boxErrors>0?'c-warn':'c-muted'}">${r ? r.boxErrors : '-'}</td>
      <td class="${r?.trackingErrors>0?'c-warn':'c-muted'}">${r ? r.trackingErrors : '-'}</td>
      <td class="${r?.duplicateStowed>0?'c-warn':'c-muted'}">${r ? r.duplicateStowed : '-'}</td>
      <td>${r && tS ? `<span class="dpmo-pill" style="background:${dpmoColor}22;color:${dpmoColor};border:1px solid ${dpmoColor}44">${Math.round(dpmo)}</span>` : '<span class="c-muted">-</span>'}</td>
      <td class="${r?.error?'c-warn':'c-ok'}">${r ? (r.error||'OK') : '<span class="c-muted">-</span>'}</td>
      <td style="white-space:nowrap">
        <button class="pab-1 btn-orange" data-l="${esc(a.associate)}" style="padding:4px 8px;font-size:10px">▶</button>
        <button class="pab-i" data-l="${esc(a.associate)}" style="padding:4px 8px;font-size:10px">Info</button>
        <button class="pab-pb ${r?.breaks?.length?'btn-red':''}" data-l="${esc(a.associate)}" style="padding:4px 8px;font-size:10px">⏸</button>
        <button class="pab-fb" data-l="${esc(a.associate)}" style="padding:4px 8px;font-size:10px">💬</button>
      </td>
    </tr>`;
  }).join('');

  p.innerHTML = `
  <div class="head">
    <div class="title">📦 Stow Audit Dashboard <span style="font-size:11px;font-weight:600;color:#475569;-webkit-text-fill-color:#475569">v5.2</span></div>
    <div class="actions">
      <input id="z-search" class="search-box" placeholder="🔍 Buscar AA..." value="${esc(s.searchFilter||'')}">
      <button id="z-ref">Actualizar</button>
      <button id="z-act" class="btn-green">Solo activos</button>
      <button id="z-all">Todos</button>
      <button id="z-del" class="btn-red">Borrar lista</button>
      <button id="z-cfg" class="btn-cfg">⚙️</button>
      <button id="z-ra" class="btn-green">▶ Activos</button>
      <button id="z-rt" class="btn-orange">▶ Todos</button>
      ${failedLogins.length ? `<button id="z-rf" class="btn-purple">🔁 Reintentar (${failedLogins.length})</button>` : ''}
      <button id="z-stop" class="btn-red">Stop</button>
      <button id="z-sr" class="btn-pink">Slack Report</button>
      <button id="z-sm" class="btn-pink">Slack Meeting</button>
      <button id="z-exp" class="btn-blue">⛶</button>
      <button id="z-cls">✕</button>
    </div>
  </div>

  <div class="stats-bar">
    <div class="stat-chip"><div class="stat-chip-label">Estado</div><div class="stat-chip-val ${s.running?'orange':''}">${s.running?'⏳':'⏹'}</div></div>
    <div class="stat-divider"></div>
    <div class="stat-chip"><div class="stat-chip-label">AAs</div><div class="stat-chip-val">${(s.associates||[]).length}</div></div>
    <div class="stat-chip"><div class="stat-chip-label">Stowed</div><div class="stat-chip-val green">${tS}</div></div>
    <div class="stat-chip"><div class="stat-chip-label">FSAF</div><div class="stat-chip-val ${tE>0?'red':''}">${tE}</div></div>
    <div class="stat-chip"><div class="stat-chip-label">DPMO</div><div class="stat-chip-val ${tDP>5000?'red':tDP>2000?'orange':''}">${tDP}</div></div>
    <div class="stat-chip"><div class="stat-chip-label">X2</div><div class="stat-chip-val ${tX>0?'orange':''}">${tX}</div></div>
    <div class="stat-chip"><div class="stat-chip-label">PPH avg</div><div class="stat-chip-val green">${Math.round(avg)||'-'}</div></div>
    <div class="stat-divider"></div>
    <div style="font-size:10px;color:#475569;font-weight:700;line-height:1.5">
      <div>Fechas: ${s.startDate&&s.endDate?new Date(s.startDate).toLocaleString('es')+' → '+new Date(s.endDate).toLocaleString('es'):'NO CAPTURADAS'}</div>
      <div>${!getApiKey()?'<span style="color:#ef4444">⚠️ Sin API Key</span>':'<span style="color:#22c55e">✅ API Key OK</span>'}</div>
    </div>
  </div>

  <div class="fs-scroll">
  <div id="z-prog"></div>

  <table>
    <thead><tr>
      <th>✓</th>
      ${sL('active','Act',s)}
      ${sL('associate','Associate',s)}
      ${sL('stowed','Stowed',s)}
      ${sL('pph','PPH',s)}
      ${sL('errors','FSAF',s)}
      ${sL('sourceZoneErrors','SZ',s)}
      ${sL('boxErrors','Caja',s)}
      ${sL('trackingErrors','Track',s)}
      ${sL('duplicateStowed','X2',s)}
      ${sL('dpmo','DPMO',s)}
      <th>Status</th><th>Acción</th>
    </tr></thead>
    <tbody>${shown.length ? rows : '<tr><td colspan="14" style="color:#475569;padding:20px;text-align:center">Pulsa Actualizar para cargar los AAs.</td></tr>'}</tbody>
  </table>
  </div>`;

  if (!reuse) document.body.appendChild(p);

  // Events
  const $ = id => document.getElementById(id);
  $('z-cls').onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(()=>{}); p.remove(); };
  $('z-exp').onclick = () => {
    p.classList.toggle('fullscreen');
    $('z-exp').textContent = p.classList.contains('fullscreen') ? '⊡' : '⛶';
  };
  $('z-cfg').onclick = showConfig;
  $('z-sr').onclick  = sendR;
  $('z-sm').onclick  = sendM;
  $('z-stop').onclick = () => { const st = getStore(); st.running = false; setStore(st); showPanel(); };
  $('z-act').onclick  = () => { const st = getStore(); st.showOnlyActive = true;  setStore(st); showPanel(); };
  $('z-all').onclick  = () => { const st = getStore(); st.showOnlyActive = false; setStore(st); showPanel(); };
  $('z-del').onclick  = () => {
    if (!confirm('¿Borrar lista y resultados?')) return;
    const st = getStore(); st.associates = []; st.results = {}; st.selected = {}; st.running = false; st.workerComments = {};
    setStore(st); showPanel();
  };
  $('z-rt').onclick = () => { const st = getStore(); startRun(st.associates.map(a => a.associate)); };
  $('z-ra').onclick = () => {
    const st = getStore();
    const active = st.associates.filter(a => a.active).map(a => a.associate);
    if (!active.length) { alert('No hay activos.'); return; }
    startRun(active);
  };
  if (failedLogins.length) {
    $('z-rf').onclick = () => startRun(failedLogins);
  }
  $('z-ref').onclick = async () => {
    const btn = $('z-ref');
    btn.textContent = '⏳'; btn.disabled = true;
    try {
      const fresh = await fetchAAs();
      if (!fresh.length) { alert('No se encontraron AAs.'); return; }
      const st = getStore();
      const map = new Map((st.associates||[]).map(a => [a.associate, a]));
      fresh.forEach(a => map.set(a.associate, { ...map.get(a.associate), ...a }));
      st.associates = Array.from(map.values());
      st.stationCode = getStation();
      st.running = false;
      if (!st.results)        st.results = {};
      if (!st.selected)       st.selected = {};
      if (!st.workerComments) st.workerComments = {};
      setStore(st); showPanel();
    } catch (e) { alert('Error: ' + e.message); }
    finally { btn.textContent = 'Actualizar'; btn.disabled = false; }
  };

  // Search with debounce
  $('z-search').oninput = function () {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      const st = getStore(); st.searchFilter = this.value; setStore(st);
      showPanel();
    }, 280);
  };

  // Sort
  p.querySelectorAll('th.sortable').forEach(th => {
    th.onclick = () => {
      const st = getStore(), k = th.dataset.s;
      if (st.sortBy === k) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
      else { st.sortBy = k; st.sortDir = k === 'associate' ? 'asc' : 'desc'; }
      setStore(st); showPanel();
    };
  });

  // Checkboxes
  p.querySelectorAll('.pab-ck').forEach(c => {
    c.onchange = () => { const st = getStore(); if (!st.selected) st.selected = {}; st.selected[c.dataset.l] = c.checked; setStore(st); };
  });

  // Per-row buttons
  p.querySelectorAll('.pab-1').forEach(b => { b.onclick = () => startRun([b.dataset.l]); });
  p.querySelectorAll('.pab-i').forEach(b => { b.onclick = () => showInfo(b.dataset.l); });
  p.querySelectorAll('.pab-pb').forEach(b => {
    b.onclick = () => {
      const st = getStore(), r = st.results?.[b.dataset.l];
      const bex = st.breakExcludeMin || 9, bsh = st.breakShowMax || 30;
      if (!r?.breaks?.length) { alert(`${b.dataset.l}: Sin pausas ${bex}-${bsh} min.`); return; }
      const list = r.breaks.map(br =>
        `${new Date(br.from).toLocaleTimeString('es')} → ${new Date(br.to).toLocaleTimeString('es')} (${br.gap} min)`
      ).join('\n');
      alert(`Pausas ${bex}-${bsh} min — ${b.dataset.l}\n\n${list}\n\nTotal: ${r.breaks.length} pausas`);
    };
  });
  p.querySelectorAll('.pab-fb').forEach(b => {
    b.onclick = () => {
      const st = getStore();
      const v = prompt(`Feedback ${esc(b.dataset.l)}:`, st.workerComments?.[b.dataset.l] || '');
      if (v !== null) {
        if (!st.workerComments) st.workerComments = {};
        st.workerComments[b.dataset.l] = clean(v);
        setStore(st); showPanel();
      }
    };
  });
}

// ─── START RUN ────────────────────────────────────────────
async function startRun(q) {
  const s = getStore();
  if (!s.startDate || !s.endDate) {
    const sod = new Date(); sod.setHours(0,0,0,0);
    const eod = new Date(sod); eod.setDate(eod.getDate() + 1);
    s.startDate = sod.getTime(); s.endDate = eod.getTime(); setStore(s);
  }
  if (!getApiKey()) { alert('No API Key. Navega por SCC primero.'); return; }
  if (!q.length) { alert('No hay AAs.'); return; }
  q.forEach(l => delete s.results[l]);
  s.running = true; setStore(s); showPanel();

  const prog = document.getElementById('z-prog');
  if (prog) prog.innerHTML = `<div class="progress-wrap"><div class="progress-label">⏳ 0 / ${q.length}</div><div class="progress-bar"><div class="progress-fill" id="z-fill" style="width:0%"></div></div></div>`;

  const res = await runQueue(q, s.startDate, s.endDate, (l, d, t) => {
    const fill = document.getElementById('z-fill');
    const label = document.querySelector('#z-prog .progress-label');
    if (fill)  fill.style.width = `${Math.round(d / t * 100)}%`;
    if (label) label.textContent = `⏳ ${d} / ${t} — ${l}`;
  });

  const fin = getStore();
  if (!fin.results) fin.results = {};
  Object.assign(fin.results, res);
  fin.running = false; setStore(fin); showPanel();
  alert('✅ Análisis terminado.');
}

// ─── INIT ─────────────────────────────────────────────────
function createBtn() {
  injectCSS();
  if (document.getElementById(BTN_ID)) return;
  const b = document.createElement('button');
  b.id = BTN_ID; b.textContent = '📦 STOW FSAF';
  b.onclick = showPanel;
  document.body.appendChild(b);
}

if (location.hostname.includes('logistics.amazon')) captureDates();
setInterval(createBtn, 1500);

})();
