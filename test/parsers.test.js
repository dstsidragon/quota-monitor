const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseClaudeUsage, parseCodexUsage, parseSessionRateLimits, fetchClaude, fetchCodex } = require('../src/providers');
const { parseRss, parseTokenusage, parseOembedText, fetchTibo, fetchStatusFeeds, fetchTweetText, mergeNews } = require('../src/news');

test('Claude 舊版扁平格式', () => {
  const w = parseClaudeUsage({
    five_hour: { utilization: 42, resets_at: '2026-10-13T20:00:00Z' },
    seven_day: { utilization: 10.5, resets_at: '2026-10-18T00:00:00Z' },
    seven_day_opus: null,
  });
  assert.deepStrictEqual(w.map((x) => x.label), ['5 小時', '每週（全部模型）']);
  assert.strictEqual(w[0].usedPercent, 42);
});

test('Claude 新版 limits 陣列優先', () => {
  const w = parseClaudeUsage({
    five_hour: null,
    limits: [
      { kind: 'session', percent: 30, resets_at: '2026-10-13T20:00:00Z' },
      { kind: 'weekly_scoped', percent: 5, resets_at: 1792000000, scope: { model: { display_name: 'Opus' } } },
    ],
  });
  assert.strictEqual(w[1].label, '每週（Opus）');
  assert.strictEqual(w[1].resetsAt, new Date(1792000000 * 1000).toISOString());
});

test('Claude 看不懂的格式會丟 format 錯誤', () => {
  assert.throws(() => parseClaudeUsage({}), (e) => e.kind === 'format');
});

test('Codex wham/usage', () => {
  const r = parseCodexUsage({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: 1792000000 },
      secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_after_seconds: 1000, reset_at: 1792500000 },
    },
  });
  assert.strictEqual(r.plan, 'plus');
  assert.deepStrictEqual(r.windows.map((x) => x.label), ['5 小時', '每週']);
});

test('Codex session 紀錄的 token_count', () => {
  const line = JSON.stringify({ timestamp: '2026-10-13T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 12, window_minutes: 300, resets_at: 1792000000 },
    secondary: { used_percent: 40, window_minutes: 10080, resets_in_seconds: 3600 },
  } } });
  const r = parseSessionRateLimits(line, 0);
  assert.strictEqual(r.windows[1].label, '每週');
  assert.strictEqual(r.windows[1].resetsAt, '2026-10-13T11:00:00.000Z');
  assert.strictEqual(parseSessionRateLimits('{"type":"other"}', 0), null);
});

function fakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
  process.env.CODEX_HOME = path.join(dir, '.codex');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '13'), { recursive: true });
  return dir;
}
const res = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => body });

test('fetchClaude 帶正確 header，過期時不打 API', async () => {
  fakeHome();
  const f = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
  fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 1e6, subscriptionType: 'max' } }));
  let seen;
  const r = await fetchClaude(async (url, opts) => { seen = opts.headers; return res(200, { five_hour: { utilization: 1, resets_at: null } }); });
  assert.strictEqual(seen.Authorization, 'Bearer tok');
  assert.strictEqual(seen['anthropic-beta'], 'oauth-2025-04-20');
  assert.strictEqual(r.plan, 'max');
  fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1 } }));
  await assert.rejects(fetchClaude(async () => assert.fail('不該打 API')), (e) => e.kind === 'expired');
});

test('fetchCodex 失敗時退回本機 session 紀錄', async () => {
  fakeHome();
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: 'a', account_id: 'acc' } }));
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '13', 'rollout.jsonl'),
    JSON.stringify({ timestamp: '2026-10-13T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 33, window_minutes: 300, resets_at: 1792000000 } } } }) + '\n');
  let seen;
  const r = await fetchCodex(async (url, opts) => { seen = opts.headers; return res(401, {}); });
  assert.strictEqual(seen['ChatGPT-Account-Id'], 'acc');
  assert.strictEqual(r.source, 'session-log');
  assert.strictEqual(r.windows[0].usedPercent, 33);
  assert.match(r.note, /登入已失效/);
});

