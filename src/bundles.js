// 更新只換「程式內容」（.asar 檔，不是執行檔）：Windows 的智慧型應用程式控制會擋下沒有簽章的新執行檔，
// 但不會管 .asar。新版下載到 資料夾\bundles\<版本>.asar，啟動時由 boot.js 挑最新、沒壞掉的一份載入。

function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// state.ok：確定開得出畫面的版本；state.trying：上次啟動時第一次試的版本。
// 上次試的版本還沒被確認就又啟動，表示那次沒能開出畫面，當成壞掉不再用。
// 已經確認過的版本不再標成「試用中」，所以小工具開著時再點一次捷徑也不會誤判。
function pickBundle(state, files, builtin) {
  const bad = new Set(state.bad || []);
  if (state.trying && state.trying !== state.ok) bad.add(state.trying);
  let best = null;
  for (const f of files) {
    const m = /^(\d+\.\d+\.\d+)\.asar$/.exec(f);
    if (!m || bad.has(m[1]) || cmpVersion(m[1], builtin) <= 0) continue;
    if (!best || cmpVersion(m[1], best) > 0) best = m[1];
  }
  const trying = best && best !== state.ok ? best : null;
  return { version: best, state: { ok: state.ok || null, bad: [...bad], trying } };
}

module.exports = { cmpVersion, pickBundle };
