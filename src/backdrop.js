// 文字顏色「自動」：看小工具背後桌面的亮度，亮就用深色字、暗就用白色字。
// 極簡列分成幾段各自判斷（例如左半在灰色視窗上、右半在深藍桌布上），
// 背景太花或是中間亮度、兩種字都不夠清楚時，那一段字後面墊一層半透明底。
// 只在本機算亮度，畫面不存檔也不傳出去。

// sRGB 0–255 → 線性亮度（WCAG 對比的算法）
const LIN = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const DARK_TEXT = 0.0037; // 淺色背景上的深色字 #0a0c10 的亮度
const MIN_CONTRAST = 5; // 字小又細，比一般建議的 4.5:1 再嚴一點

// 截圖（BGRA）中某個左右範圍（視窗寬度的比例 0–1）的背景亮度：
// 中位數，以及偏暗、偏亮的那一側（第 15、85 百分位，字底下有亮有暗時會拉開）
function regionStats(bgra, width, height, from = 0, to = 1) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(from * width)));
  const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil(to * width)));
  const v = [];
  for (let y = 0; y < height; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (i + 2 < bgra.length) v.push(0.2126 * LIN[bgra[i + 2]] + 0.7152 * LIN[bgra[i + 1]] + 0.0722 * LIN[bgra[i]]);
    }
  }
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { lum: at(0.5), lo: at(0.15), hi: at(0.85) };
}

const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// tone：dark＝深色背景、用白字；light＝淺色背景、用深色字。兩種字對比差不多時維持原本的，避免來回切換。
// plate：選好的字碰到最不利的那一側（白字看最亮處、深色字看最暗處）對比不夠就墊底，
// 0＝不用墊、1＝薄薄一層、2＝背景很花，墊厚一點；要明顯夠清楚才降級，避免一下有一下沒有。
function pickTone(stats, prev = {}) {
  if (!stats) return prev;
  const white = contrast(1, stats.lum);
  const dark = contrast(stats.lum, DARK_TEXT);
  let tone = dark >= white ? 'light' : 'dark';
  if (prev.tone && prev.tone !== tone && Math.max(white, dark) < 1.25 * Math.min(white, dark)) tone = prev.tone;
  const worst = tone === 'dark' ? contrast(1, stats.hi) : contrast(stats.lo, DARK_TEXT);
  let plate = worst < 3 ? 2 : worst < MIN_CONTRAST ? 1 : 0;
  if (prev.plate === 2 && worst < 4) plate = 2;
  if (prev.plate >= 1 && plate === 0 && worst < MIN_CONTRAST + 1) plate = 1;
  return { tone, plate };
}

// 把視窗位置換算成整個螢幕縮圖裡的範圍
function cropRect(win, display, thumb) {
  const k = thumb.width / display.width;
  const x = Math.max(0, Math.min(thumb.width - 1, Math.round((win.x - display.x) * k)));
  const y = Math.max(0, Math.min(thumb.height - 1, Math.round((win.y - display.y) * k)));
  return {
    x, y,
    width: Math.max(1, Math.min(thumb.width - x, Math.round(win.width * k))),
    height: Math.max(1, Math.min(thumb.height - y, Math.round(win.height * k))),
  };
}

module.exports = { regionStats, pickTone, cropRect };
