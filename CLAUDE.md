# Winfinder

## Git

- Work directly on `main`: commit and push to `main`. Don't create feature branches or pull requests.
- Releases: run the `release.yml` workflow on `main` (manual dispatch) when asked to release.

## Windows 操作基準

- Winfinder 提供不同的介面；Windows 檔案處理優先整合公開 Windows Shell 介面，滑鼠、鍵盤、選取及拖曳以同機檔案總管為對照。
- 介面仍負責焦點、選取與非同步狀態；不得因使用 Shell API 就宣稱已對齊所有互動。
- 原生預覽失敗及替代內容須可辨識。文字擷取不代表 PowerPoint 原生預覽成功。
- 每次驗證要記錄實際環境、檔案類型與處理程式；RTF、模擬處理程式或單元測試不得當作 Office 實機證據。
- 修改核心操作時須處理取消、部分完成、名稱衝突、權限及復原；以實際成功結果更新介面。
- 目前差距、順序與未完成項目見 docs/sdlc/changes/CHG-009.md；先讀 docs/README.md。
