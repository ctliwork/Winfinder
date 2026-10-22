# Finder for Windows

仿 macOS Finder 的 Windows 檔案管理器，重點是直欄檢視（column view）。
後端用 Rust（Tauri 2），介面是 HTML／CSS／JS。

## 架構

| 部分 | 位置 | 說明 |
|---|---|---|
| 介面 | `renderer/` | 所有檢視、Quick Look、選單、鍵盤操作 |
| Rust 後端 | `src-tauri/src/` | 讀目錄、搜尋、檔案操作、縮圖、資料夾監看 |
| Tauri 橋接 | `renderer/bridge-tauri.js` | 把介面的 API 對到 Rust 指令 |
| Electron 外殼 | `main.js`、`preload.js` | 只用於自動化介面測試，不是正式版本 |

Rust 後端各模組：

- `fsops.rs`：列出資料夾（Windows 上大小、時間、隱藏／系統屬性在列目錄時一次取得，不必逐檔查詢）、重新命名、新增資料夾、拷貝／搬移
- `search.rs`：用 jwalk 多執行緒搜尋子資料夾
- `places.rs`：側邊欄位置、磁碟代號與名稱、剩餘空間
- `thumb.rs`：Windows 殼層縮圖（圖片、影片、PDF、Office 檔）
- `lib.rs`：Tauri 指令、資料夾監看（notify）、視窗（Windows 11 Mica 效果）

## 效能實測

列出 20,000 個檔案的資料夾（Linux 開發環境，5 次取最佳）：

| 後端 | 時間 |
|---|---|
| Rust（`fsops::list`） | 33 ms |
| Node（舊版 Electron 後端） | 749 ms |

Windows 上的差距預期更大（Node 每個檔案都要另外開檔查詢），但還沒在 Windows 實測。
自己測：

```bash
cd src-tauri && cargo run --release --example bench_list -- C:\某個大資料夾
node bench/bench-list.js C:\某個大資料夾
```

## 開發與打包

需要 Node 22 和 Rust（stable）。Windows 上另需 WebView2（Windows 11 內建）。

```bash
npm install
npm run dev      # 開發模式
npm run build    # 產生安裝檔：src-tauri/target/release/bundle/nsis/*.exe
npm test         # Rust 單元測試
```

指定起始資料夾：`finder-win.exe --dir=D:\Projects`

打包 Windows 安裝檔改為手動：到 GitHub 的 Actions 頁籤，選 finder-win，按「Run workflow」。它會在 Windows 上跑 Rust 測試、打包，並更新 GitHub 上名為 `finder-win-latest` 的預先發行版本，安裝檔在那裡下載。推送程式碼不會自動打包。

## 功能

- 四種檢視：圖像、列表、**直欄**（預設）、圖庫
- 直欄檢視：點選逐層展開、右側預覽欄、方向鍵上下選取、左右切換欄位
- 空白鍵 Quick Look：圖片、影片、音訊、PDF、文字／原始碼，開關有縮放動畫
- 側邊欄（個人專屬、位置、自訂釘選）、路徑列、狀態列與剩餘空間
- 拖放：同磁碟搬移、跨磁碟或按 Ctrl 拷貝；可拖到其他 App、也可從檔案總管拖進來
- 新增資料夾、重新命名、製作副本、拷貝／剪下／貼上、丟到資源回收筒
- 目前資料夾即時篩選、含子資料夾的搜尋
- 框選、Shift／Ctrl 多選、打字跳選、資料夾變動自動更新
- Windows 11 Mica 毛玻璃、深色模式、8 種強調色

## 快捷鍵

| 按鍵 | 動作 |
|---|---|
| Ctrl+1/2/3/4 | 圖像／列表／直欄／圖庫 |
| 空白鍵 | Quick Look |
| Enter、Ctrl+↓ | 打開 |
| F2 | 重新命名 |
| Delete | 丟到資源回收筒 |
| Alt+← / Alt+→ / Alt+↑ | 上一頁／下一頁／上層 |
| Ctrl+Shift+N | 新增資料夾 |
| Ctrl+Shift+. | 顯示隱藏項目 |
| Ctrl+F | 搜尋 |
| Ctrl+= / Ctrl+- | 圖像大小 |

## 待做（對齊 Finder／Files）

- 分頁、雙窗格
- 列表檢視展開子資料夾、超大資料夾虛擬捲動
- Windows 原生右鍵選單、與檔案總管互通的剪貼簿
- 壓縮／解壓縮、顏色標籤、取得資訊、復原（Ctrl+Z）
