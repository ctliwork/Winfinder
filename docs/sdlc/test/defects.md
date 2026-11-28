# 缺陷紀錄

## BUG-001：Windows 右鍵新增資料夾後未等待重新命名

- 關聯：CHG-001；狀態：MANUAL_VERIFY_REQUIRED（自動化驗證已通過，原生 popup 實際點選待確認）。
- 重現基線：29fffa875333944d26e47f8e180e335745bc2840。
- 操作：在資料夾空白處開啟 Windows 原生右鍵選單，選擇新增資料夾。
- 預期：只建立一個資料夾，選取名稱並保持輸入焦點，直到使用者確認、取消或點擊其他位置。
- 根因：`src-tauri/src/winshell.rs` 將 NewFolder 直接交給 Shell 執行，未將建立結果交給 renderer 的 `newFolder()` / `startRename()`。`renderer/app.js` 只處理原生選單的 rename 指令，其他指令只延遲重新整理。
- 修正：攔截背景選單 NewFolder 指令，回傳 renderer 執行既有新增與重新命名流程；不使用延長等待時間或反覆搶回焦點。
- 回歸：`node --test tests/new-folder-rename.mjs`，IT-001 驗證新增後依序完成選取及重新命名；IT-002/003 驗證既有重新命名及取消。修正前親自執行結果為 1 失敗、2 通過，IT-001 僅收到 delayed-refresh，沒有 mkdir 或 rename。
- RUN-001（2026-11-24，本次工作目錄）：`node --test tests/new-folder-rename.mjs` 結果 3 passed / 0 failed（exit 0）；`node --check renderer/app.js` 與 `node --check tests/glass-e2e.mjs` 均 exit 0。此範圍判定 VERIFIED。
- [RUN-002](reports/RUN-002.md)：Windows CI、36 項 Rust 測試、建置及 WebView2 測試均通過；ST-001 涵蓋 Finder 右鍵建立，以及注入原生選單回傳後的建立、全選名稱、輸入草稿、真實 watcher 更新及 Enter 確認。
- 原生 Windows popup 的實際點選不屬於 WebView2 自動化範圍，判定 MANUAL_VERIFY_REQUIRED：使用 Windows 選單「新增 → 資料夾」，確認名稱全選並保持輸入焦點。

## BUG-002：檔案監看讀取完成後重繪改名輸入框

- 嚴重度：Major；狀態：VERIFIED（RUN-003）。
- 重現：watcher 開始讀取資料夾後按 F2，再讓讀取完成。
- 根因：`flushRefresh()` 僅在 await 前檢查 G.renaming；讀取完成時可移除正在編輯的 DOM。
- 修正：讀取完成後再次檢查；保留通知並延後繪製；refresh / renderView / renderColumns 保護正在改名的畫面。
- 證據：IT-004 修正前 1 !== 0，修正後通過；ST-003 驗證真實 watcher 與 WebView2 輸入框。
- 異動：CHG-003。

## BUG-003：過期搜尋回應覆蓋目前的範圍與篩選

- 嚴重度：Major；狀態：VERIFIED（RUN-003）。
- 重現：同一關鍵字啟動搜尋後切回目前資料夾，或連續更改篩選並讓舊請求最後回傳。
- 根因：`runDeepSearch()` 僅檢查分頁與文字相同，無法區分同文字的多次請求。
- 修正：以搜尋物件、唯一請求及 scope 判定有效性；清空搜尋時使舊請求失效；背景分頁只更新自己的結果。
- 證據：IT-005、IT-006 修正前接受 stale 結果；修正後通過；IT-011、IT-012 覆蓋背景完成與清空搜尋。
- 異動：CHG-003。

## BUG-004：新增文字檔尚未完成時復原到前一個動作

- 嚴重度：Major；狀態：VERIFIED（RUN-003）。
- 重現：新增文字檔尚未完成時立即 Ctrl+Z。
- 根因：`newFile()` 未透過既有 track / working 登記，undo 不會等待建立完成。
- 修正：與新增資料夾一樣追蹤建立作業；undo 等待完成後先結束該作業剛開啟的編輯器，避免留下已刪除檔案的輸入框。
- 證據：IT-007 修正前撤銷 previous；修正後撤銷 new.txt。強化檢查另先重現 G.renaming 殘留，再加入編輯取消生命週期修正。ST-004 延遲原生建立回應，確認復原後輸入框自動關閉。
- 異動：CHG-003。

## BUG-005：祖先欄位的背景選單作用於最深目錄

