"""計算小哥訊號的後續表現，輸出 data/signals.json 給網頁統計用。

輸入
  signals/categories.json      類別、方向（1 做多／-1 做空）、進場方式（open 隔天開盤／close 隔天收盤）
  signals/YYYY-MM-DD.csv       當天訊號，欄位 code,cat[,note]；日期 = 小哥文章的資料日（訊號日）
  data/history/YYYY-MM-DD.json 每日收盤後由 fetch_prices.py 存的全市場 [開,高,低,收]
  data/fm_cache.json           歷史快照開始前的訊號，向 FinMind 補抓的價格快取

計算（全部依方向調整：做空時股價下跌算賺）
  進場價  = 訊號日後第 1 個交易日（D1）的開盤價或收盤價
  持有 n 天報酬 = 第 n 天收盤 / 進場價 − 1
                 開盤進場：第 n 天 = D1 起算的第 n 個交易日（n=1 為當天收盤出場）
                 收盤進場：第 n 天 = D1 之後的第 n 個交易日
  超額報酬 = 同期間報酬 − 0050 報酬（同方向調整）
  MFE5 / MAE5 = 進場後 5 天內，以最高／最低價計算的最大有利／不利幅度
  隔天跳空 = D1 開盤 / 訊號日收盤 − 1；隔天最高 = D1 最高 / 訊號日收盤 − 1
"""
from __future__ import annotations

import csv
import json
import re
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIG = ROOT / "signals"
DATA = ROOT / "data"
HIST = DATA / "history"
CACHE = DATA / "fm_cache.json"
OUT = DATA / "signals.json"
TPE = timezone(timedelta(hours=8))
HORIZONS = [1, 2, 3, 5, 10, 20]
BENCH = "0050"
FM_URL = "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id={code}&start_date={start}&end_date={end}"
FM_MAX_CALLS = 250  # FinMind 未登入每小時 300 次
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.csv$")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def load_categories():
    cats = json.loads((SIG / "categories.json").read_text(encoding="utf-8"))
    return {c["key"]: c for c in cats}


def load_signals(cats):
    out, bad = [], []
    for f in sorted(SIG.glob("*.csv")):
        m = DATE_RE.match(f.name)
        if not m:
            continue
        d = m.group(1)
        seen = set()
        with f.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                code = (row.get("code") or "").strip().upper()
                cat = (row.get("cat") or "").strip()
                if not code or not cat:
                    continue
                if cat not in cats:
                    bad.append(f"{f.name}: 未知類別 {cat}")
                    continue
                if (code, cat) in seen:
                    continue
                seen.add((code, cat))
                out.append({"date": d, "code": code, "cat": cat, "note": (row.get("note") or "").strip()})
    for b in bad:
        log("⚠", b)
    return out


def load_history():
    """{date: {code: [o,h,l,c]}}"""
    hist = {}
    if HIST.exists():
        for f in sorted(HIST.glob("*.json")):
            try:
                j = json.loads(f.read_text(encoding="utf-8"))
                hist[j.get("date") or f.stem] = j["s"]
            except Exception as e:  # noqa: BLE001
                log("history 讀取失敗", f.name, e)
    return hist


def load_cache():
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return {}


def fm_fetch(code, start, end):
    url = FM_URL.format(code=code, start=start, end=end)
    req = urllib.request.Request(url, headers={"User-Agent": "floor-stock-planner"})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.loads(r.read().decode("utf-8"))
    rows = {}
    for d in j.get("data") or []:
        if d.get("close"):
            rows[d["date"]] = [d.get("open"), d.get("max"), d.get("min"), d.get("close")]
    return rows


def ensure_backfill(signals, hist, cache):
    """歷史快照開始之前的訊號，向 FinMind 補抓價格（含 0050）。"""
    hist_start = min(hist) if hist else None
    today = datetime.now(TPE).date()
    need = {}
    for s in signals:
        if hist_start and s["date"] >= hist_start:
            continue
        sd = date.fromisoformat(s["date"])
        end = min(today, sd + timedelta(days=45))
        if hist_start:
            end = min(end, date.fromisoformat(hist_start))
        for code in (s["code"], BENCH):
            a, b = need.get(code, (sd, end))
            need[code] = (min(a, sd), max(b, end))
    calls = 0
    for code, (a, b) in sorted(need.items()):
        have = cache.get(code, {})
        span = cache.get("_span", {}).get(code)
        if span and span[0] <= a.isoformat() and span[1] >= b.isoformat():
            continue
        if calls >= FM_MAX_CALLS:
            log("FinMind 已達本次上限，其餘下次再補")
            break
        try:
            rows = fm_fetch(code, (a - timedelta(days=7)).isoformat(), b.isoformat())
            have.update(rows)
            cache[code] = have
            cache.setdefault("_span", {})[code] = [a.isoformat(), b.isoformat()]
            calls += 1
            time.sleep(0.5)
        except Exception as e:  # noqa: BLE001
            log("FinMind 失敗", code, e)
            calls += 1
    return calls


