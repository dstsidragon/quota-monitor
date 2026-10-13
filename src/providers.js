// 讀取 Claude Code 與 Codex 的額度。
// 兩邊用的都是 CLI 自己呼叫的非公開端點，官方隨時可能改動。
// 憑證只在本機讀取，絕不寫回、不刷新，避免把 CLI 登出。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

class QuotaError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'no-login' | 'web-login' | 'expired' | 'rate-limited' | 'network' | 'format'
  }
}

// ---------- Claude Code ----------

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readClaudeCredentials() {
  const file = path.join(claudeConfigDir(), '.credentials.json');
  let raw = null;
  if (fs.existsSync(file)) {
    raw = fs.readFileSync(file, 'utf8');
  } else if (process.platform === 'darwin') {
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' });
    } catch { /* 沒有 keychain 項目 */ }
  }
  if (!raw) throw new QuotaError('no-login', '找不到 Claude Code 登入資料，請先在終端機執行 claude 並登入。');
  const oauth = JSON.parse(raw).claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new QuotaError('no-login', '這台電腦的 Claude Code CLI 沒有訂閱帳號登入資料（桌面版登入不會寫在這裡）。');
  return oauth;
}

function toIso(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  return new Date(v).toISOString();
}

// 回應格式有新舊兩版：舊版是 five_hour / seven_day 等扁平欄位，新版是 limits 陣列。
function parseClaudeUsage(json) {
  const windows = [];
  if (Array.isArray(json.limits) && json.limits.length) {
    for (const l of json.limits) {
      let label = { session: '5 小時', weekly_all: '每週（全部模型）' }[l.kind] || l.kind;
      if (l.kind === 'weekly_scoped') {
        const name = l.scope && l.scope.model && l.scope.model.display_name;
        label = `每週（${name || '特定模型'}）`;
      }
      if (typeof l.percent === 'number') windows.push({ label, usedPercent: l.percent, resetsAt: toIso(l.resets_at) });
    }
  }
  if (!windows.length) {
    const names = {
      five_hour: '5 小時',
      seven_day: '每週（全部模型）',
      seven_day_opus: '每週（Opus）',
      seven_day_sonnet: '每週（Sonnet）',
    };
    for (const [key, label] of Object.entries(names)) {
      const w = json[key];
      if (w && typeof w.utilization === 'number') windows.push({ label, usedPercent: w.utilization, resetsAt: toIso(w.resets_at) });
    }
  }
  if (!windows.length) throw new QuotaError('format', 'Claude 用量回應格式看不懂，端點可能改版了。');
  return windows;
}

async function fetchClaude(fetchImpl) {
  const cred = readClaudeCredentials();
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    throw new QuotaError('expired', 'Claude Code 登入已過期，開一下 claude 讓它自動更新即可。');
  }
  const res = await fetchImpl(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1 (quota-monitor)',
      Accept: 'application/json',
    },
  }).catch((e) => { throw new QuotaError('network', `連不上 Claude 用量端點（${e.message}）`); });
  if (res.status === 401 || res.status === 403) throw new QuotaError('expired', 'Claude Code 登入已失效，開一下 claude 重新登入。');
  if (res.status === 429) throw new QuotaError('rate-limited', '查詢太頻繁，稍後自動重試。');
  if (!res.ok) throw new QuotaError('network', `Claude 用量端點回應 ${res.status}`);
  return { plan: cred.subscriptionType || null, windows: parseClaudeUsage(await res.json()), source: 'api' };
}

// 備案：用小工具自己視窗裡登入的 claude.ai 帳號（給只用 Claude 桌面版的人）。
// fetchImpl 必須帶著那個登入視窗的 cookie（Electron session.fetch）。
const CLAUDE_WEB = 'https://claude.ai/api';

async function fetchClaudeWeb(fetchImpl) {
  const get = async (url) => {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
      .catch((e) => { throw new QuotaError('network', `連不上 claude.ai（${e.message}）`); });
    if (res.status === 401 || res.status === 403) throw new QuotaError('web-login', '請按下方按鈕登入 claude.ai，才讀得到額度。');
    if (res.status === 429) throw new QuotaError('rate-limited', '查詢太頻繁，稍後自動重試。');
    if (!res.ok) throw new QuotaError('network', `claude.ai 回應 ${res.status}`);
    return res.json();
  };
  const orgs = await get(`${CLAUDE_WEB}/organizations`);
  if (!Array.isArray(orgs) || !orgs.length) throw new QuotaError('web-login', '請按下方按鈕登入 claude.ai，才讀得到額度。');
  // 優先選有聊天功能的個人／團隊組織，跳過純 API 組織
  const org = orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0];
  const usage = await get(`${CLAUDE_WEB}/organizations/${org.uuid}/usage`);
  const plan = (org.capabilities || []).find((c) => /^claude_(max|pro)/.test(c)) || null;
  return { plan: plan && plan.replace('claude_', ''), windows: parseClaudeUsage(usage), source: 'web' };
}