- 嚴重度：Major；狀態：VERIFIED（RUN-003）。
- 重現：直欄向右開啟子資料夾，在左側上層欄位空白處按右鍵新增資料夾。
- 根因：`colDir` 只交給排序選項；新增、貼上、原生背景選單仍使用 state.cwd。
- 修正：背景選單建立前切換到點選的欄位；失敗或分頁已變更時不繼續開啟選單。
- 證據：IT-008 修正前收到 /files/child 而非 /files；ST-005 確認實體資料夾位置。
- 異動：CHG-003。

## BUG-006：刪除祖先目錄後可能回到已刪除路徑

- 嚴重度：Major；狀態：VERIFIED（RUN-003）。
- 重現條件：目前路徑 /files/parent/child，操作對象是 ancestor /files/parent，刪除成功。
- 根因：`trashSelectedNow()` 以目前路徑向上一層，未依實際成功刪除的祖先決定目的地。
- 修正：找出已刪除且包含目前路徑的最上層項目，回到該項目的父目錄；刪除失敗不跳轉。
- 證據：IT-009 修正前回到已刪除的 /files/parent；修正後回到 /files。ST-006 覆蓋直欄刪除上層與復原。
- 異動：CHG-003。

## BUG-007：中文輸入法確認候選字會提前提交重新命名

- 嚴重度：Major；狀態：MANUAL_VERIFY_REQUIRED（自動化回歸 VERIFIED，RUN-003；實際輸入法需人工確認）。
- 重現：改名時輸入中文，組字事件 isComposing=true 的 Enter 送達輸入框。
- 根因：`startRename()` 未區分輸入法組字 Enter 與一般確認 Enter。
- 修正：忽略 isComposing 或 keyCode=229 的按鍵；保留事件隔離。
- 證據：IT-010 修正前直接呼叫 rename；修正後維持輸入狀態，下一次非組字 Enter 才確認。ST-002 驗證合成組字事件、Escape 取消、一般 Enter 及復原。
- 人工確認：微軟注音／拼音組字候選確認與真正完成命名；合成事件不等同已測實際 IME。
- 異動：CHG-004。

## BUG-008：非同步更新關閉路徑輸入框或移走焦點

- 嚴重度：Major；狀態：VERIFIED（RUN-003）。
- 發現：Windows 執行 45418394415 在改名完成後 Ctrl+L 前往路徑時，輸入框消失造成 ST-006 前置操作逾時。
- 根因：renderPathbar 每次重繪都替換內容，未保護 editing；startRename 的完成回呼會在 await 後無條件將焦點移至 content。
- 修正：路徑輸入期間保留 DOM；已有其他文字欄位取得焦點時不搶回。
- 證據：IT-013 修正前替換 input 為 crumbs；IT-014 修正前 focus=1（預期 0）。ST-011 暫停真實 rename 回應、開啟路徑欄，再讓檔案操作與 watcher 完成，驗證草稿及焦點。
- 異動：CHG-005。

## BUG-009：快速複製後貼上讀取尚未寫好的系統剪貼簿

- 嚴重度：Major；狀態：VERIFIED（RUN-003）。
- 發現：Windows 45420339959 的 ST-008 在貼上時未進入 transfer；以可控 clipboardWrite Promise 獨立重現順序缺口。
- 根因：copySelected 發出非同步 clipboardWrite 後立即返回；clipboardFiles 未等待寫入完成即呼叫 clipboardRead；檔案 Ctrl+C/X/V 同時未阻止 WebView 的預設文字剪貼簿行為。
- 修正：本視窗的剪貼簿寫入以 Promise 依序執行；貼上與選單查詢先等待最新寫入，再讀取真實系統剪貼簿。檔案快捷鍵 preventDefault，文字輸入框保留正常 Ctrl+C/X/V。
- 證據：IT-015 修正前 transfer=0（預期 1）；IT-016 修正前未 preventDefault，修正後檔案快捷鍵與文字輸入的對照案例均通過。ST-012 暫停原生剪貼簿寫入，確認貼上不提前讀取，釋放後才複製正確檔案及內容。
- 異動：CHG-007。

共同驗證證據：[RUN-003](reports/RUN-003.md)。產品程式基線 0ddf1b2b1ce57cd024e9eac661cc71ff8a5a0d5f；完整 Windows 與終端機檢查均成功。後續測試基線 08dde3b2d913695c97652c6cc9fecd92ce060426 另通過全部介面／互動與四項原生視窗可見性檢查，產品程式未變更。

