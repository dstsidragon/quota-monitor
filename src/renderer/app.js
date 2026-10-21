const $ = (sel, root = document) => root.querySelector(sel);
let current = {};
let filter = 'reset';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtCountdown(iso) {
  let ms = new Date(iso) - Date.now();
  if (ms <= 0) return '已到 reset 時間';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d) return `還有 ${d} 天 ${h} 小時`;
  if (h) return `還有 ${h} 小時 ${min} 分`;
  return `還有 ${min} 分`;
}

function fmtAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  if (m < 1440) return `${Math.round(m / 60)} 小時前`;
  return `${Math.round(m / 1440)} 天前`;
}

function barColor(left) {
  if (left <= 10) return 'var(--bad)';
  if (left <= 30) return 'var(--warn)';
  return 'var(--ok)';
}

function renderCard(key) {
  const card = $(`#card-${key}`);
  const s = current[key];
  const wins = $('.windows', card);
  const meta = $('.meta', card);
  $('.plan', card).textContent = (s && s.plan) || '';
  if (!s) {
    wins.innerHTML = '<div class="empty">讀取中…</div>';
    meta.textContent = '';
    return;
  }
  if (s.windows && s.windows.length) {
    wins.innerHTML = s.windows.map((w) => {
      const left = Math.max(0, Math.min(100, 100 - w.usedPercent));
      return `<div class="win">
        <div class="win-top"><span class="left">${Math.round(left)}%<small>剩餘</small></span><span class="label">${esc(w.label)}</span></div>
        <div class="bar"><div data-left="${left}"></div></div>
        <div class="reset">${w.resetsAt ? `reset：${fmtTime(w.resetsAt)}（${fmtCountdown(w.resetsAt)}）` : 'reset 時間未知'}</div>
      </div>`;
    }).join('');
    // CSP 不允許 inline style 屬性，改用 CSSOM 設定
    wins.querySelectorAll('.bar > div').forEach((el) => {
      const left = Number(el.dataset.left);
      el.style.width = `${left}%`;
      el.style.background = barColor(left);
    });
  } else {
    wins.innerHTML = '';
  }
  const parts = [];
  if (s.error) parts.push(s.error);
  if (s.note) parts.push(s.note);
  if (s.source === 'session-log' && s.observedAt) parts.push(`本機紀錄時間：${fmtAgo(s.observedAt)}`);
  if (s.updatedAt) parts.push(`更新於 ${fmtAgo(s.updatedAt)}`);
  meta.textContent = parts.join('　');
  meta.classList.toggle('error', Boolean(s.error || s.note));
  if (key === 'claude') {
    $('.login-row', card).hidden = !['web-login', 'no-login'].includes(s.errorKind) || s.ok;
    $('.logout-row', card).hidden = s.source !== 'web';
  }
}

// ---------- 極簡模式 ----------

function shortLabel(label) {
  if (/^5 小時/.test(label)) return '5h';
  const m = label.match(/^每週（(.+)）$/);
  if (m) return m[1] === '全部模型' ? '週' : `${m[1]}週`;
  if (label === '每週') return '週';
  return label.replace(' 小時', 'h').replace(' 天', 'd');
}

