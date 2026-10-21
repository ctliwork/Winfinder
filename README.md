# Finder for Windows（原型）

仿 macOS Finder 的 Windows 檔案管理器，Electron 原型。重點是直欄檢視（column view）。

## 執行

```bash
npm install
npm start            # 或 npx electron . --dir=C:\Users\你\Documents
```

打包 Windows 安裝檔（需在 Windows 上執行）：`npx electron-builder --win`

## 功能

- 四種檢視：圖像、列表、**直欄**（預設）、圖庫
- 直欄檢視：點選逐層展開、右側預覽欄、方向鍵左右切換欄位
- 空白鍵 Quick Look：圖片、影片、音訊、PDF、文字／原始碼
- 側邊欄（個人專屬、位置、自訂釘選）、路徑列、狀態列與剩餘空間
- 拖放搬移／拷貝（同磁碟搬移、跨磁碟或按 Ctrl 拷貝）、可拖到其他 App
- 新增資料夾、重新命名、製作副本、拷貝／剪下／貼上、丟到資源回收筒
- 目前資料夾即時篩選＋含子資料夾的搜尋
- 框選、Shift／Ctrl 多選、打字跳選、資料夾變動自動更新
- Windows 11 毛玻璃（acrylic）、深色模式、8 種強調色

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