test('RSS 與 tokenusage 解析、合併排序', async () => {
  const rss = `<rss><channel><item><title><![CDATA[Codex usage limits reset early]]></title><link>https://s/1</link><pubDate>Fri, 09 Oct 2026 23:26:59 GMT</pubDate></item>
  <item><title>Elevated errors &amp; latency</title><link>https://s/2</link><pubDate>Sat, 10 Oct 2026 00:26:44 GMT</pubDate></item></channel></rss>`;
  const items = parseRss(rss, { provider: 'codex', source: 'OpenAI 狀態頁' });
  assert.strictEqual(items[0].isReset, true);
  assert.strictEqual(items[1].title, 'Elevated errors & latency');
  assert.strictEqual(items[1].isReset, false);
  const tu = parseTokenusage({ resets: [{ postId: '1', url: 'https://x.com/i/status/1', postedAt: '2026-10-10T22:16:20.000Z', resetType: 'automatic' }] });
  assert.strictEqual(tu[0].isReset, true);

  const fake = async (url) => {
    if (url.includes('tokenusage')) return res(200, { lastPolledAt: '2026-10-11T00:00:30Z', resets: [{ postId: '1', url: 'https://x.com/i/status/1', postedAt: '2026-10-11T00:00:00Z', resetType: 'banked' }] });
    if (url.includes('claude')) return res(500, '');
    return res(200, rss);
  };
  const tibo = await fetchTibo(fake);
  assert.strictEqual(tibo.lastPolledAt, '2026-10-11T00:00:30Z');
  assert.strictEqual(tibo.items[0].kind, '可存用');
  assert.strictEqual(tibo.items[0].postId, '1');
  const status = await fetchStatusFeeds(fake);
  assert.strictEqual(status.errors.length, 1);
  const merged = mergeNews([tibo.items, [{ ...tibo.items[0], title: '重複的' }], status.items]);
  assert.strictEqual(merged[0].source, '@thsottiaux（tibo）');
  assert.strictEqual(merged.filter((i) => i.id === 'x:1').length, 1);
});

