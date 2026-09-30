'use strict';
/*
 * 静态站点脚本。数据来自 ./data/*.json（相对路径：GitHub Pages 项目站点在 /<repo>/ 子路径）。
 * 已读状态存 localStorage —— 仅本浏览器，不随站点同步、不跨设备。
 */

const SCHEMA_EXPECTED = 2;
const LS_READ = 'orwatch.read.v2';

let ROSTER = null, ALERTS = [], TIMELINE = [], META = null;
let readSet = new Set();
let tierFilter = null;          // 选中的梯队（如 'T3'），null = 全部
let facet = 'all';
let query = '';
let sortKey = 'score', sortDir = -1;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const arr = (x) => (x == null) ? [] : (Array.isArray(x) ? x : [x]);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const alive = (m) => (m.upstreamCount || 0) > 0;

function ctxText(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}
function ago(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
const hhmm = (iso) => {
  const d = iso ? new Date(iso) : null;
  return (d && !Number.isNaN(d.getTime()))
    ? d.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
    : '—';
};

/* ---- 已读：localStorage ---- */
function loadRead() { try { readSet = new Set(JSON.parse(localStorage.getItem(LS_READ) || '[]')); } catch (e) { readSet = new Set(); } }
function saveRead() { try { localStorage.setItem(LS_READ, JSON.stringify([...readSet])); } catch (e) {} }
const isRead = (id) => readSet.has(id);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1900);
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label + '已复制'); return; }
  catch (e) { /* 回退 */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast(label + '已复制'); } catch (e2) { toast('复制失败'); }
  ta.remove();
}

/* ---- 头 ---- */
function renderHead() {
  const r = ROSTER;
  const ms = arr(r.models);
  const unread = arr(ALERTS.items).filter(a => !isRead(a.id)).length;
  $('#oFree').textContent = r.freeCount;
  $('#oAll').textContent = r.totalModels;
  $('#oAlive').textContent = ms.filter(alive).length;
  $('#oUnread').textContent = unread;
  $('#btnRead').disabled = unread === 0;

  const gen = r.generatedAt || r.checkedAt;
  const ageMs = gen ? Date.now() - new Date(gen).getTime() : 0;
  const stale = ageMs > 6 * 3600e3;
  $('#last').textContent = '巡检 ' + ago(gen);
  $('#age').textContent = stale ? '（已超过 6 小时，巡检可能未在运行）' : '';
  $('#age').style.color = stale ? 'var(--amber)' : '';
  $('#live').className = 'live' + (stale ? ' stale' : '');
}

/* ---- 限流 ---- */
function renderLimits() {
  const L = ROSTER.rateLimits;
  if (!L) { $('#limits').innerHTML = '<div class="foot">尚未取得限流口径。</div>'; return; }
  $('#limits').innerHTML =
    '<div class="grid">'
    + '<div class="cell"><div class="k">每分钟</div><div class="v">' + esc(L.RequestsPerMinute) + '<small>次</small></div></div>'
    + '<div class="cell"><div class="k">未充值账号 / 每天</div><div class="v">' + esc(L.RpdWithoutCredits) + '<small>次</small></div></div>'
    + '<div class="cell"><div class="k">充值满 $' + esc(L.CreditsThreshold) + ' / 每天</div><div class="v">' + esc(L.RpdWithCredits) + '<small>次</small></div></div>'
    + '</div>'
    + '<div class="foot">按账号计：池里有 <b>' + ROSTER.freeCount + '</b> 个零定价模型也不会给 ' + ROSTER.freeCount
    + ' 倍配额 · 核对日期 ' + esc(L.VerifiedOn)
    + ' · <span class="flag">非接口返回</span>，来源 <a href="' + esc(L.SourceUrl) + '" target="_blank" rel="noreferrer">官方文档</a>，政策变动需人工核对</div>';
}

/* ---- 梯队阶梯（记忆点） ---- */
const TIERS = [
  { code:'T1', label:'顶尖 · 闭源旗舰档', pct:'≥ 95 分位' },
  { code:'T2', label:'强 · 旗舰主力档',   pct:'80–95' },
  { code:'T3', label:'中上 · 次旗舰档',   pct:'60–80' },
  { code:'T4', label:'中 · 轻量旗舰档',   pct:'40–60' },
  { code:'T5', label:'入门 · 小模型档',   pct:'< 40' },
  { code:'?',  label:'无基准数据',        pct:'三个指数全缺' },
];

