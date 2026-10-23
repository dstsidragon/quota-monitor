const { app, BrowserWindow, Tray, Menu, ipcMain, net, nativeImage, Notification, shell, safeStorage, screen, session, nativeTheme, powerMonitor, desktopCapturer, crashReporter } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchClaude, fetchClaudeWeb, fetchCodex } = require('./providers');
const { fetchStatusFeeds, fetchTibo, fetchX, fetchTweetText, mergeNews } = require('./news');
const { medianLuma, pickBackdrop, cropRect } = require('./backdrop');
const { cmpVersion } = require('./bundles');
const crypto = require('crypto');
const ofs = require('original-fs'); // 讀寫 .asar 檔本身時用，不要被當成資料夾

// 本機紀錄：啟動、更新、錯誤都寫在資料夾 logs\main.log（只存在這台電腦，不含帳號資料），出問題時用來找原因
let logFile = null;
function log(...parts) {
  const text = parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  try {
    if (!logFile) {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'main.log');
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, `${logFile}.old`);
    }
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
  } catch { /* 寫不了紀錄也不影響使用 */ }
}
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

// 自動更新：只下載新版的程式內容（bundles\<版本>.asar），不跑安裝程式、不換執行檔，
// 所以不會被 Windows 智慧型應用程式控制擋下。下載好按一下就重新啟動，由 boot.js 載入新版。
// 每 30 分鐘自己檢查一次，也可以從系統匣、設定手動檢查。
const APP_VERSION = require('../package.json').version; // 這份程式內容的版本（不是執行檔的版本）
const UPDATE_INFO_URL = 'https://github.com/dstsidragon/quota-monitor/releases/latest/download/bundle.json';
const bundle = global.quotaBundle || null; // boot.js 交代的資訊；直接用 main.js 啟動（開發時）就沒有
// status：idle | checking | downloading | ready | latest | error | dev（開發版不更新）
const upd = { status: 'idle', version: null, percent: 0 };
function setUpd(patch) {
  const before = JSON.stringify(upd);
  Object.assign(upd, patch);
  if (JSON.stringify(upd) === before) return;
  buildTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('update', upd);
}

function setupAutoUpdate() {
  if (!app.isPackaged || !bundle) { upd.status = 'dev'; return; }
  setTimeout(checkUpdate, 10 * 1000);
  setInterval(checkUpdate, 30 * MIN);
}

// 已經下載好就直接重新啟動套用；否則馬上檢查（有新版會自動下載）
async function checkUpdate() {
  if (upd.status === 'ready') return installUpdate();
  if (['checking', 'downloading', 'dev'].includes(upd.status)) return;
  setUpd({ status: 'checking' });
  try {
    const res = await fetchImpl(UPDATE_INFO_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`更新資訊回應 ${res.status}`);
    const info = await res.json();
    if (!/^\d+\.\d+\.\d+$/.test(info.version || '') || !info.file || !info.sha512) throw new Error('更新資訊格式不對');
    if (cmpVersion(info.version, APP_VERSION) <= 0) return setUpd({ status: 'latest' });
    // 這一版之前開不起來、被退回舊版過，就不再下載它，等下一版
    if (bundleState().bad?.includes(info.version)) { log('[update] 略過開不起來的版本', info.version); return setUpd({ status: 'latest' }); }
    log('[update] 發現新版', info.version);
    setUpd({ status: 'downloading', version: info.version, percent: 0 });
    const url = `https://github.com/dstsidragon/quota-monitor/releases/download/v${info.version}/${encodeURIComponent(info.file)}`;
    const data = await downloadWithProgress(url, info.size);
    const sha = crypto.createHash('sha512').update(data).digest('base64');
    if (sha !== info.sha512) throw new Error('下載的檔案檢查碼不符');
    // 先寫成暫存檔再改名，避免半個檔案被當成新版載入
    const target = path.join(bundle.dir, `${info.version}.asar`);
    ofs.mkdirSync(bundle.dir, { recursive: true });
    ofs.writeFileSync(`${target}.part`, data);
    ofs.renameSync(`${target}.part`, target);
    log('[update] 下載完成', info.version);
    setUpd({ status: 'ready', version: info.version, percent: 100 });
    const n = new Notification({ title: `額度監控器 ${info.version} 已下載`, body: '點這裡重新啟動並更新，或下次開啟時自動套用。' });
    n.on('click', installUpdate);
    n.show();
  } catch (e) {
    // 沒網路或 GitHub 暫時連不上時，下次再試
    log('[update] 失敗', e);
    setUpd({ status: 'error' });
  }
}

