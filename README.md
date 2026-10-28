# 額度監控器

常駐在 Windows 系統匣的小視窗，顯示 Claude Code 與 Codex 的剩餘額度、下次 reset 時間，以及 reset 相關公告。

## 使用

1. 從 [Releases](https://github.com/dstsidragon/quota-monitor/releases/latest) 下載 `QuotaMonitor-Setup-x.y.z.exe` 安裝（裝在使用者資料夾，不需要系統管理員）。檔案沒有數位簽章，第一次執行若出現 SmartScreen，按「其他資訊 → 仍要執行」；開著 Windows「智慧型應用程式控制」的電腦會直接擋下安裝檔。之後有新版會自動下載，重新啟動即套用。
2. 視窗會出現在螢幕右下角；按 ✕ 收進系統匣，點系統匣圖示再叫出來，右鍵選單可「立即更新」或「結束」。
3. 滑鼠停在系統匣圖示上，會顯示兩邊剩餘百分比摘要。
4. 按標題列的 ▁ 或系統匣右鍵「極簡模式」縮成一行。一行最右邊只有一個鎖頭：點一下鎖定後，整條對滑鼠完全沒反應（不會變不透明、不能拖曳，點擊直接穿透到後面的視窗），只有鎖頭能點來解鎖；系統匣右鍵也能切換鎖定。沒鎖定時在一行上按右鍵可以展開成完整視窗或收到系統匣。一行裡會列出每個額度視窗，滑鼠停著可看完整資訊。tibo 24 小時內宣布過 reset 時，最右邊會多一個「tibo reset」提示，沒點開過會閃，點一下打開貼文。
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
- 新版本每 30 分鐘自動檢查並在背景下載，下載好後上方（極簡模式在右邊）會出現「更新」按鈕，按一下就重新啟動套用；系統匣右鍵和設定裡也能「檢查新版本」。
- 更新只下載新的程式內容（Release 裡的 `bundle.json` 與 `quota-monitor-x.y.z.asar`，比對 SHA-512 後存到資料夾 `bundles\`），不跑安裝程式、不換執行檔，所以開著「智慧型應用程式控制」也能更新。新版第一次啟動沒能開出畫面，下次啟動會自動退回上一版，並跳過那一版。
- tibo 的 reset 貼文每分鐘檢查一次（tokenusage.dev 偵測到貼文通常只差 30 秒左右），列表與通知會顯示貼文原文（透過 X 公開的 oEmbed 取得）；一偵測到就立刻重查 Codex 額度，3 分鐘後再查一次。
- 狀態頁與 X API 依「公告更新間隔」檢查。電腦關機或睡眠時發的 reset 公告，開機後 24 小時內仍會補通知。
- 出現新的 reset 公告、某個額度視窗的使用率突然下降 15% 以上（代表被 reset），或剩餘低於設定的百分比（預設 10%），會跳 Windows 通知。
- 額度到 reset 時間後 20 秒會自動重查；睡眠喚醒或解鎖後也會自動更新。所有請求都不走 HTTP 快取。
- 背景預設完全透明，直接看到桌面，文字維持不透明的鮮豔顏色，外圍加一圈細描邊；滑鼠移上去才變不透明。文字顏色預設「自動」：每 3 秒看一下小工具背後的亮度（Electron desktopCapturer 的縮圖，擷取的那一下把小工具自己排除在外；只在本機算亮度，不存檔、不傳出去），依對比挑深色字或白色字。極簡列每個項目各自判斷，所以跨在亮暗兩種背景上時左右可以用不同的字色；背景太花或剛好跨在亮暗交界上時，那一組字後面會墊一層半透明的膠囊底（很花時墊厚一點），展開的視窗則整個墊底；也可以在設定固定成深色字、白色字或跟隨 Windows。Windows 11 可在設定或系統匣右鍵「背景」改成毛玻璃模糊。底色濃度和「滑過變不透明」也能在設定調整。
- X Token 用 Windows 的加密儲存（DPAPI）存在 `%APPDATA%\quota-monitor\settings.json`。

## 開發

```
npm install
npm start          # 開發模式執行
npm test           # 解析器與抓取邏輯測試
npm run dist       # 在 Windows 上打包安裝檔

發布新版：改 package.json 的 version，推上 main，GitHub Actions 會在 Windows 上打包，把安裝檔和程式內容更新檔（`scripts/make-bundle.js` 產生）發布到 Releases，已安裝的小工具會自動更新。
```