def series_for(code, hist, cache):
    """回傳依日期排序的 [(date, [o,h,l,c])]。"""
    rows = dict((cache.get(code) or {}))
    for d, day in hist.items():
        v = day.get(code)
        if v and v[3]:
            rows[d] = v
    return sorted(rows.items())


def pct(a, b):
    if not a or not b:
        return None
    return round(a / b - 1, 5)


def evaluate(sig, cat, ser, bench):
    d0 = sig["date"]
    dates = [d for d, _ in ser]
    # 訊號日當天收盤（找不到就用訊號日前最近一天）
    prev = [x for x in ser if x[0] <= d0]
    after = [x for x in ser if x[0] > d0]
    res = {"date": d0, "code": sig["code"], "cat": sig["cat"], "dir": cat["dir"], "entryType": cat["entry"]}
    if sig.get("note"):
        res["note"] = sig["note"]
    c0 = prev[-1][1][3] if prev else None
    res["c0"] = c0
    if not after:
        res["status"] = "pending"
        return res
    d1, v1 = after[0]
    entry = v1[0] if cat["entry"] == "open" else v1[3]
    if not entry:  # 沒有開盤價（例如資料缺）就用收盤
        entry = v1[3]
    res.update({"d1": d1, "entry": entry, "gap": pct(v1[0], c0), "d1High": pct(v1[1], c0), "d1Low": pct(v1[2], c0)})
    k = cat["dir"]
    off = 0 if cat["entry"] == "open" else 1  # 收盤進場：持有第 n 天 = after[n]
    bser = dict(bench)
    b_entry_day = after[0][0]
    b_entry = None
    if b_entry_day in bser:
        bv = bser[b_entry_day]
        b_entry = bv[0] if cat["entry"] == "open" and bv[0] else bv[3]
    r, ex = {}, {}
    for h in HORIZONS:
        idx = h - 1 + off
        if idx < len(after):
            dh, vh = after[idx]
            raw = pct(vh[3], entry)
            if raw is not None:
                r[h] = round(k * raw, 5)
                if b_entry and dh in bser:
                    braw = pct(bser[dh][3], b_entry)
                    if braw is not None:
                        ex[h] = round(k * (raw - braw), 5)
    res["r"] = r
    res["ex"] = ex
    win = after[off : off + 5]  # 開盤進場含 D1 當天；收盤進場從 D2 起算
    highs = [v[1] for _, v in win if v[1]]
    lows = [v[2] for _, v in win if v[2]]
    if highs and lows:
        up, dn = max(highs) / entry - 1, min(lows) / entry - 1
        res["mfe5"] = round(up if k > 0 else -dn, 5)
        res["mae5"] = round(dn if k > 0 else -up, 5)
    res["days"] = len(after) - off
    res["status"] = "done" if 20 in r else "tracking"
    return res


def main():
    cats = load_categories()
    signals = load_signals(cats)
    hist = load_history()
    cache = load_cache()
    calls = ensure_backfill(signals, hist, cache) if signals else 0
    if calls:
        CACHE.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
    bench = series_for(BENCH, hist, cache)
    names = {}
    pj = DATA / "prices.json"
    if pj.exists():
        try:
            names = {c: v[0] for c, v in json.loads(pj.read_text(encoding="utf-8"))["s"].items()}
        except Exception:  # noqa: BLE001
            pass
    out = []
    ser_cache = {}
    for s in signals:
        if s["code"] not in ser_cache:
            ser_cache[s["code"]] = series_for(s["code"], hist, cache)
        row = evaluate(s, cats[s["cat"]], ser_cache[s["code"]], bench)
        row["name"] = names.get(s["code"], "")
        out.append(row)
    out.sort(key=lambda x: (x["date"], x["cat"], x["code"]), reverse=True)
    meta = {
        "updated": datetime.now(TPE).isoformat(timespec="minutes"),
        "horizons": HORIZONS,
        "bench": BENCH,
        "histFrom": min(hist) if hist else None,
        "histTo": max(hist) if hist else None,
        "categories": list(cats.values()),
        "count": len(out),
        "signals": out,
    }
    OUT.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log("signals", len(out), "FinMind calls", calls)


if __name__ == "__main__":
    main()
