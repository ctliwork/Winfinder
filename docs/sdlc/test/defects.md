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