function shortCountdown(iso) {
  const m = Math.max(0, Math.floor((new Date(iso) - Date.now()) / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`;
  return `${m}m`;
}

function compactProvider(name, cls, s) {
  let body;
  if (!s) body = '<span class="w">讀取中</span>';
  else if (!s.windows || !s.windows.length) body = '<span class="err">讀不到，點 ▢ 看原因</span>';
  else {
    body = s.windows.map((w) => {
      const left = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
      const reset = w.resetsAt ? ` <small>${shortCountdown(w.resetsAt)}</small>` : '';
      return `<span class="w"><span class="lbl">${esc(shortLabel(w.label))}</span><b data-left="${left}">${left}%</b>${reset}</span>`;
    }).join('');
    if (s.error || s.note) body += '<span class="err">!</span>';
  }
  return `<span class="prov"><span class="who"><span class="dot ${cls}"></span><span class="name">${name}</span></span>${body}</span>`;
}

// tibo 24 小時內的 reset 公告，在極簡列上顯示提示；點開過就不再閃
const TIBO_HINT_MS = 24 * 3600 * 1000;
function seenTibo() {
  try { return localStorage.getItem('seenTibo'); } catch { return null; }
}
function latestTibo() {
  const items = (current.news && current.news.items) || [];
  const i = items.find((x) => x.isReset && /thsottiaux/.test(x.source));
  return i && i.at && Date.now() - new Date(i.at) < TIBO_HINT_MS ? i : null;
}
function shortAgo(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 1) return '剛剛';
  if (m < 60) return `${m}m前`;
  return `${Math.floor(m / 60)}h前`;
}
function tiboHint() {
  const i = latestTibo();
  if (!i) return '';
  const fresh = seenTibo() !== (i.id || i.url);
  const tip = `tibo ${fmtTime(i.at)} 宣布 Codex 額度 reset${i.kind ? `（${i.kind}）` : ''}\n${i.title}\n\n點一下打開貼文`;
  return `<span class="tibo${fresh ? ' new' : ''}" data-url="${esc(i.url)}" data-id="${esc(i.id || i.url)}" title="${esc(tip)}"><i></i>tibo reset ${shortAgo(i.at)}</span>`;
}

function renderCompact() {
  const line = $('#compact-line');
  line.innerHTML = compactProvider('Claude', 'claude', current.claude) + '<span class="sep"></span>' + compactProvider('Codex', 'codex', current.codex) + tiboHint();
  line.querySelectorAll('b[data-left]').forEach((el) => { el.style.color = barColor(Number(el.dataset.left)); });
  const tip = [];
  for (const [n, s] of [['Claude', current.claude], ['Codex', current.codex]]) {
    if (s && s.windows) for (const w of s.windows) tip.push(`${n} ${w.label}：剩 ${Math.round(100 - w.usedPercent)}%${w.resetsAt ? `，reset ${fmtTime(w.resetsAt)}` : ''}`);
    if (s && s.error) tip.push(`${n}：${s.error}`);
  }
  line.title = tip.join('\n');
  if (document.body.classList.contains('compact')) fitCompact();
}

// 依內容調整極簡列的寬度
let lastFit = 0;
function fitCompact() {
  const line = $('#compact-line');
  const need = Math.ceil([...line.children].reduce((w, el) => w + el.getBoundingClientRect().width, 0)
    + 16 * (line.children.length - 1) + $('#view-compact .actions').getBoundingClientRect().width + 34); // 30 是左右內距與間距，再加上 body 的邊框
  if (Math.abs(need - lastFit) > 1) { lastFit = need; window.quota.fitCompact(need); }
}

function renderNews() {
  const list = $('#news-list');
  const n = current.news;
  if (!n) {
    list.innerHTML = '<li class="empty">讀取中…</li>';
    return;
  }
  const items = n.items.filter((i) => {
    if (filter === 'reset') return i.isReset;
    if (filter === 'claude' || filter === 'codex') return i.provider === filter;
    return true;
  }).slice(0, 40);
  list.innerHTML = items.length ? items.map((i) => `
    <li data-url="${esc(i.url)}">
      <span class="src"><span class="dot ${i.provider}"></span>${esc(i.source)}${i.at ? ` · ${fmtAgo(i.at)}` : ''}${i.isReset ? `<span class="tag">reset${i.kind ? ` · ${esc(i.kind)}` : ''}</span>` : ''}</span>
      <span class="title">${esc(i.title)}</span>
    </li>`).join('') : '<li class="empty">目前沒有符合的公告</li>';
  const meta = $('#news-meta');
  const parts = [];
  if (n.errors && n.errors.length) parts.push(`部分來源讀取失敗：${n.errors.join('；')}`);
  if (n.tiboCheckedAt) parts.push(`tibo 每分鐘檢查，上次 ${fmtAgo(n.tiboCheckedAt)}`);
  else if (n.updatedAt) parts.push(`更新於 ${fmtAgo(n.updatedAt)}`);
  meta.textContent = parts.join('　');
  meta.classList.toggle('error', Boolean(n.errors && n.errors.length));
}

function render() {
  renderCard('claude');
  renderCard('codex');
  renderNews();
  renderCompact();
}

// glass=clear 完全透明、glass=blur 毛玻璃模糊（Windows 11）
const glass = new URLSearchParams(location.search).get('glass');
if (glass === 'clear' || glass === 'blur') document.body.classList.add('glass', glass);

// 毛玻璃：平常幾乎全透明，滑鼠移上去才變不透明（離開後稍等一下再變回去，避免閃爍）
let look = { restOpacity: 0, hoverSolid: true };
let leaveTimer;
function applyLook(l) {
  look = { ...look, ...l };
  document.body.style.setProperty('--veil-a', String(look.restOpacity / 100));
  document.body.classList.toggle('solid-on-hover', look.hoverSolid);
}
function setHover(h) {
  clearTimeout(leaveTimer);
  if (h) document.body.classList.add('hover');
  else leaveTimer = setTimeout(() => document.body.classList.remove('hover'), 350);
}
window.quota.onHover(setHover);
window.quota.onLook(applyLook);

function applyMode(compact) {
  document.body.classList.toggle('compact', compact);
  lastFit = 0;
  if (compact) requestAnimationFrame(fitCompact);
}
$('#btn-compact').addEventListener('click', () => window.quota.setCompact(true));
$('#btn-expand').addEventListener('click', () => window.quota.setCompact(false));
$('#btn-hide2').addEventListener('click', () => window.quota.hide());
$('#btn-claude-login').addEventListener('click', () => window.quota.claudeLogin());
$('#btn-claude-logout').addEventListener('click', (e) => { e.preventDefault(); window.quota.claudeLogout(); });
window.quota.onMode(applyMode);
// 新版本：下載中在上方顯示進度；下載好後上方和極簡列都有「更新」按鈕，按一下重新啟動套用
let upd = { status: 'idle' };
let appVersion = '';
const UPDATE_TEXT = {
  checking: () => '正在檢查新版本…',
  downloading: (u) => `正在下載新版 ${u.version}（${u.percent}%）`,
  ready: (u) => `新版 ${u.version} 已下載`,
  latest: () => '已是最新版',
  error: () => '上次檢查時連不上 GitHub',
  dev: () => '開發版不會自動更新',
};
function showUpdate(u) {
  if (!u) return;
  upd = u;
  const ready = u.status === 'ready';
  const text = UPDATE_TEXT[u.status] ? UPDATE_TEXT[u.status](u) : '';
  $('#update-bar').hidden = !(ready || u.status === 'downloading');
  $('#update-text').textContent = text;
  $('#btn-update').hidden = !ready;
  $('#btn-update2').hidden = !ready;
  $('#btn-update2').title = ready ? `重新啟動並更新到 ${u.version}` : '';
  $('#s-version').textContent = `版本 ${appVersion}${text ? `，${text}` : ''}`;
  $('#s-check').textContent = ready ? '重新啟動並更新' : '檢查新版本';
  $('#s-check').disabled = ['checking', 'downloading', 'dev'].includes(u.status);
  if (document.body.classList.contains('compact')) { lastFit = 0; requestAnimationFrame(fitCompact); }
}
window.quota.onUpdate(showUpdate);
$('#btn-update').addEventListener('click', () => window.quota.installUpdate());
$('#btn-update2').addEventListener('click', () => window.quota.installUpdate());
$('#s-check').addEventListener('click', () => (upd.status === 'ready' ? window.quota.installUpdate() : window.quota.checkUpdate()));
window.quota.getSettings().then((s) => {
  applyMode(Boolean(s.compact));
  appVersion = s.version;
  showUpdate(s.update);
  applyLook({ restOpacity: s.restOpacity ?? 0, hoverSolid: s.hoverSolid !== false });
});

$('#compact-line').addEventListener('click', (e) => {
  const hint = e.target.closest('.tibo');
  if (!hint) return;
  try { localStorage.setItem('seenTibo', hint.dataset.id); } catch { /* 存不了就下次繼續閃 */ }
  hint.classList.remove('new');
  window.quota.openUrl(hint.dataset.url);
});
$('#news-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-url]');
  if (li && li.dataset.url) window.quota.openUrl(li.dataset.url);
});
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.filter;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderNews();
}));
$('#btn-refresh').addEventListener('click', () => window.quota.refresh());
$('#btn-hide').addEventListener('click', () => window.quota.hide());

// ---------- 設定 ----------

async function openSettings() {
  const s = await window.quota.getSettings();
  $('#s-usage').value = s.usageMinutes;
  $('#s-news').value = s.newsMinutes;
  $('#s-top').checked = s.alwaysOnTop;
  $('#s-theme').value = s.theme || 'auto';
  $('#s-glass-row').hidden = !s.blurAvailable;
  $('#s-glass').value = s.glass === 'blur' ? 'blur' : 'clear';
  appVersion = s.version;
  showUpdate(s.update);
  $('#s-login').checked = s.openAtLogin;
  $('#s-notify').checked = s.notify;
  $('#s-rest').value = s.restOpacity ?? 0;
  $('#s-rest-v').textContent = `${s.restOpacity ?? 0}%`;
  $('#s-hover').checked = s.hoverSolid !== false;
  $('#s-low').value = s.lowPercent ?? 10;
  $('#s-xtoken').value = '';
  $('#s-xtoken').placeholder = s.hasXToken ? '已設定（留空表示不變）' : '留空則不讀官方 X 帳號';
  $('#view-main').hidden = true;
  $('#view-settings').hidden = false;
}
function closeSettings() {
  $('#view-settings').hidden = true;
  $('#view-main').hidden = false;
}
$('#btn-settings').addEventListener('click', () => ($('#view-settings').hidden ? openSettings() : closeSettings()));
$('#s-cancel').addEventListener('click', () => { closeSettings(); window.quota.getSettings().then((s) => applyLook({ restOpacity: s.restOpacity ?? 0 })); });
// 拖拉時即時預覽透明度
let previewTimer;
$('#s-rest').addEventListener('input', () => {
  $('#s-rest-v').textContent = `${$('#s-rest').value}%`;
  applyLook({ restOpacity: Number($('#s-rest').value) });
  document.body.classList.add('previewing'); // 拖拉時暫時顯示「平常」的樣子
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => document.body.classList.remove('previewing'), 1200);
});
$('#s-clear-x').addEventListener('click', async () => {
  await window.quota.saveSettings({ xToken: '' });
  closeSettings();
});
$('#s-save').addEventListener('click', async () => {
  const patch = {
    usageMinutes: Number($('#s-usage').value),
    newsMinutes: Number($('#s-news').value),
    alwaysOnTop: $('#s-top').checked,
    theme: $('#s-theme').value,
    openAtLogin: $('#s-login').checked,
    notify: $('#s-notify').checked,
    restOpacity: Number($('#s-rest').value),
    hoverSolid: $('#s-hover').checked,
    lowPercent: Number($('#s-low').value),
  };
  if (!$('#s-glass-row').hidden) patch.glass = $('#s-glass').value;
  const token = $('#s-xtoken').value.trim();
  if (token) patch.xToken = token;
  await window.quota.saveSettings(patch);
  closeSettings();
});

window.quota.onState((s) => { current = s; render(); });
window.quota.getState().then((s) => { current = s; render(); });
setInterval(render, 30 * 1000); // 倒數計時
