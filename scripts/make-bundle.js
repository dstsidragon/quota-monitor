// 發布用：把打包好的程式內容（app.asar）複製成 quota-monitor-<版本>.asar，並寫出 bundle.json
// （版本、檔名、大小、檢查碼）。已安裝的小工具讀 bundle.json 判斷有沒有新版，只下載這個檔案來更新。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const version = require('../package.json').version;
const dist = path.join(__dirname, '..', 'dist');
const file = `quota-monitor-${version}.asar`;
const data = fs.readFileSync(path.join(dist, 'win-unpacked', 'resources', 'app.asar'));
fs.writeFileSync(path.join(dist, file), data);
const info = { version, file, size: data.length, sha512: crypto.createHash('sha512').update(data).digest('base64') };
fs.writeFileSync(path.join(dist, 'bundle.json'), JSON.stringify(info, null, 2));
console.log(info);
