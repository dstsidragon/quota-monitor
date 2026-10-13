// Reset 相關公告：
// - tibo（@thsottiaux）的 reset 貼文：tokenusage.dev 的免費追蹤 API（第三方，只收 Codex）
// - Anthropic / OpenAI 官方狀態頁 RSS
// - 選填：X API Bearer Token，讀官方 X 帳號與 tibo 的最新貼文

const RESET_RE = /(reset|rate.?limit|usage.?limit|limits?\b|quota|額度|重置)/i;

const STATUS_FEEDS = [
  { provider: 'claude', source: 'Claude 狀態頁', url: 'https://status.claude.com/history.rss' },
  { provider: 'codex', source: 'OpenAI 狀態頁', url: 'https://status.openai.com/feed.rss' },
];

const DEFAULT_X_ACCOUNTS = [
  { handle: 'thsottiaux', provider: 'codex' },
  { handle: 'OpenAIDevs', provider: 'codex' },
  { handle: 'claudeai', provider: 'claude' },
  { handle: 'AnthropicAI', provider: 'claude' },
];

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : '';
}

function parseRss(xml, feed) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    const title = tag(body, 'title');
    const date = Date.parse(tag(body, 'pubDate'));
    items.push({
      provider: feed.provider,
      source: feed.source,
      title,
      url: tag(body, 'link'),
      at: Number.isNaN(date) ? null : new Date(date).toISOString(),
      isReset: RESET_RE.test(title),
    });
  }
  return items;
}

function parseTokenusage(json) {
  return (json.resets || []).map((r) => ({
    provider: 'codex',
    source: '@thsottiaux（tibo）',
    title: r.resetType === 'banked' ? 'tibo 宣布 Codex 額度 reset（可存用）'
      : r.resetType === 'both' ? 'tibo 宣布 Codex 額度 reset（自動＋可存用）'
      : 'tibo 宣布 Codex 額度 reset',
    url: r.url,
    at: r.postedAt,
    isReset: true,
    id: `x:${r.postId}`,
  }));
}

async function fetchStatusFeeds(fetchImpl) {
  const results = await Promise.allSettled(STATUS_FEEDS.map(async (f) => {
    const res = await fetchImpl(f.url, { headers: { Accept: 'application/rss+xml, text/xml' } })
      .catch((e) => { throw new Error(`${f.source}連不上（${e.message}）`); });
    if (!res.ok) throw new Error(`${f.source} 回應 ${res.status}`);
    return parseRss(await res.text(), f).slice(0, 15);
  }));
  return collect(results);
}

async function fetchTibo(fetchImpl) {
  const res = await fetchImpl('https://tokenusage.dev/api/resets', { headers: { Accept: 'application/json' } })
    .catch((e) => { throw new Error(`tokenusage.dev 連不上（${e.message}）`); });
  if (!res.ok) throw new Error(`tokenusage.dev 回應 ${res.status}`);
  return parseTokenusage(await res.json()).slice(0, 20);
}

const xUserIds = new Map();

async function fetchX(fetchImpl, bearer, accounts = DEFAULT_X_ACCOUNTS) {
  const headers = { Authorization: `Bearer ${bearer}` };
  const results = await Promise.allSettled(accounts.map(async ({ handle, provider }) => {
    let id = xUserIds.get(handle);
    if (!id) {
      const r = await fetchImpl(`https://api.x.com/2/users/by/username/${handle}`, { headers });
      if (!r.ok) throw new Error(`X API 查 @${handle} 回應 ${r.status}`);
      id = (await r.json()).data.id;
      xUserIds.set(handle, id);
    }
    const r = await fetchImpl(`https://api.x.com/2/users/${id}/tweets?max_results=10&tweet.fields=created_at&exclude=replies,retweets`, { headers });
    if (!r.ok) throw new Error(`X API 讀 @${handle} 回應 ${r.status}`);
    return ((await r.json()).data || [])
      .filter((t) => RESET_RE.test(t.text))
      .map((t) => ({
        provider, source: `@${handle}`, title: t.text.slice(0, 140),
        url: `https://x.com/${handle}/status/${t.id}`, at: t.created_at, isReset: true, id: `x:${t.id}`,
      }));
  }));
  return collect(results);
}

function collect(results) {
  const items = [];
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push(r.reason.message);
  }
  return { items, errors };
}

async function fetchNews(fetchImpl, { xBearerToken } = {}) {
  const tasks = [
    fetchStatusFeeds(fetchImpl),
    fetchTibo(fetchImpl).then((items) => ({ items, errors: [] })),
  ];
  if (xBearerToken) tasks.push(fetchX(fetchImpl, xBearerToken));
  const items = [];
  const errors = [];
  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === 'fulfilled') { items.push(...r.value.items); errors.push(...r.value.errors); }
    else errors.push(r.reason.message);
  }
  // 同一則 X 貼文可能同時來自 tokenusage 和 X API，去重
  const seen = new Set();
  const unique = items.filter((i) => {
    const key = i.id || i.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return { items: unique, errors };
}

module.exports = { fetchNews, parseRss, parseTokenusage, RESET_RE };