test('oEmbed 取貼文內文', async () => {
  const html = '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">We&#39;re resetting Codex rate limits for everyone &amp; enjoy!<br>More soon <a href="https://t.co/abc">https://t.co/abc</a></p>&mdash; Tibo (@thsottiaux) <a href="https://twitter.com/thsottiaux/status/1">October 20, 2026</a></blockquote>';
  assert.strictEqual(parseOembedText(html), "We're resetting Codex rate limits for everyone & enjoy!\nMore soon");
  assert.strictEqual(parseOembedText(''), null);
  let seen;
  const text = await fetchTweetText(async (url) => { seen = url; return res(200, { html }); }, '123');
  assert.match(seen, /^https:\/\/publish\.twitter\.com\/oembed\?/);
  assert.match(decodeURIComponent(seen), /status\/123/);
  assert.match(text, /^We're resetting/);
  assert.strictEqual(await fetchTweetText(async () => res(404, {}), '1'), null);
});

test('fetchClaudeWeb 選有 chat 的組織並讀 usage', async () => {
  const { fetchClaudeWeb } = require('../src/providers');
  const urls = [];
  const r = await fetchClaudeWeb(async (url) => {
    urls.push(url);
    if (url.endsWith('/organizations')) return res(200, [{ uuid: 'api', capabilities: ['api'] }, { uuid: 'me', capabilities: ['chat', 'claude_max'] }]);
    return res(200, { five_hour: { utilization: 20, resets_at: '2026-10-13T20:00:00Z' } });
  });
  assert.strictEqual(urls[1], 'https://claude.ai/api/organizations/me/usage');
  assert.strictEqual(r.plan, 'max');
  assert.strictEqual(r.source, 'web');
  await assert.rejects(fetchClaudeWeb(async () => res(403, {})), (e) => e.kind === 'web-login');
});

const { regionStats, pickTone, cropRect, bandRects } = require('../src/backdrop');

test('背景亮度：分段判斷字色，太花才墊底', () => {
  // 一張 20×4 的截圖：左半灰藍色視窗、右半深藍桌布（使用者截圖裡的顏色）
  const w = 20, h = 4;
  const img = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = x < 10 ? [136, 160, 176] : [0, 40, 136];
    img.set([b, g, r, 255], (y * w + x) * 4);
  }
  assert.deepEqual(pickTone(regionStats(img, w, h, 0, 0.5)), { tone: 'light', plate: 0 });
  assert.deepEqual(pickTone(regionStats(img, w, h, 0.5, 1)), { tone: 'dark', plate: 0 });
  // 跨在兩種背景上：哪種字都有一邊看不清楚，墊底
  assert.equal(pickTone(regionStats(img, w, h, 0.3, 0.7)).plate, 2);
  // 黑白條紋（很花的桌布）也墊底
  const stripes = Buffer.from(Array.from({ length: 40 }, (_, i) => (i % 2 ? [235, 235, 235, 255] : [25, 25, 25, 255])).flat());
  assert.equal(pickTone(regionStats(stripes, 40, 1)).plate, 2);
  // 對比差不多時維持原本的字色；墊了底要明顯夠清楚才拿掉
  const mid = { lum: 0.186, lo: 0.186, hi: 0.186 };
  assert.equal(pickTone(mid, { tone: 'light' }).tone, 'light');
  assert.equal(pickTone(mid, { tone: 'dark' }).tone, 'dark');
  const ok55 = { lum: 0.14, lo: 0.14, hi: 0.14 }; // 白字對比約 5.5
  assert.equal(pickTone(ok55, { tone: 'dark', plate: 0 }).plate, 0);
  assert.equal(pickTone(ok55, { tone: 'dark', plate: 1 }).plate, 1);
  assert.equal(pickTone(ok55, { tone: 'dark', plate: 2 }).plate, 1);
  assert.equal(pickTone({ lum: 0.1, lo: 0.1, hi: 0.1 }, { tone: 'dark', plate: 1 }).plate, 0); // 對比 7
  assert.deepEqual(pickTone(null, { tone: 'dark', plate: 0 }), { tone: 'dark', plate: 0 });
  // 量小工具上下緣外面的兩條，不量小工具本身；貼著螢幕上緣時只有下面那條
  assert.deepEqual(bandRects({ x: 10, y: 20, width: 100, height: 11 }, { width: 480, height: 270 }), [
    { x: 10, y: 17, width: 100, height: 3 }, { x: 10, y: 31, width: 100, height: 3 }]);
  assert.deepEqual(bandRects({ x: 10, y: 0, width: 100, height: 11 }, { width: 480, height: 270 }), [
    { x: 10, y: 11, width: 100, height: 3 }]);
  assert.deepEqual(bandRects({ x: 0, y: 0, width: 480, height: 270 }, { width: 480, height: 270 }), []);
  assert.deepEqual(
    cropRect({ x: 1900, y: 40, width: 800, height: 42 }, { x: 1920, y: 0, width: 1920, height: 1080 }, { width: 480, height: 270 }),
    { x: 0, y: 10, width: 200, height: 11 },
  );
});

const { cmpVersion, pickBundle } = require('../src/bundles');

test('程式內容更新：挑最新、沒壞掉、比內建新的版本', () => {
  assert.ok(cmpVersion('0.10.0', '0.9.9') > 0);
  assert.strictEqual(cmpVersion('0.7.0', '0.7.0'), 0);
  const files = ['0.6.9.asar', '0.7.1.asar', '0.7.2.asar', '0.7.3.asar.part', 'state.json'];
  // 第一次試 0.7.2
  let r = pickBundle({}, files, '0.7.0');
  assert.strictEqual(r.version, '0.7.2');
  assert.strictEqual(r.state.trying, '0.7.2');
  // 0.7.2 沒能確認就又啟動：當成壞掉，退回 0.7.1
  r = pickBundle(r.state, files, '0.7.0');
  assert.strictEqual(r.version, '0.7.1');
  assert.deepStrictEqual(r.state.bad, ['0.7.2']);
  // 已確認沒問題的版本，再開一次（例如小工具開著時又點捷徑）不會被誤判
  r = pickBundle({ ok: '0.7.2', trying: null, bad: [] }, files, '0.7.0');
  assert.strictEqual(r.state.trying, null);
  r = pickBundle(r.state, files, '0.7.0');
  assert.strictEqual(r.version, '0.7.2');
  assert.deepStrictEqual(r.state.bad, []);
  // 都不比內建新就用內建
  assert.strictEqual(pickBundle({}, ['0.6.9.asar'], '0.7.0').version, null);
});
