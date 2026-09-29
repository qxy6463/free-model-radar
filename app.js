'use strict';
/*
 * 静态站点版本。相对本地面板（scripts/openrouter-watch-panel.*）的差别只有三处：
 *   1. 数据来自 ./data/*.json 而不是本机 API；
 *   2. 已读状态存 localStorage 而不是回写服务端；
 *   3. 没有「立即巡检」——静态页无后端，巡检由本机计划任务负责。
 * 页面逻辑（打分展示、梯队、明细弹窗、opencode 片段）与本地面板保持一致。
 *
 * 所有资源与数据都用相对路径：GitHub Pages 的项目站点挂在 /<repo>/ 子路径下，
 * 用绝对路径会 404。
 */

let ROSTER = null, ALERTS = [], META = null, TIMELINE = [];
let sortKey = 'score', sortDir = -1;
let readSet = new Set();

const SCHEMA_EXPECTED = 2;
const LS_KEY = 'orwatch.read.v1';   // v1 = 以 alert.id 为键

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// PowerShell ConvertTo-Json 会把单元素数组序列化成标量字符串，消费端统一归一化。
const arr = (x) => (x == null) ? [] : (Array.isArray(x) ? x : [x]);

function ctxText(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1900);
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label + '已复制'); return; }
  catch (e) { /* 继续走 execCommand 回退 */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast(label + '已复制'); }
  catch (e2) { toast('复制失败，请手动选取'); }
  ta.remove();
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
function hhmm(iso) {
  const d = iso ? new Date(iso) : null;
  return (d && !Number.isNaN(d.getTime()))
    ? d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
}

/* ---- 已读：localStorage，仅本浏览器 ---------------------------------------- */
function loadRead() {
  try { readSet = new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); }
  catch (e) { readSet = new Set(); }
}
function saveRead() {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...readSet])); } catch (e) { /* 隐私模式下写不了，忽略 */ }
}
const isRead = (id) => readSet.has(id);

/* ---- 展示组件 -------------------------------------------------------------- */
function scoreCell(m) {
  const w = Math.max(3, Math.min(100, Number(m.score) || 0));
  return '<div class="score"><div class="bar"><i class="' + (m.score >= 55 ? 'hi' : '') +
         '" style="width:' + w + '%"></i></div><span class="sc-n">' + esc(m.score) + '</span></div>';
}
function tierCell(m) {
  const c = String(m.tier || '').toLowerCase();
  const cls = c.indexOf('t') === 0 ? c : 'none';
  const title = esc(m.tierText || '') + (m.tierBasisLabel ? '（按' + esc(m.tierBasisLabel) + '指数的全站分位数）' : '');
  return '<span class="tier ' + cls + '" title="' + title + '">' + esc(m.tier || '?') +
         (m.tierBasisLabel ? '·' + esc(m.tierBasisLabel) : '') + '</span>';
}
function tagClass(t) {
  if (t === '无可用上游') return 'dead';
  if (['实际仅', '单上游', '可用性偏低'].indexOf(t) >= 0) return 'risk';
  if (['百万上下文', '标称百万上下文', '长上下文', '标称长上下文', '实际长上下文', '编程向', '图片输入'].indexOf(t) >= 0) return 'k';
  return '';
}
function tagChips(m) { return arr(m.tags).map(t => '<span class="tag ' + tagClass(t) + '">' + esc(t) + '</span>').join(''); }

function renderNotice() {
  const bits = [];
  if (ROSTER && ROSTER.schemaVersion != null && ROSTER.schemaVersion !== SCHEMA_EXPECTED) {
    bits.push('<b>数据结构不一致</b>：数据为 v' + ROSTER.schemaVersion + '，页面期望 v' + SCHEMA_EXPECTED +
              '，部分内容可能显示不全。');
  }
  if (location.protocol === 'file:') {
    bits.push('<b>当前是用 file:// 打开的</b>，浏览器会因 CORS 拒绝读取本地 JSON。请用 HTTP 打开' +
              '（例如本机 `node scripts\\openrouter-watch-panel.mjs` 之类的静态服务，或直接访问已部署的网址）。');
  }
  if (META && META.note) bits.push(esc(META.note));
  if (!bits.length) { $('#secNotice').style.display = 'none'; return; }
  $('#secNotice').style.display = '';
  $('#notice').innerHTML = bits.join('<br>');
}