async function downloadWithProgress(url, size) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`下載回應 ${res.status}`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    if (total) setUpd({ percent: Math.min(99, Math.floor((got / total) * 100)) });
  }
  return Buffer.concat(chunks);
}

function installUpdate() {
  if (upd.status !== 'ready') return;
  log('重新啟動並套用', upd.version);
  app.isQuitting = true;
  app.relaunch();
  app.exit(0);
}

function bundleState() {
  try { return JSON.parse(ofs.readFileSync(bundle.stateFile, 'utf8')); } catch { return {}; }
}

// 新版成功開出畫面後，告訴 boot.js 這版沒問題，並清掉用不到的舊版
function markBundleGood() {
  if (!bundle) return;
  try {
    const st = bundleState();
    if (st.ok !== APP_VERSION || st.trying) {
      if (st.trying === APP_VERSION) log('新版啟動成功', APP_VERSION);
      ofs.writeFileSync(bundle.stateFile, JSON.stringify({ ...st, ok: APP_VERSION, trying: null }));
    }
  } catch { /* 沒有紀錄檔就算了 */ }
  try {
    const bad = bundleState().bad || [];
    for (const f of ofs.readdirSync(bundle.dir)) {
      const m = /^(\d+\.\d+\.\d+)\.asar(\.part)?$/.exec(f);
      if (m && (cmpVersion(m[1], APP_VERSION) < 0 || bad.includes(m[1]))) ofs.unlinkSync(path.join(bundle.dir, f));
    }
  } catch { /* 舊檔刪不掉下次再刪 */ }
}

const MIN = 60 * 1000;
const DEFAULT_SETTINGS = {
  usageMinutes: 5, newsMinutes: 15, alwaysOnTop: true, openAtLogin: false, notify: true, xToken: null,
  compact: false,
  theme: 'auto', // 文字顏色：auto 依背後桌面深淺、system 跟隨 Windows、light 深色字、dark 白色字
  restOpacity: 0, // 平常（滑鼠不在上面）時鋪在毛玻璃上的底色濃度，0–60%
  hoverSolid: true, // 滑鼠移上去時變不透明
  lowPercent: 10, // 剩餘低於這個百分比時通知，0 表示不通知
  glass: 'clear', // 背景：'clear' 完全透明（直接看到桌面）、'blur' 毛玻璃模糊（Windows 11）
  locked: false, // 極簡模式鎖定：滑鼠穿透整條，只有鎖頭能點
  schema: 1, // 設定檔格式版本，用來搬移舊的預設值
};
const TIBO_MS = 60 * 1000; // tibo 的 reset 貼文每分鐘檢查一次
// Windows 11 22H2（build 22621）以上才有 acrylic 毛玻璃模糊；完全透明則每個版本都能用
const GLASS = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
const glassStyle = () => (settings.glass === 'blur' && GLASS ? 'blur' : 'clear');
const COMPACT = { width: 560, height: 42 };
const NORMAL = { width: 380, height: 600 };

let win;
let tray;
let settings;
const state = { claude: null, codex: null, news: null };
const timers = {};
const backoff = { claude: 1, codex: 1 };