function renderLadder() {
  const ms = arr(ROSTER.models);
  const box = $('#ladder');
  const used = new Set(ms.map(m => m.tier || '?'));
  const top = TIERS.find(t => used.has(t.code));
  box.innerHTML = TIERS.map(function (t) {
    const list = ms.filter(m => (m.tier || '?') === t.code);
    if (!list.length) {
      // 空档保留在阶梯里：一眼看出这个池子的天花板在哪，但压成细条
      return '<div class="rung empty-rung" data-tier="' + t.code + '">'
        + '<div class="mark"><span class="code">' + t.code + '</span>'
        + '<span class="label">' + t.label + '</span>'
        + '<span class="pct">— 暂无模型 · ' + t.pct + '</span></div>'
        + '<div class="body"></div></div>';
    }
    const chips = list.map(function (m) {
      const cls = !alive(m) ? 'dead' : (m.score >= 55 ? 't-hi' : (m.score < 30 ? 't-lo' : ''));
      const w = Math.max(6, Math.min(100, Number(m.score) || 0));
      return '<button class="chip ' + cls + '" onclick="detail(\'' + String(m.id).replace(/'/g, "\\'") + '\')">'
        + '<span class="sig"><i style="width:' + w + '%"></i></span>' + esc(m.id) + '</button>';
    }).join('');
    return '<div class="rung' + (tierFilter === t.code ? ' on' : '') + '" data-tier="' + t.code + '">'
      + '<div class="mark" onclick="pickTier(\'' + t.code + '\')">'
      +   '<span class="code">' + t.code + '</span>'
      +   '<span class="label">' + t.label + '</span>'
      +   '<span class="pct">' + t.pct + ' · ' + list.length + ' 个</span>'
      + '</div><div class="body">' + chips + '</div></div>';
  }).join('');

  if (top) {
    $('#ladderNote').textContent = '池内最高 ' + top.code + '（' + top.label + '）· 最高分位 ' +
      Math.max.apply(null, ms.filter(m => (m.tier || '?') === top.code).map(m => Number(m.percentile) || 0)) + '%';
  }
}

function pickTier(code) {
  tierFilter = (tierFilter === code) ? null : code;
  $('#btnResetTier').style.display = tierFilter ? '' : 'none';
  renderLadder(); renderGrid();
}

/* ---- 新发现轨道 ---- */
function renderRail() {
  const items = arr(ALERTS.items);
  const unread = items.filter(a => !isRead(a.id)).length;
  $('#railNote').textContent = items.length ? (items.length + ' 条记录 · ' + unread + ' 条未读') : '';
  if (!items.length) { $('#rail').innerHTML = '<div class="empty">还没有任何发现记录。</div>'; return; }
  const byId = {}; arr(ROSTER.models).forEach(m => { byId[m.id] = m; });
  $('#rail').innerHTML = items.map(function (a) {
    const m = byId[a.modelId] || {};
    const read = isRead(a.id);
    return '<article class="arrive' + (read ? ' is-read' : '') + '" onclick="detail(\'' + String(a.modelId).replace(/'/g, "\\'") + '\')">'
      + '<div class="top"><span class="tag">' + (a.type === 'removed' ? '下架' : '新增') + '</span>'
      + (a.kindText ? '<span class="kind">' + esc(a.kindText) + '</span>' : '')
      + '<span class="when">' + hhmm(a.at) + '</span></div>'
      + '<div class="id">' + esc(a.modelId) + '</div>'
      + '<div class="facts">'
      +   (a.tier ? '<span>' + esc(a.tier) + (a.tierText ? ' ' + esc(a.tierText) : '') + '</span>' : '')
      +   (a.contextText ? '<span>' + esc(a.contextText) + (a.nominalText && a.nominalText !== a.contextText ? ' ▼' : '') + '</span>' : '')
      +   (m.uptime1d != null ? '<span>' + m.uptime1d + '%</span>' : '')
      +   (m.upstreamCount != null ? '<span>' + m.upstreamCount + ' 上游</span>' : '')
      + '</div>'
      + '<div class="rd" onclick="event.stopPropagation();toggleRead(\'' + String(a.id).replace(/'/g, "\\'") + '\')">'
      + (read ? '✓ 已读' : '标记已读') + '</div>'
      + '</article>';
  }).join('');
}

function toggleRead(id) {
  if (isRead(id)) readSet.delete(id); else readSet.add(id);
  saveRead(); renderHead(); renderRail(); renderGrid();
  toast(isRead(id) ? '已标记为已读' : '已标记为未读');
}

/* ---- 清单 ---- */
function visibleModels() {
  const q = query.trim().toLowerCase();
  let ms = arr(ROSTER.models);
  if (tierFilter) ms = ms.filter(m => (m.tier || '?') === tierFilter);
  if (facet === 'alive') ms = ms.filter(alive);
  else if (facet === 'dead') ms = ms.filter(m => !alive(m));
  else if (facet === 'new') {
    const ids = new Set(arr(ALERTS.items).map(a => a.modelId));
    ms = ms.filter(m => ids.has(m.id));
  } else if (facet === 'shrink') ms = ms.filter(m => m.contextShrunk);
  if (q) {
    ms = ms.filter(m => (m.id + ' ' + (m.name || '') + ' ' + arr(m.tags).join(' ') + ' ' + arr(m.providers).join(' ')).toLowerCase().indexOf(q) >= 0);
  }
  const get = {
    score: m => m.score, effectiveContext: m => m.effectiveContext,
    percentile: m => m.percentile, uptime1d: m => m.uptime1d, id: m => m.id
  }[sortKey] || (m => m.score);
  ms = ms.slice().sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') return sortDir * x.localeCompare(y);
    return sortDir * (x - y);
  });
  return ms;
}

function tagCls(t) {
  if (t === '无可用上游') return 'bad';
  if (['实际仅', '单上游', '可用性偏低'].indexOf(t) >= 0) return 'warn';
  if (['百万上下文', '标称百万上下文', '长上下文', '标称长上下文', '实际长上下文', '编程向', '图片输入'].indexOf(t) >= 0) return 'good';
  return '';
}

function renderGrid() {
  const ms = visibleModels();
  const shown = new Set(ms.map(m => m.id));
  $('#gridNote').textContent = '显示 ' + ms.length + ' / ' + arr(ROSTER.models).length + ' 个';
  if (!ms.length) { $('#grid').innerHTML = '<div class="empty">没有匹配的模型。换个筛选条件试试。</div>'; return; }
  $('#grid').innerHTML = ms.map(function (m) {
    const act = m.upstreamCount || 0;
    const peers = arr(m.peerModels);
    const minC = (m.endpoints && m.endpoints.minContext) || 0;
    const ctxRange = (minC > 0 && minC < m.effectiveContext)
      ? ctxText(minC) + '~' + ctxText(m.effectiveContext) : m.contextText;
    const w = Math.max(4, Math.min(100, Number(m.score) || 0));
    const tags = arr(m.tags).slice(0, 6).map(t => '<span class="' + tagCls(t) + '">' + esc(t) + '</span>').join('');
    return '<article class="cell" onclick="detail(\'' + String(m.id).replace(/'/g, "\\'") + '\')">'
      + '<div class="r1"><span class="id">' + esc(m.id) + '</span>'
      + '<span class="score' + (m.score >= 55 ? ' hi' : '') + '">' + esc(m.score) + '</span></div>'
      + '<div class="r2">'
      +   (m.tier ? '<span class="tier' + (m.tier === 'T1' || m.tier === 'T2' ? ' up' : '') + '">' + esc(m.tier) + (m.tierBasisLabel ? '·' + esc(m.tierBasisLabel) : '') + '</span>' : '')
      +   '<span class="kind">' + esc(m.kindText || '') + '</span>'
      +   '<span class="sigwrap"><i class="' + (m.score >= 55 ? 'hi' : '') + '" style="width:' + w + '%"></i></span>'
      + '</div>'
      + '<div class="r3">'
      +   '<span class="' + (m.contextShrunk ? 'shrink' : '') + '">上下文 <b>' + esc(ctxRange) + '</b>' + (m.contextShrunk ? ' ▼' : '') + '</span>'
      +   '<span class="' + (act === 0 ? 'dead' : '') + '">' + act + ' 上游' + '</span>'
      +   (m.uptime1d != null ? '<span>' + m.uptime1d + '%</span>' : '')
      +   (m.maxOutputTokens ? '<span>出 ' + ctxText(m.maxOutputTokens) + '</span>' : '')
      + '</div>'
      + (peers.length ? '<div class="peer">≈ ' + esc(peers.join(' / ')) + '</div>' : '')
      + (tags ? '<div class="tags">' + tags + '</div>' : '')
      + '</article>';
  }).join('');
}

/* ---- 时间线 ---- */
function renderTimeline() {
  const ev = arr(TIMELINE.items);
  $('#tlNote').textContent = ev.length ? ('最近 ' + ev.length + ' 条') : '';
  $('#timeline').innerHTML = ev.length
    ? ev.map(e => '<div class="ev ' + esc(e.type) + '"><span class="at">' + hhmm(e.at) + '</span>'
        + '<span class="what">' + (e.type === 'removed' ? '下架' : '新增') + '</span>'
        + '<span class="mid">' + esc(e.modelId) + '</span></div>').join('')
    : '<div class="empty">暂无变更记录。</div>';
}

/* ---- 明细 ---- */
function opencodeSnippet(m) {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { openrouter: {
      npm: '@ai-sdk/openai-compatible', name: 'OpenRouter (零定价)',
      options: { baseURL: 'https://openrouter.ai/api/v1', apiKey: '{env:OPENROUTER_API_KEY}' },
      models: { [m.id]: { name: String(m.name || '').replace(/\s*\(free\)\s*$/i, ''),
                          limit: { context: m.effectiveContext, output: m.maxOutputTokens || 8192 } } }
    } }
  }, null, 2);
}

