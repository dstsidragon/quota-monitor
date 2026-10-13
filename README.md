# 額度監控器

常駐在 Windows 系統匣的小視窗，顯示 Claude Code 與 Codex 的剩餘額度、下次 reset 時間，以及 reset 相關公告。

## 使用

1. 從 [Releases](https://github.com/dstsidragon/quota-monitor/releases/latest) 下載 `QuotaMonitor-Setup-x.y.z.exe` 安裝（裝在使用者資料夾，不需要系統管理員）。檔案沒有數位簽章，第一次執行若出現 SmartScreen，按「其他資訊 → 仍要執行」。之後有新版會自動下載，重新啟動即套用。
2. 視窗會出現在螢幕右下角；按 ✕ 收進系統匣，點系統匣圖示再叫出來，右鍵選單可「立即更新」或「結束」。
3. 滑鼠停在系統匣圖示上，會顯示兩邊剩餘百分比摘要。
4. 按標題列的 ▁ 或系統匣右鍵「極簡模式」縮成一行；按 ▢ 展開。一行裡每家只顯示第一個額度視窗和剩最少的那個，滑鼠停著可看完整資訊。
5. ⚙ 設定：更新間隔、保持最上層、開機自動啟動、通知、選填的 X API Token。

前提：Codex CLI 已用 ChatGPT 帳號登入過。Claude 若只用桌面版、沒有 CLI 登入資料，按卡片上的「登入 claude.ai 讀取額度」，在小工具自己的視窗裡登入一次即可（Google 登入可能被擋，改用 email 驗證碼）。

## 資料來源

| 項目 | 來源 | 備註 |
|---|---|---|
| Claude Code 額度 | `%USERPROFILE%\.claude\.credentials.json` 的 token → `api.anthropic.com/api/oauth/usage`（CLI `/usage` 用的端點） | 非公開端點，可能改版 |
| Claude 額度（桌面版備案） | 小工具內登入的 claude.ai → `claude.ai/api/organizations/{org}/usage` | 非公開端點；登入狀態存在小工具自己的資料夾 |
| Codex 額度 | `%USERPROFILE%\.codex\auth.json` 的 token → `chatgpt.com/backend-api/wham/usage`（CLI `/status` 用的端點） | 非公開端點；失敗時改讀 `~/.codex/sessions` 裡最後一次的額度 |
| tibo 的 reset 貼文 | `tokenusage.dev/api/resets`（第三方免費追蹤，只收 @thsottiaux 的 Codex reset 貼文） | 第三方服務，隨時可能停 |
| 官方狀態 | `status.claude.com/history.rss`、`status.openai.com/feed.rss` | 標題含 reset／limit／quota 會標成 reset |
| 官方 X 帳號 | X API v2（選填 Bearer Token）：@thsottiaux、@OpenAIDevs、@claudeai、@AnthropicAI | X API 讀取要付費 |

## 行為說明

- 憑證只在本機讀取，不會刷新也不會寫回，避免把 CLI 登出。token 過期時會提示「開一下 CLI」，CLI 啟動時會自己更新。
- 預設每 5 分鐘查一次額度、每 15 分鐘查一次公告；被限流（429）時自動拉長間隔。
- 出現新的 reset 公告，或某個額度視窗的使用率突然下降 15% 以上（代表被 reset），會跳 Windows 通知。
- X Token 用 Windows 的加密儲存（DPAPI）存在 `%APPDATA%\quota-monitor\settings.json`。

## 開發

```
npm install
npm start          # 開發模式執行
npm test           # 解析器與抓取邏輯測試
npm run dist       # 在 Windows 上打包安裝檔

發布新版：改 package.json 的 version，推上 main，再推 `v版本號` 標籤；GitHub Actions 會在 Windows 上打包並發布到 Releases，已安裝的小工具會自動更新。
```