// ---------- 設定（X token 用作業系統的加密儲存） ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    // 0.6.1 起文字顏色預設改成「自動」；舊設定檔裡存的是當時的預設值「跟隨 Windows」
    if (!saved.schema && saved.theme === 'system') saved.theme = 'auto';
    const s = { ...DEFAULT_SETTINGS, ...saved, schema: 1 };
    if (s.xTokenEnc && safeStorage.isEncryptionAvailable()) s.xToken = safeStorage.decryptString(Buffer.from(s.xTokenEnc, 'base64'));
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  const { xToken, ...rest } = settings;
  if (xToken && safeStorage.isEncryptionAvailable()) rest.xTokenEnc = safeStorage.encryptString(xToken).toString('base64');
  else delete rest.xTokenEnc;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(rest, null, 2));
}

function publicSettings() {
  const { xToken, xTokenEnc, ...rest } = settings;
  return { ...rest, hasXToken: Boolean(xToken) };
}

// ---------- 抓資料 ----------

// 一律不走 HTTP 快取，避免拿到舊的公告或額度
const fetchImpl = (url, opts = {}) => net.fetch(url, { cache: 'no-store', ...opts });

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), name), 'utf8')); } catch { return fallback; }
}
function writeJson(name, data) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), name), JSON.stringify(data));
  } catch { /* 寫不進去就算了，下次重算 */ }
}

// ---------- claude.ai 登入（給只用 Claude 桌面版、沒有 CLI 登入資料的人） ----------

const CLAUDE_PARTITION = 'persist:claude-web';
const claudeSession = () => session.fromPartition(CLAUDE_PARTITION);
const claudeWebFetch = (url, opts = {}) => claudeSession().fetch(url, { cache: 'no-store', ...opts });

async function fetchClaudeAny(f) {
  try {
    return await fetchClaude(f);
  } catch (e) {
    if (!['no-login', 'expired'].includes(e.kind)) throw e;
    try {
      return await fetchClaudeWeb(claudeWebFetch);
    } catch (we) {
      if (we.kind === 'web-login') we.message = `${e.message} ${we.message}`;
      throw we;
    }
  }
}

let loginWin;
function openClaudeLogin() {
  if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return; }
  const ses = claudeSession();
  // 去掉 Electron 字樣，降低 Google 登入擋嵌入式瀏覽器的機率
  ses.setUserAgent(ses.getUserAgent().replace(/\s*(Electron|quota-monitor)\/\S+/g, ''));
  loginWin = new BrowserWindow({
    width: 480, height: 720, title: '登入 claude.ai',
    icon: path.join(__dirname, 'icon-256.png'),
    webPreferences: { partition: CLAUDE_PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  loginWin.setMenuBarVisibility(false);
  loginWin.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));
  const check = async () => {
    const cookies = await ses.cookies.get({ domain: 'claude.ai', name: 'sessionKey' });
    const url = new URL(loginWin.webContents.getURL());
    if (cookies.length && url.hostname === 'claude.ai' && !/^\/(login|magic-link|onboarding)/.test(url.pathname)) {
      loginWin.close();
      refreshProvider('claude');
    }
  };
  loginWin.webContents.on('did-navigate', check);
  loginWin.webContents.on('did-navigate-in-page', check);
  loginWin.loadURL('https://claude.ai/login');
}

async function logoutClaudeWeb() {
  await claudeSession().clearStorageData();
  refreshProvider('claude');
}

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
  updateTray();
}

