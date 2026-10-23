// 啟動器：有下載好的新版程式內容（bundles\<版本>.asar）就載入它，否則用安裝時內建的版本。
// 更新不必再跑安裝程式，所以不會被 Windows 智慧型應用程式控制擋下。
// 這個檔案只有安裝時那一份會被執行，之後的更新換不到它，所以要盡量簡單、不能出錯。
const { app } = require('electron');
const fs = require('original-fs'); // 讀寫 .asar 檔本身，不要被當成資料夾
const path = require('path');
const { pickBundle } = require('./bundles');

// 中文 productName 在某些 Linux 環境會讓預設路徑變成 appData 根目錄，這時改用固定資料夾（和 main.js 一致）
if (path.resolve(app.getPath('userData')) === path.resolve(app.getPath('appData'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'quota-monitor'));
}

const dir = path.join(app.getPath('userData'), 'bundles');
const stateFile = path.join(dir, 'state.json');
let state = {};
let chosen = null;
try {
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* 第一次 */ }
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const r = pickBundle(state, files, require('../package.json').version);
  state = r.state;
  chosen = r.version;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
} catch { /* 出錯就用內建版本 */ }

global.quotaBundle = { dir, stateFile, version: chosen };
if (chosen) {
  try {
    require(path.join(dir, `${chosen}.asar`, 'src', 'main.js'));
  } catch (e) {
    // 新版一載入就出錯：記成壞掉，改用內建版本
    console.error('bundle failed', chosen, e);
    try { fs.writeFileSync(stateFile, JSON.stringify({ ...state, bad: [...(state.bad || []), chosen], trying: null })); } catch { /* 寫不了就算了 */ }
    global.quotaBundle.version = null;
    require('./main.js');
  }
} else {
  require('./main.js');
}