function detail(id) {
  const m = arr(ROSTER.models).find(x => x.id === id);
  if (!m) { toast('当前清单里没有这个模型（可能已不再零定价）'); return; }
  const e = m.endpoints || {};
  const peers = arr(m.peerModels);
  const rows = [
    ['名称', esc(m.name)],
    ['类型', esc(m.kindText)],
    ['梯队', '<b>' + esc((m.tier || '?') + ' ' + (m.tierText || '')) + '</b>'
      + (m.tierBasisLabel ? '（按' + esc(m.tierBasisLabel) + '指数，全站分位 ' + m.percentile + '%）' : '（无基准数据）')],
    ['同档参考', peers.length ? esc(peers.join(' / ')) : '—'],
    ['关注度', '<b>' + esc(m.score) + '</b>'],
    ['实际上下文', '<b>' + esc(m.contextText) + '</b>' + (m.contextShrunk ? '　⚠ 标称 ' + esc(m.nominalText) + ' 高于实际上游' : '')],
    ['最大输出', m.maxOutputTokens ? ctxText(m.maxOutputTokens) : '—'],
    ['输入模态', arr(m.inputModalities).join('、') || '—'],
    ['推理档位', arr(m.reasoningEfforts).join(' / ') || '—'],
    ['工具调用', m.supportsTools ? '支持' : '不支持'],
    ['活跃上游', (m.upstreamCount || 0) + ' 个' + (arr(m.providers).length ? '：' + esc(arr(m.providers).join('、')) : '')
      + ((m.upstreamCount || 0) === 0 ? '　<b style="color:var(--red)">当前调不通</b>' : '')],
    ['量化格式', arr(m.quantizations).join('、') || '—'],
    ['可用性', (m.uptime1d != null ? '1日 ' + m.uptime1d + '%' : '—') + (m.uptime30m != null ? ' · 30分 ' + m.uptime30m + '%' : '')],
    ['隐式缓存', m.implicitCaching ? '支持（命中部分不计费 / 更快）' : '不支持'],
    ['模型上线', esc(m.modelCreatedAt || '—')],
  ];
  $('#dlgTitle').textContent = m.id;
  $('#dlgBody').innerHTML =
    '<dl class="dgrid">' + rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>'
    + '<pre id="code">' + esc(opencodeSnippet(m)) + '</pre>'
    + '<div class="dlg-act"><button class="mini" id="btnCopyOne">复制该模型配置</button>'
    + '<button class="mini" id="btnCopyId">复制模型 ID</button></div>';
  $('#btnCopyOne').onclick = () => copy($('#code').textContent, '配置片段');
  $('#btnCopyId').onclick = () => copy(m.id, '模型 ID');
  $('#dlg').showModal();
}