function notify(title, body, url) {
  if (!settings.notify || !Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (url) n.on('click', () => shell.openExternal(url));
  n.show();
}

// 某個視窗的使用率大幅下降，代表額度被 reset 了（包含沒預告的提前 reset）
function detectReset(name, prev, next) {
  if (!prev || !prev.windows || !next.windows) return;
  for (const w of next.windows) {
    const old = prev.windows.find((p) => p.label === w.label);
    if (old && old.usedPercent - w.usedPercent >= 15) {
      notify(`${name} 額度已 reset`, `${w.label}：${Math.round(old.usedPercent)}% → ${Math.round(w.usedPercent)}%`);
    }
  }
}

// 剩餘額度低於門檻時通知一次（同一個額度週期只通知一次）
let lowAlerted = null;
function checkLow(name, data) {
  if (!settings.lowPercent || !data.windows) return;
  if (!lowAlerted) lowAlerted = new Set(readJson('low-alerts.json', []));
  let changed = false;
  for (const w of data.windows) {
    const left = 100 - w.usedPercent;
    const key = `${name}|${w.label}|${w.resetsAt || ''}`;
    if (left <= settings.lowPercent && !lowAlerted.has(key)) {
      lowAlerted.add(key);
      changed = true;
      const when = w.resetsAt ? `，${new Date(w.resetsAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} reset` : '';
      notify(`${name} 額度快用完了`, `${w.label}只剩 ${Math.max(0, Math.round(left))}%${when}`);
    }
  }
  if (changed) writeJson('low-alerts.json', [...lowAlerted].slice(-100));
}

const PROVIDERS = {
  claude: { name: 'Claude Code', fn: (f) => fetchClaudeAny(f) },
  codex: { name: 'Codex', fn: (f) => fetchCodex(f) },
};

async function refreshProvider(key) {
  const { name, fn } = PROVIDERS[key];
  const prev = state[key];
  let next = settings.usageMinutes * MIN;
  try {
    const data = await fn(fetchImpl);
    state[key] = { ok: true, ...data, updatedAt: new Date().toISOString() };
    backoff[key] = 1;
    detectReset(name, prev, state[key]);
    checkLow(name, state[key]);
    // 某個額度快到 reset 時間時，到點後 20 秒就再查一次，馬上看到新額度
    for (const w of data.windows || []) {
      const ms = w.resetsAt ? Date.parse(w.resetsAt) - Date.now() + 20 * 1000 : Infinity;
      if (ms > 0 && ms < next) next = Math.max(30 * 1000, ms);
    }
  } catch (e) {
    if (e.kind === 'rate-limited') backoff[key] = Math.min(backoff[key] * 2, 6);
    next *= backoff[key];
    // 失敗時保留上一次的數值，只加上錯誤訊息
    state[key] = { ...(prev && prev.windows ? prev : {}), ok: false, error: e.message, errorKind: e.kind || 'network', failedAt: new Date().toISOString() };
  }
  push();
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => refreshProvider(key), next);
}

// ---------- 公告：tibo 每分鐘、狀態頁和 X 依設定的間隔 ----------

const news = {
  tibo: { items: [], error: null, lastPolledAt: null, checkedAt: null },
  status: { items: [], errors: [] },
  x: { items: [], errors: [] },
};
let tweetText = null; // postId → 貼文內文，存在本機，避免重複抓
const tweetFailed = new Set();
let notified = null; // 已經通知過（或第一次讀到時就存在）的 reset 公告
let seeded = null; // 哪些來源已經讀過第一次

function withText(items) {
  return items.map((i) => (i.postId && tweetText[i.postId] ? { ...i, title: tweetText[i.postId] } : i));
}

function publishNews() {
  state.news = {
    items: mergeNews([withText(news.tibo.items), news.x.items, news.status.items]),
    errors: [news.tibo.error, ...news.status.errors, ...news.x.errors].filter(Boolean),
    tiboPolledAt: news.tibo.lastPolledAt,
    tiboCheckedAt: news.tibo.checkedAt,
    updatedAt: new Date().toISOString(),
  };
  push();
}

async function loadTweetText(postId) {
  if (tweetText[postId] || tweetFailed.has(postId)) return tweetText[postId] || null;
  try {
    const text = await Promise.race([fetchTweetText(fetchImpl, postId), new Promise((r) => setTimeout(() => r(null), 8000))]);
    if (text) { tweetText[postId] = text; writeJson('tweets.json', tweetText); } else tweetFailed.add(postId);
    return text;
  } catch {
    tweetFailed.add(postId);
    return null;
  }
}

