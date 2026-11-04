"""每日抓取台股收盤價，輸出 data/prices.json 與 data/warrants.json。

資料來源（皆為官方免費公開資料，無需金鑰）：
  - 證交所 OpenAPI  STOCK_DAY_ALL        上市個股日成交資訊
  - 櫃買中心 OpenAPI 上櫃股票收盤行情
  - 證交所 / 櫃買 OpenAPI 公司基本資料    實收資本額（用來判斷股本 ≥ 20 億）
  - 證交所 MI_INDEX type=0999 / 0999P    上市認購／認售權證收盤

只用 Python 標準函式庫；任何一個來源失敗都不會中斷，其他來源照常寫入。
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

TPE = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

TWSE_DAY_ALL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_CLOSE = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
TWSE_COMPANY = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
TPEX_COMPANY = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"
TWSE_MI_INDEX = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d}&type={t}&response=json"

# 認購 6 碼數字（上市 03~08 開頭、上櫃 7 開頭）；認售 5 碼數字＋P
WARRANT_RE = re.compile(r"^(0[3-8]\d{4}|7\d{5}|0[3-8]\d{3}P|7\d{4}P)$")
UA = {"User-Agent": "Mozilla/5.0 (floor-stock-planner; GitHub Actions)", "Accept": "application/json"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get_json(url: str, tries: int = 3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode("utf-8-sig")
            return json.loads(raw)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def num(v):
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    s = re.sub(r"<[^>]+>", "", s)  # MI_INDEX 有時夾帶 HTML
    if s in ("", "--", "-", "---", "X", "除權息"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def pick(rec: dict, *names):
    """依候選欄位名稱（或包含的關鍵字）取值，容忍 API 欄位名稱小改。"""
    for n in names:
        if n in rec:
            return rec[n]
    for n in names:
        for k, v in rec.items():
            if n.lower() in k.lower():
                return v
    return None


def roc_to_iso(s):
    """'1151102' / '115/11/02' → '2026-11-02'"""
    if not s:
        return None
    d = re.sub(r"\D", "", str(s))
    if len(d) == 7:
        return f"{int(d[:3]) + 1911}-{d[3:5]}-{d[5:]}"
    if len(d) == 8:
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"
    return None


def is_warrant(code: str) -> bool:
    return bool(WARRANT_RE.match(code))


def main():
    DATA.mkdir(exist_ok=True)
    stocks: dict[str, list] = {}
    warrants: dict[str, list] = {}
    dates: list[str] = []
    stock_dates: list[str] = []
    ohlc: dict[str, list] = {}  # 個股當日 [開, 高, 低, 收]，存成歷史供訊號追蹤
    sources = {}

    # 1) 上市
    try:
        rows = get_json(TWSE_DAY_ALL)
        n = 0
        for r in rows:
            code = str(pick(r, "Code", "證券代號") or "").strip()
            name = str(pick(r, "Name", "證券名稱") or "").strip()
            close = num(pick(r, "ClosingPrice", "收盤價"))
            if not code:
                continue
            d = roc_to_iso(pick(r, "Date", "日期"))
            if d:
                dates.append(d)
            if is_warrant(code):
                warrants[code] = [name, close]
            else:
                stocks[code] = [name, close, None, "上市"]
                if d:
                    stock_dates.append(d)
                if close:
                    ohlc[code] = [num(r.get("OpeningPrice")), num(r.get("HighestPrice")), num(r.get("LowestPrice")), close]
            n += 1
        sources["twse"] = n
        log("TWSE ok", n)
    except Exception as e:  # noqa: BLE001
        sources["twse"] = f"error: {e}"
        log("TWSE fail", e)

    # 2) 上櫃（含上櫃權證）
    try:
        rows = get_json(TPEX_CLOSE)
        n = 0
        for r in rows:
            code = str(pick(r, "SecuritiesCompanyCode", "代號") or "").strip()
            name = str(pick(r, "CompanyName", "名稱") or "").strip()
            close = num(pick(r, "Close", "收盤"))
            if not code:
                continue
            d = roc_to_iso(pick(r, "Date", "資料日期"))
            if d:
                dates.append(d)
            if is_warrant(code):
                warrants[code] = [name, close]
            else:
                stocks.setdefault(code, [name, close, None, "上櫃"])
                if d:
                    stock_dates.append(d)
                if close and code not in ohlc:
                    ohlc[code] = [num(r.get("Open")), num(r.get("High")), num(r.get("Low")), close]
            n += 1
        sources["tpex"] = n
        log("TPEx ok", n)
    except Exception as e:  # noqa: BLE001
        sources["tpex"] = f"error: {e}"
        log("TPEx fail", e)

    # 3) 實收資本額（元 → 億）
    for key, url in (("twse_company", TWSE_COMPANY), ("tpex_company", TPEX_COMPANY)):
        try:
            rows = get_json(url)
            n = 0
            for r in rows:
                code = str(pick(r, "公司代號", "SecuritiesCompanyCode") or "").strip()
                cap = num(pick(r, "實收資本額", "Paidin", "Capital"))
                if code in stocks and cap:
                    stocks[code][2] = round(cap / 1e8, 2)
                    n += 1
            sources[key] = n
            log(key, "ok", n)
        except Exception as e:  # noqa: BLE001
            sources[key] = f"error: {e}"
            log(key, "fail", e)

    # 4) 上市權證（MI_INDEX），找最近一個有資料的交易日
    today = datetime.now(TPE).date()
    for t in ("0999", "0999P"):
        got = 0
        for back in range(7):
            d = today - timedelta(days=back)
            if d.weekday() >= 5:
                continue
            try:
                js = get_json(TWSE_MI_INDEX.format(d=d.strftime("%Y%m%d"), t=t), tries=2)
            except Exception as e:  # noqa: BLE001
                log("MI_INDEX", t, d, e)
                time.sleep(3)
                continue
            if js.get("stat") not in (None, "OK"):
                time.sleep(3)
                continue
            for fields, data in iter_tables(js):
                try:
                    ic, iname, iclose = fields.index("證券代號"), fields.index("證券名稱"), fields.index("收盤價")
                except ValueError:
                    continue
                for row in data:
                    code = re.sub(r"<[^>]+>", "", str(row[ic])).strip()
                    if is_warrant(code):
                        warrants[code] = [str(row[iname]).strip(), num(row[iclose])]
                        got += 1
            if got:
                dates.append(d.isoformat())
                break
            time.sleep(3)
        sources[f"twse_{t}"] = got
        log("MI_INDEX", t, got)

    if not stocks:
        log("沒有抓到任何股票資料，保留舊檔不覆寫")
        sys.exit(1)

    data_date = max(dates) if dates else None
    meta = {"updated": datetime.now(TPE).isoformat(timespec="minutes"), "date": data_date, "sources": sources}
    (DATA / "prices.json").write_text(
        json.dumps({**meta, "fields": ["name", "close", "capital_億", "market"], "s": stocks}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    if warrants:
        (DATA / "warrants.json").write_text(
            json.dumps({**meta, "fields": ["name", "close"], "w": warrants}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    # 5) 收盤價歷史快照（訊號追蹤用）：data/history/YYYY-MM-DD.json
    if ohlc and stock_dates:
        hist_date = max(stock_dates)
        hdir = DATA / "history"
        hdir.mkdir(exist_ok=True)
        (hdir / f"{hist_date}.json").write_text(
            json.dumps({"date": hist_date, "fields": ["open", "high", "low", "close"], "s": ohlc}, separators=(",", ":")),
            encoding="utf-8",
        )
        log("history", hist_date, len(ohlc))
    log("done", len(stocks), "stocks", len(warrants), "warrants", data_date)


def iter_tables(js: dict):
    """相容 MI_INDEX 新舊格式：tables[{fields,data}] 或 fieldsN/dataN。"""
    for tb in js.get("tables") or []:
        if isinstance(tb, dict) and tb.get("fields") and tb.get("data"):
            yield tb["fields"], tb["data"]
    for k, v in js.items():
        m = re.match(r"^fields(\d+)$", k)
        if m and js.get(f"data{m.group(1)}"):
            yield v, js[f"data{m.group(1)}"]


if __name__ == "__main__":
    main()
