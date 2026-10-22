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
- 分頁：Ctrl+T 新分頁、滑鼠中鍵關閉分頁、在資料夾上按中鍵以新分頁打開；拖曳分頁可調整順序；把檔案拖到分頁上會放進那個分頁的資料夾，拖著停一下會切換過去
- 視窗按鈕在右上角（Windows 樣式）
- 四種檢視：圖像、列表、**直欄**（預設）、圖庫；每個資料夾記住自己的檢視方式與排序（可在設定關閉）
- 列表檢視：拖曳標題邊線調整欄寬；在標題上按右鍵可加上「建立日期」「副檔名」欄，或依類型、修改日期、大小分組（圖像檢視也能分組）
- 直欄檢視：點選逐層展開、右側預覽欄、方向鍵上下選取、左右切換欄位
- 直欄寬度：拖曳欄位右邊線調整（按住 Alt 一次調整全部欄）、按兩下自動符合最長檔名；寬度會依資料夾記住
- 空白鍵 Quick Look：圖片、影片、音訊、PDF、文字／原始碼，開關有縮放動畫
- 預覽窗格（Alt+P，同檔案總管）：選取檔案就在右側顯示預覽和詳細資訊
- 預覽格式：Word（標題與內文）、Excel（表格與工作表名稱）、PowerPoint（逐頁）、ZIP 內容清單、Markdown、CSV／TSV 表格、程式碼（含行號）；Windows 上其他格式用系統縮圖
- 導覽窗格與 Windows 檔案總管相同：常用、OneDrive、快速存取的釘選資料夾（直接讀取檔案總管的清單，在這裡釘選／取消釘選也會同步到檔案總管）、本機與磁碟機
- 圖示與 Windows 檔案總管相同：應用程式與捷徑用自己的圖示、檔案用系統的類型圖示、資料夾與磁碟機用 Windows 的圖示（含自訂圖示）；大圖示檢視中的相片、影片、文件仍顯示縮圖。可在設定中關閉改回 Finder 風格
- **設定**（Ctrl+, 或「⋯」→ 設定）：啟動位置（常用／上次的位置／指定資料夾）、新分頁位置、預設檢視、刪除前確認、自動檢查更新、主題（跟隨系統／淺色／深色）、強調色、Windows 圖示、列表密度、側邊欄、預覽窗格、隱藏項目、副檔名、資料夾排前面、大小單位（1000／1024）、還原欄寬、重設所有設定、快捷鍵一覽
- 路徑列可直接輸入路徑（點路徑列空白處或 Ctrl+L／Alt+D／F4）；輸入檔案路徑會打開所在資料夾並選取它
- 狀態列與剩餘空間
- 拖放：同磁碟搬移、跨磁碟或按 Ctrl 拷貝；可拖到其他 App、也可從檔案總管拖進來
- 新增資料夾、新增文字文件、重新命名、製作副本、拷貝／剪下／貼上、丟到資源回收筒
- 右鍵選單與 Windows 相同：直接顯示檔案總管的選單（7-Zip、VS Code、Git 等加入的項目都在），上方加上本程式的功能（在新分頁中打開、快速查看、拷貝路徑、計算大小；空白處有檢視、排序方式、分組依據）；設定中可改回 Finder 風格選單。「內容」視窗（Alt+Enter）
- 剪貼簿與檔案總管互通：這裡拷貝／剪下的檔案可在檔案總管或桌面貼上，反之亦然
- 復原（Ctrl+Z）：重新命名、批次重新命名、搬移、拷貝、新增、壓縮／解壓縮、丟到資源回收筒（從資源回收筒還原）
- 貼上遇到同名項目時詢問：取代（資料夾會合併）、略過、保留兩者；較久的拷貝顯示進度並可取消
- 批次重新命名（多選後按 F2）：尋找與取代（可用正規表示式）或名稱加編號，套用前先預覽並檢查重複與無效名稱
- 壓縮成 ZIP、解壓縮 ZIP 到同名資料夾
- 計算資料夾大小（右鍵選單或預覽窗格），結果會顯示在列表的大小欄
- 在終端機中開啟（Windows Terminal，沒有安裝時用 PowerShell）
- 目前資料夾即時篩選、含子資料夾的搜尋；可再依類型、大小、修改日期篩選；有安裝 Everything（含 es.exe）時可搜尋整台電腦
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
| Ctrl+Alt+N | 新增文字文件 |
| Ctrl+L、Alt+D、F4 | 輸入路徑 |
| F2（多選） | 批次重新命名 |
| Ctrl+, | 設定 |
| Ctrl+Z | 復原 |
| Alt+Enter | 內容 |
| Shift+F10、Shift+右鍵 | Windows 原生右鍵選單 |
| Ctrl+Shift+. | 顯示隱藏項目 |
| Ctrl+F | 搜尋 |
| Ctrl+= / Ctrl+- | 圖像大小 |

## 待做（對齊 Finder／Files）

- 雙窗格
- 列表檢視展開子資料夾、超大資料夾虛擬捲動
- Windows 11 貼齊版面（滑鼠停在最大化按鈕上）
- 顏色標籤
