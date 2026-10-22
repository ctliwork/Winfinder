# Finder for Windows

**下載安裝：** [Finder-for-Windows_x64-setup.exe](https://github.com/ctliwork/finder-win/releases/latest/download/Finder-for-Windows_x64-setup.exe)（Windows 10／11，64 位元）
裝好之後有新版本會自動提示，按「更新並重新啟動」即可。

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
- `preview.rs`：解析 Word／PowerPoint／Excel 內容與 ZIP 清單，給預覽用
- `recent.rs`：讀取系統的「最近使用的檔案」
- `lib.rs`：Tauri 指令、資料夾監看（notify）、自動更新、視窗（Windows 11 Mica 效果）

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

## 發布新版本與自動更新

發布是手動的：到 GitHub 的 **Actions → Release → Run workflow**（可以填更新說明）。流程會：

1. 在 Windows 上跑 Rust 測試
2. 把版本設成 `0.3.<執行編號>`，每次自動遞增
3. 打包安裝檔，用更新私鑰簽章，發布成 GitHub Release，附上 `latest.json`
4. 另外上傳固定檔名的 `Finder-for-Windows_x64-setup.exe`，讓上面的下載連結永遠指向最新版

已安裝的 App 啟動後幾秒會讀 `releases/latest/download/latest.json`，有新版就在右下角提示；也可以從「⋯」選單手動「檢查更新…」。下載的更新會用 `tauri.conf.json` 裡的公鑰驗證簽章，對不上就不會安裝。

**一次性設定：** repo 的 Settings → Secrets and variables → Actions 要有 `TAURI_SIGNING_PRIVATE_KEY`（更新簽章私鑰，無密碼）。私鑰不在 repo 裡，請另外備份；遺失後已安裝的版本就收不到更新，只能手動重裝新版。推送程式碼不會自動打包。

## 功能

- 啟動時打開「常用」（同 Windows 檔案總管）：快速存取的釘選資料夾、磁碟機與容量、最近使用的檔案
- 左側導覽樹（同 Files／檔案總管）：首頁、釘選、本機磁碟機，資料夾可逐層展開
- 分頁：Ctrl+T 新分頁、滑鼠中鍵關閉分頁、在資料夾上按中鍵以新分頁打開；分頁上沒有關閉按鈕
- 視窗按鈕在右上角（Windows 樣式）
- 四種檢視：圖像、列表、**直欄**（預設）、圖庫
- 直欄檢視：點選逐層展開、右側預覽欄、方向鍵上下選取、左右切換欄位
- 直欄寬度：拖曳欄位右邊線調整（按住 Alt 一次調整全部欄）、按兩下自動符合最長檔名；寬度會依資料夾記住
- 空白鍵 Quick Look：圖片、影片、音訊、PDF、文字／原始碼，開關有縮放動畫
- 預覽窗格（Alt+P，同檔案總管）：選取檔案就在右側顯示預覽和詳細資訊
- 預覽格式：Word（標題與內文）、Excel（表格與工作表名稱）、PowerPoint（逐頁）、ZIP 內容清單、Markdown、CSV／TSV 表格、程式碼（含行號）；Windows 上其他格式用系統縮圖
- 導覽窗格與 Windows 檔案總管相同：常用、OneDrive、快速存取的釘選資料夾（直接讀取檔案總管的清單，在這裡釘選／取消釘選也會同步到檔案總管）、本機與磁碟機
- 資料夾圖示沿用 Windows 的設定（特殊資料夾、自訂的資料夾圖示）；可在「⋯」選單關閉「使用 Windows 資料夾圖示」改回 Finder 風格
- 路徑列、狀態列與剩餘空間
- 拖放：同磁碟搬移、跨磁碟或按 Ctrl 拷貝；可拖到其他 App、也可從檔案總管拖進來
- 新增資料夾、重新命名、製作副本、拷貝／剪下／貼上、丟到資源回收筒
- 目前資料夾即時篩選、含子資料夾的搜尋
- 框選、Shift／Ctrl 多選、打字跳選、資料夾變動自動更新
- Windows 11 Mica 毛玻璃、深色模式、8 種強調色

## 快捷鍵

| 按鍵 | 動作 |
|---|---|
| Ctrl+T | 新分頁 |
| 滑鼠中鍵（分頁上） | 關閉分頁 |
| 滑鼠中鍵（資料夾上） | 以新分頁打開 |
| Ctrl+W | 關閉分頁 |
| Ctrl+Tab / Ctrl+Shift+Tab | 下一個／上一個分頁 |
| Ctrl+1/2/3/4 | 圖像／列表／直欄／圖庫 |
| Alt+P | 預覽窗格 |
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

- 雙窗格、分頁拖曳排序
- 列表檢視展開子資料夾、超大資料夾虛擬捲動
- Windows 原生右鍵選單、與檔案總管互通的剪貼簿、Windows 11 貼齊版面（滑鼠停在最大化按鈕上）
- 壓縮／解壓縮、顏色標籤、取得資訊、復原（Ctrl+Z）