## BUG-010：非同步原生預覽回應覆蓋新選取，或關閉後重新出現

- 嚴重度：Major；狀態：VERIFIED（自動化範圍，RUN-005）。
- 根因：fillPreview 在等待處理程式查詢後才產生請求序號；nativeHide 在 native.el 尚未設定時直接返回，不能取消查詢中的請求。
- 修正：先產生序號並隱藏舊宿主，所有 await 後確認序號與 DOM 連線；關閉時即使沒有現存宿主也使請求失效。
- 修正前證據：Windows [46100777843](https://github.com/ctliwork/Winfinder/actions/runs/46100777843)，IT-020、022 失敗。
- 異動：CHG-009。

## BUG-011：缺少原生預覽處理程式的結果持續快取

- 嚴重度：Minor；狀態：VERIFIED（自動化範圍，RUN-005）。
- 根因：nativeAvailable 將 false Promise 永久保留到關閉應用，之後無法重新偵測。
- 修正：只快取成功可用的結果；缺少或查詢失敗時移除快取，下次重新檢查。
- 修正前證據：同次 Windows 執行，IT-021 實際 false、預期 true。
- 異動：CHG-009。

## BUG-012：直欄右鍵或 Ctrl 選取資料夾造成意外導覽

- 嚴重度：Major；狀態：VERIFIED（自動化範圍，RUN-005）。
- 根因：contextmenu 呼叫 columnClick；columnModifierClick 未禁用 selectInColumn 的 openFolder 預設值。
- 修正：這兩種選取均明確指定 openFolder=false；保留既有一般單擊的欄式導覽。
- 修正前證據：同次 Windows 執行，IT-024、025；右鍵實際呼叫開啟一次、預期零次。
- 異動：CHG-009。

## BUG-013：原生預覽失敗時靜默顯示替代內容

- 嚴重度：Minor；狀態：VERIFIED（自動化範圍，RUN-005）。
- 根因：fillPreview 對 previewShow 的非成功回應直接返回，未顯示失敗及替代標示；後端錯誤缺少失敗階段。
- 修正：保留階段及 HRESULT；失敗時顯示替代預覽標示，原始錯誤置於預覽區 title 與 data-native-error。STALE、HIDDEN 不顯示失敗。
- 修正前證據：同次 Windows 執行，IT-023 無錯誤資料、預期 DO_PREVIEW 0x80070005。
- 異動：CHG-009。

## PPT 原生處理程式的實機限制

- 狀態：MANUAL_VERIFY_REQUIRED；不宣稱已修復 Office 預覽。
- 本機唯讀探測：.pptx 的 AssocQueryStringW 成功解析 Microsoft PowerPoint previewer；於受限執行環境以 CLSCTX_LOCAL_SERVER 啟動時，CoCreateInstance 回傳 0x80070005。
- 此結果僅說明目前探測程序遭拒，不能證明一般使用者身分執行 Winfinder 的失敗根因。尚未取得使用者同一份成功／失敗檔案的比較證據；不得修改 Office 註冊、停用隔離或改權限來掩蓋問題。

本輪驗證證據：[RUN-005](reports/RUN-005.md)。使用者後續確認 PPT 為只有文字；Office 實際顯示及預覽位置仍待確認，狀態不因其他測試通過而變更。

## BUG-014：右側 PowerPoint 預覽顯示擷取文字

- CHG-010／v0.3.60 已修正列表與圖像模式預覽窗格。直欄模式使用另一個預覽元素，尚可重現純文字。
- CHG-011 共用 PowerPoint 的原生優先及縮圖備援流程，並等待滑動中的預覽欄進入可見區域。
- IT-030、031 已在 v0.3.60 重現失敗，修正後通過。完整 PowerPoint 原生版面仍需使用實際 Office 與同一份檔案驗證。
- 先前的驗證見 [RUN-006](reports/RUN-006.md)。

## BUG-015：投影片窗格持續顯示載入中

- IT-032、033 在 v0.3.61 重現：原生 Show 或 Shell 縮圖請求一直等不到回應，窗格無法結束等待。使用者環境卡在哪個呼叫仍未取得追蹤證據。
- 原生流程含 Hide、處理程式查詢、可見區域等待及 Show，共用 8 秒介面上限。逾時提升世代並關閉舊宿主，再嘗試備援。
- Shell 縮圖等待上限 3 秒。逾時、失敗或查無縮圖時顯示無法顯示版面。
- 本機 15 項預覽回歸通過。Windows CI 與 Office 實機仍待驗證。
- 異動：CHG-012。
