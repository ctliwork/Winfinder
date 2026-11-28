# Winfinder 文件

| 文件 | 用途 | 狀態 |
| --- | --- | --- |
| [異動紀錄](sdlc/changes.md) | CHG-001～009 與影響分析 | 已記錄 |
| [缺陷紀錄](sdlc/test/defects.md) | BUG-001～009 與回歸證據 | BUG-002～006、008、009 VERIFIED；實際 IME 與原生新增選單保留人工確認 |
| [RUN-002](sdlc/test/reports/RUN-002.md) | 上一輪 Windows 建置與外框檢查 | 已記錄 |
| [RUN-003](sdlc/test/reports/RUN-003.md) | 互動、競態、預覽、終端機與原生可見性檢查 | 自動化通過；限制見報告 |

本輪為 C 類缺陷與測試修正，未建立或修改 PRD、SRS、SDD 需求與設計 ID。

CHG-008：Windows 右鍵選單調整為傳統完整選單；[RUN-004](sdlc/test/reports/RUN-004.md) 自動化驗證通過。

[CHG-009 異動計畫](sdlc/changes/CHG-009.md)：Windows Shell 優先與 Explorer 互動對齊；規劃中，尚未實作或驗證。

CHG-009 第一切片已實作，待 CI：原生預覽優先、非同步請求及直欄選取修正；Office 實機、核心檔案操作與全面互動相容仍未完成。缺陷 BUG-010～013 及限制見缺陷紀錄。
