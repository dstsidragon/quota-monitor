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

function renderCompact() {
  const line = $('#compact-line');
  line.innerHTML = compactProvider('Claude', 'claude', current.claude) + '<span class="sep"></span>' + compactProvider('Codex', 'codex', current.codex);
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
    + 16 * (line.children.length - 1) + $('#view-compact .actions').getBoundingClientRect().width + 30);
  if (Math.abs(need - lastFit) > 4) { lastFit = need; window.quota.fitCompact(need); }
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
      <span class="src"><span class="dot ${i.provider}"></span>${esc(i.source)}${i.at ? ` · ${fmtAgo(i.at)}` : ''}${i.isReset ? '<span class="tag">reset</span>' : ''}</span>
      <span class="title">${esc(i.title)}</span>
    </li>`).join('') : '<li class="empty">目前沒有符合的公告</li>';
  const meta = $('#news-meta');
  const parts = [];
  if (n.errors && n.errors.length) parts.push(`部分來源讀取失敗：${n.errors.join('；')}`);
  if (n.updatedAt) parts.push(`更新於 ${fmtAgo(n.updatedAt)}`);
  meta.textContent = parts.join('　');
  meta.classList.toggle('error', Boolean(n.errors && n.errors.length));
}

function render() {
  renderCard('claude');
  renderCard('codex');
  renderNews();
  renderCompact();
}

if (new URLSearchParams(location.search).get('glass') === '1') document.body.classList.add('glass');

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
function showUpdate(v) {
  if (!v) return;
  $('#update-text').textContent = `新版 ${v} 已下載`;
  $('#update-bar').hidden = false;
}
window.quota.onUpdate(showUpdate);
$('#btn-update').addEventListener('click', () => window.quota.installUpdate());
window.quota.getSettings().then((s) => { applyMode(Boolean(s.compact)); showUpdate(s.updateReady); });

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
  $('#s-theme').value = s.theme || 'system';
  $('#s-version').textContent = `版本 ${s.version}，有新版會自動下載。`;
  $('#s-login').checked = s.openAtLogin;
  $('#s-notify').checked = s.notify;
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
$('#s-cancel').addEventListener('click', closeSettings);
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
  };
  const token = $('#s-xtoken').value.trim();
  if (token) patch.xToken = token;
  await window.quota.saveSettings(patch);
  closeSettings();
});

window.quota.onState((s) => { current = s; render(); });
window.quota.getState().then((s) => { current = s; render(); });
setInterval(render, 30 * 1000); // 倒數計時