function renderLimits() {
  const L = ROSTER && ROSTER.rateLimits;
  if (!L) { $('#lim').innerHTML = '<div class="meta">尚未取得限流口径。</div>'; return; }
  $('#lim').innerHTML =
    '<h3>每分钟 / 每天请求数上限</h3>'
    + '<div class="kv">'
    +   '<div><b>' + esc(L.RequestsPerMinute) + '</b> 次 / 分钟</div>'
    +   '<div>未充值账号 <b>' + esc(L.RpdWithoutCredits) + '</b> 次 / 天</div>'
    +   '<div>累计充值满 <b>&#36;' + esc(L.CreditsThreshold) + '</b> 后 <b>' + esc(L.RpdWithCredits) + '</b> 次 / 天</div>'
    + '</div>'
    + '<div class="note">按账号计：池里有 ' + ROSTER.freeCount + ' 个零定价模型也不会给 ' + ROSTER.freeCount
    + ' 倍配额 · 核对日期 ' + esc(L.VerifiedOn) + ' · <span style="color:var(--warn)">非接口返回</span>，来源 '
    + '<a href="' + esc(L.SourceUrl) + '" target="_blank" rel="noreferrer">官方文档</a>，政策变动需人工核对</div>';
}

function renderAlerts() {
  const box = $('#alerts');
  const list = arr(ALERTS && ALERTS.items);
  const unread = list.filter(a => !isRead(a.id)).length;
  $('#sUnread').textContent = unread;
  $('#sUnreadBox').style.display = unread ? '' : 'none';
  $('#alertCount').textContent = list.length ? (list.length + ' 条（' + unread + ' 条未读）') : '';
  $('#btnRead').disabled = unread === 0;
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有任何发现记录。</div>';
    return;
  }
  const byId = {};
  arr(ROSTER && ROSTER.models).forEach(m => { byId[m.id] = m; });

  box.innerHTML = list.map(function (a) {
    const m = byId[a.modelId] || {};
    const read = isRead(a.id);
    const up = m.uptime1d;
    const shrunk = a.nominalText && a.contextText && a.nominalText !== a.contextText;
    const qs = "'" + String(a.id).replace(/'/g, "\\'") + "'";
    let h = '<div class="card ' + (read ? 'read' : 'unread') + ' ' + (a.type === 'removed' ? 'removed' : '') + '">';
    h += '<div class="row1">';
    h += '<span class="badge ' + (a.type === 'removed' ? 'gone' : 'new') + '">' + (a.type === 'removed' ? '已下架' : '新增') + '</span>';
    if (a.kindText) h += '<span class="badge kind">' + esc(a.kindText) + '</span>';
    h += '<span class="mid mono copy" onclick="detailById(' + qs + ')" title="点击看明细">' + esc(a.modelId) + '</span>';
    if (a.type !== 'removed') h += tierCell(m) + scoreCell(m);
    if (read) h += '<span class="badge seen">已读</span>';
    h += '<div class="acts">';
    h += '<button class="tiny" onclick="copy(' + "'" + String(a.modelId).replace(/'/g, "\\'") + "'" + ',\'模型 ID\')">复制 ID</button>';
    h += '<button class="tiny" onclick="markRead(' + qs + ')">' + (read ? '标为未读' : '标记已读') + '</button>';
    h += '</div></div>';
    h += '<div class="meta">';
    h += '<span>发现于 ' + hhmm(a.at) + '（' + ago(a.at) + '）</span>';
    if (a.contextText) h += '<span>实际上下文 ' + esc(a.contextText) + (shrunk ? '（标称 ' + esc(a.nominalText) + '）' : '') + '</span>';
    if (m.modelCreatedAt) h += '<span>模型上线 ' + esc(m.modelCreatedAt) + '</span>';
    if (up != null) h += '<span>可用性 ' + up + '%</span>';
    if (m.upstreamCount != null) h += '<span>' + m.upstreamCount + ' 个上游</span>';
    h += '</div>';
    const tags = arr(a.tags);
    if (tags.length) h += '<div class="tags">' + tags.map(t => '<span class="tag ' + tagClass(t) + '">' + esc(t) + '</span>').join('') + '</div>';
    h += '</div>';
    return h;
  }).join('');
}

function sortModels() {
  const accessors = {
    score: m => m.score, tier: m => m.tier || 'zz', id: m => m.id,
    effc: m => m.effectiveContext, nomc: m => m.nominalContext,
    act: m => m.upstreamCount, up: m => m.uptime1d, peer: m => arr(m.peerModels).join(' ')
  };
  const get = accessors[sortKey] || accessors.score;
  return arr(ROSTER && ROSTER.models).slice().sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') return sortDir * x.localeCompare(y);
    return sortDir * (x - y);
  });
}