// 每個來源第一次讀到時，把現有的公告都當成看過；之後每則新的 reset 公告只通知一次。
// 電腦關機或睡眠時發的公告，開機後 24 小時內的仍會補通知。
function takeFresh(group, items) {
  if (notified === null) {
    const saved = readJson('notified.json', {});
    notified = new Set(Array.isArray(saved.ids) ? saved.ids : []);
    seeded = new Set(Array.isArray(saved.seeded) ? saved.seeded : []);
  }
  const seedAll = !seeded.has(group);
  seeded.add(group);
  const fresh = [];
  for (const i of items) {
    const id = i.id || i.url;
    if (!i.isReset || notified.has(id)) continue;
    notified.add(id);
    const recent = i.at && Date.now() - Date.parse(i.at) < 24 * 60 * MIN;
    if (!seedAll && recent) fresh.push(i);
  }
  writeJson('notified.json', { ids: [...notified].slice(-300), seeded: [...seeded] });
  return fresh;
}

async function announce(items) {
  for (const i of items) {
    const text = i.postId ? await loadTweetText(i.postId) : null;
    notify(i.source + (i.kind ? `：${i.kind} reset` : ''), text || i.title, i.url);
  }
  // tibo 宣布 reset 後馬上查一次 Codex 額度，3 分鐘後再查一次（reset 生效可能會晚一點）
  if (items.some((i) => i.provider === 'codex')) {
    refreshProvider('codex');
    setTimeout(() => refreshProvider('codex'), 3 * MIN);
  }
}

async function refreshTibo() {
  try {
    const r = await fetchTibo(fetchImpl);
    news.tibo = { items: r.items, error: null, lastPolledAt: r.lastPolledAt, checkedAt: new Date().toISOString() };
    const fresh = takeFresh('tibo', r.items);
    publishNews();
    if (fresh.length) await announce(fresh);
    // 補抓還沒有內文的貼文（最新 10 則）
    for (const i of r.items.slice(0, 10)) if (i.postId && !tweetText[i.postId]) await loadTweetText(i.postId);
  } catch (e) {
    news.tibo.error = e.message;
  }
  publishNews();
  clearTimeout(timers.tibo);
  timers.tibo = setTimeout(refreshTibo, TIBO_MS);
}

async function refreshOtherNews() {
  const [status, x] = await Promise.all([
    fetchStatusFeeds(fetchImpl).catch((e) => ({ items: news.status.items, errors: [e.message] })),
    settings.xToken ? fetchX(fetchImpl, settings.xToken).catch((e) => ({ items: news.x.items, errors: [e.message] })) : { items: [], errors: [] },
  ]);
  news.status = status;
  news.x = x;
  const fresh = [...takeFresh('status', status.items), ...(settings.xToken ? takeFresh('x', x.items) : [])];
  publishNews();
  if (fresh.length) await announce(fresh);
  clearTimeout(timers.news);
  timers.news = setTimeout(refreshOtherNews, settings.newsMinutes * MIN);
}

function refreshAll() {
  refreshProvider('claude');
  refreshProvider('codex');
  refreshTibo();
  refreshOtherNews();
}

// ---------- 視窗與系統匣 ----------

