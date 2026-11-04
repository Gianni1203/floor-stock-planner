# 地板股分批試算

地板股 1 : 2 : 6 分批進場、第 4 天出場的試算網頁。輸入股票代號或名稱，自動帶入最新收盤價；也支援用權證操作。

## 功能

| 分頁 | 內容 |
|---|---|
| 股票試算 | 每等份金額／股數、三天尾盤進場明細、累計均價、資金是否足夠、損益兩平（含手續費與證交稅）、第 4 天 ±10% 出場情境（價格依升降單位調整） |
| 權證試算 | 以「張」計算 1:2:6 分批、價內外%、剩餘天數、買賣價差比、差槓比、以實質槓桿估算的第 4 天出場情境 |
| 進場前檢查 | 不利新聞、股本 ≥ 20 億（自動帶入）、勝率天數、資金是否足夠（自動）、尾盤進場、分批規劃；權證另檢查天數、價外程度、價差、差槓比 |
| 交易紀錄 | 逐筆記錄、從試算帶入、匯出 CSV（存在瀏覽器 localStorage） |
| 小哥訊號統計 | 10 類小哥訊號在持有 1／2／3／5／10／20 天後的勝率與平均報酬、對 0050 的超額報酬、隔天跳空、5 天內最大有利／不利幅度 |
| 訊號登錄 | 貼上當天各類標的 → 產生 `signals/日期.csv` → 一鍵開 GitHub 新增檔案頁 |

## 收盤價資料

- GitHub Actions 每個交易日台北時間 16:20、18:20 執行 `scripts/fetch_prices.py`，從以下免費官方 API 抓資料寫入 `data/`：
  - 證交所 OpenAPI `exchangeReport/STOCK_DAY_ALL`（上市）
  - 櫃買中心 OpenAPI `tpex_mainboard_daily_close_quotes`（上櫃，含上櫃權證）
  - 證交所／櫃買 公司基本資料（實收資本額 → 股本）
  - 證交所 `MI_INDEX` type `0999`／`0999P`（上市認購／認售權證）
- 網頁讀同網域的 JSON，不會遇到 CORS 問題；查不到的代號會改呼叫 [FinMind](https://finmindtrade.com/) 公開 API（免 token，每小時 300 次）。
- repo 內附的 `data/*.json` 是示範資料，第一次 Actions 跑完就會被實際資料取代。

## 小哥訊號資料庫

- 每天一個檔：`signals/YYYY-MM-DD.csv`，欄位 `code,cat,note`；日期是小哥文章的資料日（訊號日）。
- 類別與多空方向定義在 `signals/categories.json`（投信多、投信空、分點買、分點賣、上軌、下軌、主力權證、波段認購、波段認售、地板股）。
- `scripts/fetch_prices.py` 每天另存全市場開高低收到 `data/history/`；`scripts/compute_signals.py` 據此算出每筆訊號的後續表現，輸出 `data/signals.json`。
- 進場價：地板股用訊號日隔天的收盤價（尾盤進場），其他類別用隔天開盤價；做空類別股價下跌算賺。
- 歷史快照開始之前的訊號，會自動向 FinMind 補抓價格（每次最多 250 檔，存在 `data/fm_cache.json`）。

## 部署到 GitHub Pages

1. 在 GitHub 建立新 repo（例如 `floor-stock-planner`），把這個資料夾推上 `main`。
2. repo → **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. repo → **Actions** → 「更新收盤價並部署」→ **Run workflow** 手動跑第一次。
4. 完成後網址是 `https://<你的帳號>.github.io/floor-stock-planner/`。

之後每個交易日收盤後會自動更新收盤價並重新部署。

## 本機開啟

```bash
python3 -m http.server 8000
# 開 http://localhost:8000
```

（直接雙擊 index.html 會因為瀏覽器限制讀不到 data/*.json。）

## 計算說明

- 每等份金額 = 總資金 ÷ 總等份；每等份股數 = 每等份金額 ÷ 評估股價（無條件捨去）。
- 手續費 = max(⌊金額 × 0.1425% × 折數⌋, 最低手續費)；證交稅：股票 0.3%、權證 0.1%（賣出時收）。
- 損益兩平賣價 = 總成本含買進手續費 ÷ [持股 × (1 − 手續費率 × 折數 − 證交稅率)]。
- 權證情境以「權證漲跌 ≈ 標的漲跌 × 實質槓桿」線性估算，未含時間價值遞減與隱含波動率變化，實際價格會有落差。

本工具僅供試算，不構成投資建議。
