// 文字顏色「自動」：看小工具背後桌面的亮度，亮就用深色字、暗就用白色字。
// 只在本機算一個亮度值，畫面不存檔也不傳出去。

// BGRA 像素的亮度中位數（0–1）。用中位數，小工具自己的文字不會影響判斷。
function medianLuma(bgra) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i + 2 < bgra.length; i += 4) {
    hist[(bgra[i] * 29 + bgra[i + 1] * 150 + bgra[i + 2] * 77) >> 8]++;
    n++;
  }
  if (!n) return null;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc * 2 >= n) return v / 255;
  }
  return null;
}

// 中間留一段不切換，避免背景剛好半亮半暗時一直閃
function pickBackdrop(luma, current) {
  if (luma == null) return current;
  if (luma >= 0.58) return 'light';
  if (luma <= 0.42) return 'dark';
  return current || (luma >= 0.5 ? 'light' : 'dark');
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

module.exports = { medianLuma, pickBackdrop, cropRect };