function createWindow(bounds) {
  const { workArea } = screen.getPrimaryDisplay();
  const size = settings.compact ? COMPACT : NORMAL;
  // 回到上次的位置；沒有紀錄就放右下角。都會夾在螢幕範圍內（螢幕配置可能變過）
  const start = bounds || (settings.pos
    ? placeBounds({ ...settings.pos, ...size }, size)
    : { x: workArea.x + workArea.width - size.width - 16, y: workArea.y + workArea.height - size.height - 16, ...size });
  const style = glassStyle();
  win = new BrowserWindow({
    ...start,
    frame: false,
    resizable: !settings.compact,
    minWidth: settings.compact ? 200 : 320,
    minHeight: settings.compact ? COMPACT.height : 300,
    skipTaskbar: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: settings.alwaysOnTop,
    // 完全透明要在建立視窗時決定（之後改不了），換樣式時會重建視窗
    ...(style === 'blur' ? { backgroundMaterial: 'acrylic' } : { transparent: true }),
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'icon-256.png'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { glass: style } });
  let moveTimer;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { const b = win.getBounds(); settings.pos = { x: b.x, y: b.y }; saveSettings(); sampleBackdrop(); }, 500);
  });
  win.once('ready-to-show', () => { win.show(); setTimeout(sampleBackdrop, 300); });
  win.webContents.on('did-finish-load', applyLock);
  win.webContents.once('did-finish-load', markBundleGood);
  win.webContents.on('did-fail-load', (_e, code, desc) => log('畫面載入失敗', code, desc));
  win.webContents.on('console-message', (e, level, message) => {
    const lv = e.level ?? level;
    if (lv === 'error' || lv === 3) log('[畫面錯誤]', e.message ?? message);
  });
  // 在極簡列的拖曳區按右鍵：換成自己的選單（展開、鎖定、收起），不要 Windows 的系統選單
  win.on('system-context-menu', (e) => { e.preventDefault(); compactMenu(); });
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// 極簡模式鎖定：整個視窗忽略滑鼠（點擊穿透到後面的視窗），只有滑鼠移到鎖頭上時暫時接受點擊
const isLocked = () => Boolean(settings.compact && settings.locked);
function applyLock() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(isLocked(), { forward: true });
  win.webContents.send('lock', isLocked());
}
function setLocked(locked) {
  settings.locked = Boolean(locked);
  saveSettings();
  applyLock();
  buildTrayMenu();
}

function compactMenu() {
  if (!settings.compact) return;
  Menu.buildFromTemplate([
    { label: '展開成完整視窗', click: () => setCompact(false) },
    { label: '鎖定（滑鼠穿透）', click: () => setLocked(true) },
    { label: '重新讀取額度', click: refreshAll },
    { type: 'separator' },
    { label: '收到系統匣', click: () => win.hide() },
  ]).popup({ window: win });
}

function setGlass(style) {
  if (!['clear', 'blur'].includes(style) || settings.glass === style) return;
  settings.glass = style;
  saveSettings();
  const old = win;
  const b = old.getBounds();
  settings.pos = { x: b.x, y: b.y };
  hovering = false;
  createWindow(b);
  old.destroy();
  buildTrayMenu();
}

// 毛玻璃「滑過才不透明」：拖曳區不會觸發網頁的 :hover，所以由主程式看游標在不在視窗上
let hovering = false;
function startHoverWatch() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    // 鎖定時滑鼠移過去不應該有任何反應（不變不透明）
    const inside = !isLocked() && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside !== hovering) {
      hovering = inside;
      hoverChangedAt = Date.now();
      win.webContents.send('hover', inside);
    }
  }, 120);
}

// 文字顏色「自動」：每 3 秒看一下視窗背後的亮度（滑鼠在上面時底色不透明，那時不看）
let hoverChangedAt = 0;
let backdrop = null;
let sampling = false;
function applyTheme() {
  nativeTheme.themeSource = settings.theme === 'auto' ? (backdrop || 'system') : settings.theme;
}
async function sampleBackdrop() {
  if (settings.theme !== 'auto' || sampling || !win || win.isDestroyed() || !win.isVisible()) return;
  if (hovering || Date.now() - hoverChangedAt < 1500) return;
  sampling = true;
  try {
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.bounds.width / 4), height: Math.round(d.bounds.height / 4) },
    });
    const src = sources.find((x) => x.display_id === String(d.id)) || (sources.length === 1 ? sources[0] : null);
    if (!src || src.thumbnail.isEmpty() || hovering) return;
    const rect = cropRect(b, d.bounds, src.thumbnail.getSize());
    const next = pickBackdrop(medianLuma(src.thumbnail.crop(rect).toBitmap()), backdrop);
    if (next !== backdrop) { backdrop = next; applyTheme(); }
  } catch { /* 擷取不到就維持現在的顏色 */ } finally {
    sampling = false;
  }
}

function trayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
}

function summary(name, s) {
  if (!s) return `${name}：讀取中`;
  if (!s.windows) return `${name}：${s.error}`;
  return `${name}：` + s.windows.slice(0, 2).map((w) => `${w.label} 剩 ${Math.max(0, Math.round(100 - w.usedPercent))}%`).join('，');
}