function buildConfig() {
  const picked = arr(ROSTER.models).filter(alive).sort((a, b) => b.score - a.score).slice(0, 8);
  const mm = {};
  picked.forEach(m => {
    mm[m.id] = { name: String(m.name || '').replace(/\s*\(free\)\s*$/i, '') };
    if (m.effectiveContext) mm[m.id].limit = { context: m.effectiveContext, output: m.maxOutputTokens || 8192 };
  });
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { openrouter: {
      npm: '@ai-sdk/openai-compatible', name: 'OpenRouter (零定价)',
      options: { baseURL: 'https://openrouter.ai/api/v1', apiKey: '{env:OPENROUTER_API_KEY}' },
      models: mm
    } }
  }, null, 2);
}

function showConfig() {
  const ids = arr(ROSTER.models).filter(alive).map(m => m.id).slice(0, 8);
  $('#dlgTitle').textContent = 'opencode.json 片段';
  $('#dlgBody').innerHTML =
    '<pre id="code">' + esc(buildConfig()) + '</pre>'
    + '<div class="dlg-act"><button class="mini" id="btnCopyAll">复制</button></div>'
    + '<p class="legend" style="margin-top:14px;padding:12px 14px">已收录 <b>' + ids.length
    + '</b> 个有可用上游的模型，按关注度取前 8。API Key 从环境变量 <code>OPENROUTER_API_KEY</code> 读取。</p>';
  $('#btnCopyAll').onclick = () => copy($('#code').textContent, '配置片段');
  $('#dlg').showModal();
}