// ---------- Codex ----------

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function readCodexCredentials() {
  const file = path.join(codexHome(), 'auth.json');
  if (!fs.existsSync(file)) throw new QuotaError('no-login', '找不到 Codex 登入資料，請先在終端機執行 codex login。');
  const tokens = JSON.parse(fs.readFileSync(file, 'utf8')).tokens;
  if (!tokens || !tokens.access_token) throw new QuotaError('no-login', 'Codex 不是用 ChatGPT 帳號登入（可能是 API key），沒有訂閱額度可讀。');
  return tokens;
}

function windowLabel(seconds, fallback) {
  if (!seconds) return fallback;
  const h = seconds / 3600;
  if (h <= 24) return `${Math.round(h)} 小時`;
  if (Math.round(h / 24) === 7) return '每週';
  return `${Math.round(h / 24)} 天`;
}

function parseCodexUsage(json) {
  const rl = json.rate_limit;
  if (!rl) throw new QuotaError('format', 'Codex 用量回應格式看不懂，端點可能改版了。');
  const windows = [];
  for (const [key, fallback] of [['primary_window', '主要'], ['secondary_window', '每週']]) {
    const w = rl[key];
    if (!w || typeof w.used_percent !== 'number') continue;
    let resetsAt = null;
    if (w.reset_at) resetsAt = toIso(w.reset_at);
    else if (w.reset_after_seconds != null) resetsAt = new Date(Date.now() + w.reset_after_seconds * 1000).toISOString();
    windows.push({ label: windowLabel(w.limit_window_seconds, fallback), usedPercent: w.used_percent, resetsAt });
  }
  if (!windows.length) throw new QuotaError('format', 'Codex 用量回應裡沒有額度資料。');
  return { plan: json.plan_type || null, windows };
}

// 備案：從 Codex 本機 session 紀錄找最後一次 token_count 事件裡的 rate_limits。
function latestSessionFiles(dir, limit = 5) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push({ p, m: fs.statSync(p).mtimeMs });
    }
  };
  walk(dir);
  return out.sort((a, b) => b.m - a.m).slice(0, limit);
}

function parseSessionRateLimits(line, fileTime) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  const payload = obj.payload || obj.msg || obj;
  if (!payload || payload.type !== 'token_count' || !payload.rate_limits) return null;
  const rl = payload.rate_limits;
  const at = obj.timestamp ? Date.parse(obj.timestamp) : fileTime;
  const windows = [];
  for (const [key, fallback] of [['primary', '主要'], ['secondary', '每週']]) {
    const w = rl[key];
    if (!w || typeof w.used_percent !== 'number') continue;
    let resetsAt = null;
    if (w.resets_at) resetsAt = toIso(w.resets_at);
    else if (w.resets_in_seconds != null) resetsAt = new Date(at + w.resets_in_seconds * 1000).toISOString();
    windows.push({ label: windowLabel(w.window_minutes && w.window_minutes * 60, fallback), usedPercent: w.used_percent, resetsAt });
  }
  return windows.length ? { windows, observedAt: new Date(at).toISOString(), plan: rl.plan_type || null } : null;
}

function readCodexFromSessions() {
  for (const { p, m } of latestSessionFiles(path.join(codexHome(), 'sessions'))) {
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const r = parseSessionRateLimits(lines[i], m);
      if (r) return r;
    }
  }
  return null;
}

async function fetchCodex(fetchImpl) {
  let apiError;
  try {
    const tokens = readCodexCredentials();
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
      'User-Agent': 'codex-cli (quota-monitor)',
      Accept: 'application/json',
    };
    if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
    const res = await fetchImpl(CODEX_USAGE_URL, { headers })
      .catch((e) => { throw new QuotaError('network', `連不上 Codex 用量端點（${e.message}）`); });
    if (res.status === 401 || res.status === 403) throw new QuotaError('expired', 'Codex 登入已失效，開一下 codex 讓它更新登入。');
    if (res.status === 429) throw new QuotaError('rate-limited', '查詢太頻繁，稍後自動重試。');
    if (!res.ok) throw new QuotaError('network', `Codex 用量端點回應 ${res.status}`);
    return { ...parseCodexUsage(await res.json()), source: 'api' };
  } catch (e) {
    apiError = e;
  }
  const fromLog = readCodexFromSessions();
  if (fromLog) return { ...fromLog, source: 'session-log', note: `即時查詢失敗（${apiError.message}），顯示本機紀錄中最後一次的數值。` };
  throw apiError;
}

module.exports = {
  QuotaError, fetchClaude, fetchClaudeWeb, fetchCodex,
  parseClaudeUsage, parseCodexUsage, parseSessionRateLimits,
};