function updateTray() {
  if (tray) tray.setToolTip(`${summary('Claude', state.claude)}\n${summary('Codex', state.codex)}`);
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

function updateMenuItem() {
  switch (upd.status) {
    case 'ready': return { label: `重新啟動並更新到 ${upd.version}`, click: installUpdate };
    case 'downloading': return { label: `正在下載新版 ${upd.version}（${upd.percent}%）`, enabled: false };
    case 'checking': return { label: '正在檢查新版本…', enabled: false };
    case 'latest': return { label: '檢查新版本（目前已是最新版）', click: checkUpdate };
    case 'error': return { label: '檢查新版本（上次連不上 GitHub）', click: checkUpdate };
    default: return { label: '檢查新版本', click: checkUpdate };
  }
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '顯示／隱藏', click: toggleWindow },
    { label: '重新讀取額度', click: refreshAll },
    { label: '極簡模式', type: 'checkbox', checked: settings.compact, click: (i) => setCompact(i.checked) },
    { label: '極簡模式鎖定（滑鼠穿透）', type: 'checkbox', checked: settings.locked, click: (i) => setLocked(i.checked) },
    ...(GLASS ? [{ label: '背景', submenu: [
      { label: '完全透明', type: 'radio', checked: glassStyle() === 'clear', click: () => setGlass('clear') },
      { label: '毛玻璃模糊', type: 'radio', checked: glassStyle() === 'blur', click: () => setGlass('blur') },
    ] }] : []),
    { type: 'separator' },
    ...(upd.status === 'dev' ? [] : [updateMenuItem()]),
    { label: `版本 ${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: '結束', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', toggleWindow);
  buildTrayMenu();
  updateTray();
}

// ---------- IPC ----------

// 切換極簡模式時固定右下角，讓視窗往左上展開／收合
let normalSize = { ...NORMAL };

// 換尺寸時依視窗在螢幕哪一側決定錨點（在右半邊就固定右緣、在下半邊就固定下緣），
// 最後一律夾在螢幕可用範圍內，避免展開後跑出畫面拖不回來
function placeBounds(b, size) {
  const wa = screen.getDisplayMatching(b).workArea;
  const right = b.x + b.width / 2 > wa.x + wa.width / 2;
  const bottom = b.y + b.height / 2 > wa.y + wa.height / 2;
  const width = Math.min(size.width, wa.width);
  const height = Math.min(size.height, wa.height);
  let x = right ? b.x + b.width - width : b.x;
  let y = bottom ? b.y + b.height - height : b.y;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  return { x, y, width, height };
}

function setCompact(compact) {
  if (settings.compact === compact) return;
  const b = win.getBounds();
  if (compact) normalSize = { width: b.width, height: b.height };
  const size = compact ? COMPACT : normalSize;
  win.setResizable(true);
  win.setMinimumSize(compact ? 200 : 320, compact ? COMPACT.height : 300);
  win.setBounds(placeBounds(b, size));
  win.setResizable(!compact);
  settings.compact = compact;
  saveSettings();
  win.webContents.send('mode', compact);
  applyLock(); // 鎖定只在極簡模式有效，展開後一律可以操作
  buildTrayMenu();
}

ipcMain.handle('get-state', () => state);
ipcMain.handle('set-locked', (_e, locked) => setLocked(locked));
// 鎖定時滑鼠移到鎖頭上就暫時接受點擊，移開就恢復穿透
ipcMain.handle('lock-hole', (_e, over) => { if (isLocked()) win.setIgnoreMouseEvents(!over, { forward: true }); });
ipcMain.handle('compact-menu', () => compactMenu());
ipcMain.handle('set-compact', (_e, compact) => { setCompact(Boolean(compact)); return publicSettings(); });
ipcMain.handle('fit-compact', (_e, width) => {
  if (!settings.compact) return;
  const w = Math.max(260, Math.min(1000, Math.round(width)));
  const b = win.getBounds();
  win.setMinimumSize(200, COMPACT.height);
  win.setBounds(placeBounds(b, { width: w, height: COMPACT.height }));
});
ipcMain.handle('claude-login', () => openClaudeLogin());
ipcMain.handle('claude-logout', () => logoutClaudeWeb());
ipcMain.handle('get-settings', () => ({ ...publicSettings(), version: APP_VERSION, update: upd, blurAvailable: GLASS }));
ipcMain.handle('install-update', () => installUpdate());
ipcMain.handle('check-update', () => checkUpdate());
ipcMain.handle('refresh', () => refreshAll());
ipcMain.handle('hide', () => win.hide());
ipcMain.handle('open-url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('save-settings', (_e, patch) => {
  const allowed = ['usageMinutes', 'newsMinutes', 'alwaysOnTop', 'openAtLogin', 'notify', 'xToken', 'theme', 'restOpacity', 'hoverSolid', 'lowPercent'];
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
  settings.usageMinutes = Math.max(2, Number(settings.usageMinutes) || 5);
  settings.newsMinutes = Math.max(5, Number(settings.newsMinutes) || 15);
  settings.restOpacity = Math.max(0, Math.min(60, Number(settings.restOpacity) || 0));
  settings.hoverSolid = settings.hoverSolid !== false;
  settings.lowPercent = Math.max(0, Math.min(50, Number(settings.lowPercent) || 0));
  if (win && !win.isDestroyed()) win.webContents.send('look', { restOpacity: settings.restOpacity, hoverSolid: settings.hoverSolid });
  if (settings.xToken === '') settings.xToken = null;
  saveSettings();
  if (!['auto', 'system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'auto';
  applyTheme();
  sampleBackdrop();
  win.setAlwaysOnTop(settings.alwaysOnTop);
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });
  refreshAll();
  // 換背景樣式要重建視窗，等這次 IPC 回覆後再做
  if ('glass' in patch) setImmediate(() => setGlass(patch.glass));
  return publicSettings();
});

// ---------- 啟動 ----------

function step(name, fn) {
  try { fn(); } catch (e) { log(`啟動步驟 ${name} 失敗`, e); }
}

// 中文 productName 在某些 Linux 環境會讓預設路徑變成 appData 根目錄，這時改用固定資料夾
if (path.resolve(app.getPath('userData')) === path.resolve(app.getPath('appData'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'quota-monitor'));
}
// 程式本身當掉時把當機檔留在本機資料夾（Crashpad），不會上傳
crashReporter.start({ uploadToServer: false });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 又開一次時叫出視窗；萬一視窗沒建起來就重建
  app.on('second-instance', () => {
    log('又被開啟一次，叫出視窗');
    if (!win || win.isDestroyed()) step('window', createWindow);
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  });
  app.on('render-process-gone', (_e, _wc, d) => log('render-process-gone', d));
  app.on('child-process-gone', (_e, d) => log('child-process-gone', d));
  app.on('before-quit', () => log('結束'));
  app.whenReady().then(() => {
    log(`啟動 ${APP_VERSION}`, `Windows ${os.release()}`, process.argv.slice(1).join(' '));
    if (process.platform === 'win32') app.setAppUserModelId('local.quota-monitor');
    settings = loadSettings();
    if (settings.lastVersion !== APP_VERSION) log(`版本 ${settings.lastVersion || '?'} → ${APP_VERSION}`);
    settings.lastVersion = APP_VERSION;
    step('save', saveSettings);
    tweetText = readJson('tweets.json', {});
    // 每一步分開保護：就算某一步出錯，視窗和系統匣圖示也一定要出來，不會變成看不見的程式
    step('theme', applyTheme);
    step('window', createWindow);
    step('tray', createTray);
    step('refresh', refreshAll);
    step('update', setupAutoUpdate);
    // 睡眠喚醒或解鎖後網路要一點時間才會通，等幾秒再全部更新
    const wake = () => setTimeout(refreshAll, 8000);
    powerMonitor.on('resume', wake);
    powerMonitor.on('unlock-screen', wake);
    startHoverWatch();
    setInterval(sampleBackdrop, 3000);
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