/* ---- 渲染总入口 ---- */
function render() {
  if (!ROSTER) return;
  const bits = [];
  if (ROSTER.schemaVersion != null && ROSTER.schemaVersion !== SCHEMA_EXPECTED) {
    bits.push('<b>数据结构不一致</b>：数据为 v' + ROSTER.schemaVersion + '，页面期望 v' + SCHEMA_EXPECTED + '，部分内容可能显示不全。');
  }
  if (location.protocol === 'file:') {
    bits.push('<b>当前是用 file:// 打开的</b>，浏览器会因 CORS 拒绝读取本地 JSON。请通过 HTTP 访问（部署后的网址，或本地起 <code>node scripts\\serve-openrouter-site.mjs</code>）。');
  }
  if (META && META.note) bits.push(esc(META.note));
  $('#noticeBox').innerHTML = bits.length ? '<div class="notice">' + bits.join('<br>') + '</div>' : '';

  renderHead();
  renderLimits();
  renderLadder();
  renderRail();
  renderGrid();
  renderTimeline();
}

async function load() {
  try {
    const [r, a, t, m] = await Promise.all([
      fetch('./data/roster.json', { cache: 'no-cache' }),
      fetch('./data/alerts.json', { cache: 'no-cache' }),
      fetch('./data/timeline.json', { cache: 'no-cache' }),
      fetch('./data/meta.json', { cache: 'no-cache' }),
    ]);
    if (!r.ok) throw new Error('roster.json HTTP ' + r.status);
    ROSTER = await r.json();
    ALERTS = a.ok ? await a.json() : { items: [] };
    TIMELINE = t.ok ? await t.json() : { items: [] };
    META = m.ok ? await m.json() : null;
    render();
  } catch (e) {
    $('#last').textContent = '数据加载失败：' + e.message;
    $('#live').className = 'live dead';
  }
}

window.detail = detail;
window.toggleRead = toggleRead;
window.pickTier = pickTier;

document.addEventListener('DOMContentLoaded', function () {
  loadRead();
  $('#btnClose') && ($('#btnClose').onclick = () => $('#dlg').close());
  $('#dlg').addEventListener('click', function (ev) { if (ev.target === $('#dlg')) $('#dlg').close(); });
  $('#btnCfg').onclick = showConfig;
  $('#btnRead').onclick = function () {
    arr(ALERTS.items).forEach(a => readSet.add(a.id));
    saveRead(); renderHead(); renderRail(); renderGrid();
    toast('已全部标记为已读（仅本浏览器）');
  };
  $('#btnResetTier').onclick = function () { tierFilter = null; $('#btnResetTier').style.display = 'none'; renderLadder(); renderGrid(); };
  $('#btnResetTier').style.display = 'none';

  $('#q').addEventListener('input', function (ev) { query = ev.target.value; renderGrid(); });
  $$('#seg button').forEach(function (b) {
    b.onclick = function () {
      $$('#seg button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); facet = b.dataset.f; renderGrid();
    };
  });
  $$('#sortSeg button').forEach(function (b) {
    b.onclick = function () {
      $$('#sortSeg button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      sortKey = b.dataset.k; sortDir = -1; renderGrid();
    };
  });

  load();
  setInterval(load, 60000);
});