function renderRows() {
  const qs = (s) => "'" + String(s).replace(/'/g, "\\'") + "'";
  const models = sortModels();
  if (!models.length) { $('#rows').innerHTML = '<tr><td colspan="10" class="err">没有数据</td></tr>'; return; }
  $('#rows').innerHTML = models.map(function (m) {
    const up = m.uptime1d, act = m.upstreamCount || 0;
    const upCls = up == null ? 'up-no' : (up >= 99 ? 'up-ok' : (up >= 97 ? 'up-mid' : 'up-no'));
    const peers = arr(m.peerModels);
    return '<tr class="' + (act === 0 ? 'dead' : '') + '">'
      + '<td class="num">' + scoreCell(m) + '</td>'
      + '<td class="num">' + tierCell(m) + '</td>'
      + '<td><span class="mono copy" onclick="detailById(' + qs(m.id) + ')" title="点击看明细">' + esc(m.id) + '</span></td>'
      + '<td class="num ' + (m.contextShrunk ? 'ctx-shrink' : '') + '">' + esc(m.contextText)
        + (m.contextShrunk ? ' <span title="标称 ' + esc(m.nominalText) + '，实际可用更低">▼</span>' : '') + '</td>'
      + '<td class="num" style="color:var(--fg-mute)">' + esc(m.nominalText) + '</td>'
      + '<td class="num ' + (act === 0 ? '' : 'up-ok') + '">' + (act === 0 ? '<span style="color:var(--bad)">0</span>' : act) + '</td>'
      + '<td class="num ' + upCls + '">' + (up == null ? '?' : up + '%') + '</td>'
      + '<td class="num" style="color:var(--fg-dim);font-size:11.5px">'
        + (peers.length ? esc(peers.join(' / ')) : '<span style="color:var(--fg-mute)">—</span>') + '</td>'
      + '<td><div class="tags" style="margin:0">' + tagChips(m) + '</div></td>'
      + '<td class="num"><button class="tiny" onclick="copy(' + qs(m.id) + ',\'模型 ID\')">复制</button></td>'
      + '</tr>';
  }).join('');

  $('#sFree').textContent = ROSTER.freeCount;
  $('#sTotal').textContent = ROSTER.totalModels;
  $('#sAlive').textContent = models.filter(m => (m.upstreamCount || 0) > 0).length;
}

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

function detail(m) {
  if (!m) { toast('当前数据里没有这个模型'); return; }
  const peers = arr(m.peerModels);
  const rows = [
    ['名称', esc(m.name)],
    ['类型', esc(m.kindText)],
    ['梯队', esc((m.tier || '?') + ' ' + (m.tierText || '')) + (m.tierBasisLabel ? '（按' + esc(m.tierBasisLabel) + '指数，全站分位 ' + m.percentile + '%）' : '（无基准数据）')],
    ['同档参考', peers.length ? esc(peers.join(' / ')) : '—'],
    ['关注度', esc(m.score)],
    ['实际上下文', esc(m.contextText) + (m.contextShrunk ? '　⚠ 标称 ' + esc(m.nominalText) + ' 高于实际上游' : '')],
    ['最大输出', m.maxOutputTokens ? ctxText(m.maxOutputTokens) : '—'],
    ['输入模态', arr(m.inputModalities).join('、') || '—'],
    ['推理档位', arr(m.reasoningEfforts).join(' / ') || '—'],
    ['工具调用', m.supportsTools ? '支持' : '不支持'],
    ['活跃上游', (m.upstreamCount || 0) + ' 个' + (arr(m.providers).length ? '：' + esc(arr(m.providers).join('、')) : '')],
    ['量化格式', arr(m.quantizations).join('、') || '—'],
    ['可用性 1日', m.uptime1d != null ? m.uptime1d + '%' : '—'],
    ['可用性 30分', m.uptime30m != null ? m.uptime30m + '%' : '—'],
    ['隐式缓存', m.implicitCaching ? '支持（命中部分不计费 / 更快）' : '不支持'],
    ['模型上线', esc(m.modelCreatedAt || '—')],
  ];
  $('#dlgTitle').textContent = m.id;
  $('#dlgBody').innerHTML =
    '<dl class="dgrid">' + rows.map(p => '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>').join('') + '</dl>'
    + '<pre id="code" class="mono">' + esc(opencodeSnippet(m)) + '</pre>'
    + '<div style="margin-top:12px"><button id="btnCopyCode" class="primary">复制这个模型的配置</button></div>'
    + '<p class="hint">存为项目下的 <code>opencode.json</code>；API Key 从环境变量 <code>OPENROUTER_API_KEY</code> 读取。</p>';
  $('#btnCopyCode').onclick = function () { copy($('#code').textContent, '配置片段'); };
  $('#dlg').showModal();
}
function detailById(id) {
  const m = arr(ROSTER && ROSTER.models).find(x => x.id === id);
  if (m) detail(m);
  else toast('当前数据里没有这个模型（可能已不再零定价）');
}

function markRead(id) {
  if (isRead(id)) readSet.delete(id); else readSet.add(id);
  saveRead();
  renderAlerts();
  toast(isRead(id) ? '已标记为已读' : '已标记为未读');
}

function buildConfig() {
  const picked = arr(ROSTER && ROSTER.models)
    .filter(m => (m.upstreamCount || 0) > 0)
    .sort((a, b) => b.score - a.score).slice(0, 8);
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

function renderTimeline() {
  const ev = arr(TIMELINE && TIMELINE.items);
  $('#tlCount').textContent = ev.length ? ('最近 ' + ev.length + ' 条') : '';
  $('#timeline').innerHTML = ev.length
    ? ev.map(e => '<div class="tl-item ' + esc(e.type) + '"><span class="tl-t">' + hhmm(e.at) + '</span>'
        + '<span class="badge ' + (e.type === 'removed' ? 'gone' : 'new') + '">' + (e.type === 'removed' ? '下架' : '新增') + '</span> '
        + '<span class="mono">' + esc(e.modelId) + '</span></div>').join('')
    : '<div class="empty">暂无变更记录。</div>';
}

function render() {
  if (!ROSTER) return;
  renderNotice(); renderLimits(); renderAlerts(); renderRows(); renderTimeline();
  const gen = ROSTER.generatedAt || ROSTER.checkedAt;
  const stale = gen && (Date.now() - new Date(gen).getTime()) > 6 * 3600e3;
  $('#last').textContent = '数据生成于 ' + ago(gen) + (stale ? '（超过 6 小时，可能巡检未在运行）' : '');
  $('#last').style.color = stale ? 'var(--warn)' : '';
}

async function load() {
  try {
    const [r, a, m, tl] = await Promise.all([
      fetch('./data/roster.json', { cache: 'no-cache' }),
      fetch('./data/alerts.json', { cache: 'no-cache' }),
      fetch('./data/meta.json', { cache: 'no-cache' }),
      fetch('./data/timeline.json', { cache: 'no-cache' }),
    ]);
    if (!r.ok) throw new Error('roster.json HTTP ' + r.status);
    ROSTER = await r.json();
    ALERTS = a.ok ? await a.json() : { items: [] };
    META = m.ok ? await m.json() : null;
    TIMELINE = tl.ok ? await tl.json() : { items: [] };
    render();
  } catch (e) {
    $('#last').textContent = '数据加载失败：' + e.message;
    $('#last').style.color = 'var(--bad)';
  }
}

window.detailById = detailById;
window.markRead = markRead;
window.copy = copy;

document.addEventListener('DOMContentLoaded', function () {
  loadRead();
  $('#btnClose').onclick = function () { $('#dlg').close(); };
  $('#btnRead').onclick = function () {
    arr(ALERTS && ALERTS.items).forEach(a => readSet.add(a.id));
    saveRead(); renderAlerts(); toast('已全部标记为已读（仅本浏览器）');
  };
  $('#btnCfg').onclick = function () {
    $('#dlgTitle').textContent = 'opencode.json 片段（仅含有可用上游的模型）';
    $('#dlgBody').innerHTML =
      '<pre id="code" class="mono">' + esc(buildConfig()) + '</pre>'
      + '<div style="margin-top:12px"><button id="btnCopyCode" class="primary">复制</button></div>'
      + '<p class="hint">存为项目下的 <code>opencode.json</code>；API Key 从环境变量 <code>OPENROUTER_API_KEY</code> 读取。</p>';
    $('#btnCopyCode').onclick = function () { copy($('#code').textContent, '配置片段'); };
    $('#dlg').showModal();
  };
  document.querySelectorAll('th[data-k]').forEach(function (th) {
    th.onclick = function () {
      const k = th.dataset.k;
      sortDir = (sortKey === k) ? -sortDir : -1;
      sortKey = k;
      document.querySelectorAll('th[data-k] .arr').forEach(s => s.remove());
      th.insertAdjacentHTML('beforeend', ' <span class="arr">' + (sortDir < 0 ? '▼' : '▲') + '</span>');
      renderRows();
    };
  });
  load();
});
