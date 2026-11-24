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

- 嚴重度：Major；狀態：修正後本機通過，Windows 驗證待執行。
- 重現：watcher 開始讀取資料夾後按 F2，再讓讀取完成。
- 根因：`flushRefresh()` 僅在 await 前檢查 G.renaming；讀取完成時可移除正在編輯的 DOM。
- 修正：讀取完成後再次檢查；保留通知並延後繪製；refresh / renderView / renderColumns 保護正在改名的畫面。
- 證據：IT-004 修正前 1 !== 0，修正後通過；ST-003 驗證真實 watcher 與 WebView2 輸入框。
- 異動：CHG-003。

## BUG-003：過期搜尋回應覆蓋目前的範圍與篩選

- 嚴重度：Major；狀態：修正後本機通過，Windows 驗證待執行。
- 重現：同一關鍵字啟動搜尋後切回目前資料夾，或連續更改篩選並讓舊請求最後回傳。
- 根因：`runDeepSearch()` 僅檢查分頁與文字相同，無法區分同文字的多次請求。
- 修正：以搜尋物件、唯一請求及 scope 判定有效性；清空搜尋時使舊請求失效；背景分頁只更新自己的結果。
- 證據：IT-005、IT-006 修正前接受 stale 結果；修正後通過；IT-011、IT-012 覆蓋背景完成與清空搜尋。
- 異動：CHG-003。

## BUG-004：新增文字檔尚未完成時復原到前一個動作

- 嚴重度：Major；狀態：修正後本機通過，Windows 驗證待執行。
- 重現：新增文字檔尚未完成時立即 Ctrl+Z。
- 根因：`newFile()` 未透過既有 track / working 登記，undo 不會等待建立完成。
- 修正：與新增資料夾一樣追蹤建立作業。
- 證據：IT-007 修正前撤銷 previous；修正後撤銷 new.txt。ST-004 延遲原生建立回應驗證順序。
- 異動：CHG-003。

## BUG-005：祖先欄位的背景選單作用於最深目錄

- 嚴重度：Major；狀態：修正後本機通過，Windows 驗證待執行。
- 重現：直欄向右開啟子資料夾，在左側上層欄位空白處按右鍵新增資料夾。
- 根因：`colDir` 只交給排序選項；新增、貼上、原生背景選單仍使用 state.cwd。
- 修正：背景選單建立前切換到點選的欄位；失敗或分頁已變更時不繼續開啟選單。
- 證據：IT-008 修正前收到 /files/child 而非 /files；ST-005 確認實體資料夾位置。
- 異動：CHG-003。

## BUG-006：刪除祖先目錄後可能回到已刪除路徑

- 嚴重度：Major；狀態：修正後本機通過，Windows 驗證待執行。
- 重現條件：目前路徑 /files/parent/child，操作對象是 ancestor /files/parent，刪除成功。
- 根因：`trashSelectedNow()` 以目前路徑向上一層，未依實際成功刪除的祖先決定目的地。
- 修正：找出已刪除且包含目前路徑的最上層項目，回到該項目的父目錄；刪除失敗不跳轉。
- 證據：IT-009 修正前回到已刪除的 /files/parent；修正後回到 /files。ST-006 覆蓋直欄刪除上層與復原。
- 異動：CHG-003。

## BUG-007：中文輸入法確認候選字會提前提交重新命名

- 嚴重度：Major；狀態：修正後本機通過；實際輸入法需人工確認。
- 重現：改名時輸入中文，組字事件 isComposing=true 的 Enter 送達輸入框。
- 根因：`startRename()` 未區分輸入法組字 Enter 與一般確認 Enter。
- 修正：忽略 isComposing 或 keyCode=229 的按鍵；保留事件隔離。
- 證據：IT-010 修正前直接呼叫 rename；修正後維持輸入狀態，下一次非組字 Enter 才確認。ST-002 驗證合成組字事件、Escape 取消、一般 Enter 及復原。
- 人工確認：微軟注音／拼音組字候選確認與真正完成命名；合成事件不等同已測實際 IME。
- 異動：CHG-004。
