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
