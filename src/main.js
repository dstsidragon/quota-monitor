const { app, BrowserWindow, Tray, Menu, ipcMain, net, nativeImage, Notification, shell, safeStorage, screen, session, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchClaude, fetchClaudeWeb, fetchCodex } = require('./providers');
const { fetchNews } = require('./news');

// 自動更新：從 GitHub Releases 下載新版，下載完跳通知，重開即套用（結束時也會自動套用）
let autoUpdater = null;
let updateReady = null;
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    buildTrayMenu();
    if (win && !win.isDestroyed()) win.webContents.send('update', updateReady);
    const n = new Notification({ title: `額度監控器 ${info.version} 已下載`, body: '點這裡重新啟動並更新，或下次結束時自動套用。' });
    n.on('click', installUpdate);
    n.show();
  });
  autoUpdater.on('error', () => { /* 沒網路或 GitHub 暫時連不上時，下次再試 */ });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * MIN);
}

function installUpdate() {
  if (!autoUpdater || !updateReady) return;
  app.isQuitting = true;
  autoUpdater.quitAndInstall(true, true);
}

const MIN = 60 * 1000;
const DEFAULT_SETTINGS = { usageMinutes: 5, newsMinutes: 15, alwaysOnTop: true, openAtLogin: false, notify: true, xToken: null, compact: false, theme: 'system' };
// Windows 11 22H2（build 22621）以上才有 acrylic 毛玻璃，舊版維持不透明背景
const GLASS = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
const COMPACT = { width: 560, height: 42 };
const NORMAL = { width: 380, height: 600 };

let win;
let tray;
let settings;
const state = { claude: null, codex: null, news: null };
const timers = {};
const backoff = { claude: 1, codex: 1 };
let seenNewsIds = null; // 第一次載入時不跳通知

// ---------- 設定（X token 用作業系統的加密儲存） ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
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

const fetchImpl = (url, opts) => net.fetch(url, opts);

// ---------- claude.ai 登入（給只用 Claude 桌面版、沒有 CLI 登入資料的人） ----------

const CLAUDE_PARTITION = 'persist:claude-web';
const claudeSession = () => session.fromPartition(CLAUDE_PARTITION);
const claudeWebFetch = (url, opts) => claudeSession().fetch(url, opts);

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
      refreshProvider('claude', 'Claude Code', fetchClaudeAny);
    }
  };
  loginWin.webContents.on('did-navigate', check);
  loginWin.webContents.on('did-navigate-in-page', check);
  loginWin.loadURL('https://claude.ai/login');
}

async function logoutClaudeWeb() {
  await claudeSession().clearStorageData();
  refreshProvider('claude', 'Claude Code', fetchClaudeAny);
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

async function refreshProvider(key, name, fn) {
  const prev = state[key];
  try {
    const data = await fn(fetchImpl);
    state[key] = { ok: true, ...data, updatedAt: new Date().toISOString() };
    backoff[key] = 1;
    detectReset(name, prev, state[key]);
  } catch (e) {
    if (e.kind === 'rate-limited') backoff[key] = Math.min(backoff[key] * 2, 6);
    // 失敗時保留上一次的數值，只加上錯誤訊息
    state[key] = { ...(prev && prev.windows ? prev : {}), ok: false, error: e.message, errorKind: e.kind || 'network', failedAt: new Date().toISOString() };
  }
  push();
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => refreshProvider(key, name, fn), settings.usageMinutes * MIN * backoff[key]);
}

async function refreshNews() {
  try {
    const news = await fetchNews(fetchImpl, { xBearerToken: settings.xToken });
    const ids = news.items.filter((i) => i.isReset).map((i) => i.id || i.url);
    if (seenNewsIds) {
      for (const item of news.items) {
        const id = item.id || item.url;
        if (item.isReset && !seenNewsIds.has(id)) notify(`${item.source}`, item.title, item.url);
      }
    }
    seenNewsIds = new Set([...(seenNewsIds || []), ...ids]);
    state.news = { ...news, updatedAt: new Date().toISOString() };
  } catch (e) {
    state.news = { ...(state.news || { items: [] }), errors: [e.message] };
  }
  push();
  clearTimeout(timers.news);
  timers.news = setTimeout(refreshNews, settings.newsMinutes * MIN);
}

function refreshAll() {
  refreshProvider('claude', 'Claude Code', fetchClaudeAny);
  refreshProvider('codex', 'Codex', fetchCodex);
  refreshNews();
}

// ---------- 視窗與系統匣 ----------

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const size = settings.compact ? COMPACT : NORMAL;
  // 回到上次的位置；沒有紀錄就放右下角。都會夾在螢幕範圍內（螢幕配置可能變過）
  const start = settings.pos
    ? placeBounds({ ...settings.pos, ...size }, size)
    : { x: workArea.x + workArea.width - size.width - 16, y: workArea.y + workArea.height - size.height - 16, ...size };
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
    ...(GLASS ? { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' } : { backgroundColor: '#14161a' }),
    icon: path.join(__dirname, 'icon-256.png'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { glass: GLASS ? '1' : '0' } });
  let moveTimer;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { const b = win.getBounds(); settings.pos = { x: b.x, y: b.y }; saveSettings(); }, 500);
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
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

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '顯示／隱藏', click: toggleWindow },
    { label: '立即更新', click: refreshAll },
    { label: '極簡模式', type: 'checkbox', checked: settings.compact, click: (i) => setCompact(i.checked) },
    ...(updateReady ? [{ label: `重新啟動並更新到 ${updateReady}`, click: installUpdate }] : []),
    { type: 'separator' },
    { label: `版本 ${app.getVersion()}`, enabled: false },
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
  buildTrayMenu();
}

ipcMain.handle('get-state', () => state);
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
ipcMain.handle('get-settings', () => ({ ...publicSettings(), version: app.getVersion(), updateReady }));
ipcMain.handle('install-update', () => installUpdate());
ipcMain.handle('refresh', () => refreshAll());
ipcMain.handle('hide', () => win.hide());
ipcMain.handle('open-url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('save-settings', (_e, patch) => {
  const allowed = ['usageMinutes', 'newsMinutes', 'alwaysOnTop', 'openAtLogin', 'notify', 'xToken', 'theme'];
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
  settings.usageMinutes = Math.max(2, Number(settings.usageMinutes) || 5);
  settings.newsMinutes = Math.max(5, Number(settings.newsMinutes) || 15);
  if (settings.xToken === '') settings.xToken = null;
  saveSettings();
  if (!['system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'system';
  nativeTheme.themeSource = settings.theme;
  win.setAlwaysOnTop(settings.alwaysOnTop);
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });
  refreshAll();
  return publicSettings();
});

// ---------- 啟動 ----------

// 中文 productName 在某些 Linux 環境會讓預設路徑變成 appData 根目錄，這時改用固定資料夾
if (path.resolve(app.getPath('userData')) === path.resolve(app.getPath('appData'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'quota-monitor'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('local.quota-monitor');
    settings = loadSettings();
    nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
    createWindow();
    createTray();
    refreshAll();
    setupAutoUpdate();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
