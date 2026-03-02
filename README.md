# Claude Code Statusline

自訂 Claude Code 的 statusline，顯示模型資訊、專案路徑、Git 分支、context window 用量及 API 用量。

## 顯示內容

```
▓▓░░░░░░░░ 20% | ▓░░░░ 18% (~3h 42m) | ░░░░░ 2% (~6d 8h)
Sonnet 4.6 | my-project  ⎇ main
```

- **第一行**：context window 用量 | 5 小時用量 (剩餘時間) | 7 天用量 (剩餘時間)
- **第二行**：模型名稱 | 資料夾名稱 ⎇ Git 分支

### 顏色指示

- 灰色：用量正常
- 青色：用量超過時間比例但尚未達臨界值
- 黃色：用量 ≥ 70%
- 橘色：用量 ≥ 80%
- 紅色：用量 ≥ 90%

終端寬度不足時會自動省略次要資訊。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `statusline.mjs` | 讀取 Claude Code JSON (stdin) 與用量快取，輸出雙行 statusline |
| `fetch-usage.mjs` | 從 Anthropic API 獲取用量統計並寫入快取檔案 |

## 設定方式

在 `~/.claude/settings.json` 中加入以下設定：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline/statusline.mjs",
    "padding": 0
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/statusline/fetch-usage.mjs &"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/statusline/fetch-usage.mjs --force &"
          }
        ]
      }
    ]
  }
}
```

- **statusLine**：頂層設定，指定 statusline 的顯示命令
- **PreToolUse**：工具呼叫前於背景更新用量快取（快取 60 秒內不重複抓取）
- **Stop**：對話結束時於背景強制更新快取

## 需求

- Node.js ≥ 18
- Claude Code CLI（需已登入以取得 OAuth token）
