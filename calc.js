/* 地板股試算：純計算函式（瀏覽器與 Node 共用，方便測試） */
(function (root) {
  'use strict';

  // 台股股票升降單位
  function stockTick(p) {
    if (p < 10) return 0.01;
    if (p < 50) return 0.05;
    if (p < 100) return 0.1;
    if (p < 500) return 0.5;
    if (p < 1000) return 1;
    return 5;
  }
  // 權證升降單位
  function warrantTick(p) {
    if (p < 5) return 0.01;
    if (p < 10) return 0.05;
    if (p < 50) return 0.1;
    if (p < 100) return 0.5;
    if (p < 500) return 1;
    return 5;
  }
  function fix(x) { return Math.round(x * 1e6) / 1e6; }
  // mode: 'round' | 'down' | 'up'
  function toTick(p, tickFn, mode) {
    if (!(p > 0)) return 0;
    const t = tickFn(p);
    const n = p / t;
    const k = mode === 'down' ? Math.floor(n + 1e-9) : mode === 'up' ? Math.ceil(n - 1e-9) : Math.round(n);
    return fix(k * t);
  }

  function buyFee(amount, fee) {
    if (!(amount > 0)) return 0;
    return Math.max(Math.floor(amount * fee.rate * fee.discount), fee.minFee);
  }
  function sellCost(amount, fee) {
    if (!(amount > 0)) return 0;
    return Math.max(Math.floor(amount * fee.rate * fee.discount), fee.minFee) + Math.floor(amount * fee.taxRate);
  }

  /**
   * 分批計畫
   * opts: { capital, refPrice, units:[1,2,6], prices:[p1,p2,p3], multiplier (股票=1，權證=1000 單位/張), fee }
   * 回傳每份數量（股或張）、每天明細、總結、損益兩平
   */
  function plan(opts) {
    const { capital, refPrice, units, prices, fee } = opts;
    const mult = opts.multiplier || 1;
    const totalUnits = units.reduce((a, b) => a + (+b || 0), 0);
    const perUnitCash = totalUnits > 0 ? capital / totalUnits : 0;
    const perUnitQty = refPrice > 0 ? Math.floor(perUnitCash / (refPrice * mult)) : 0;

    let cumQty = 0, cumAmt = 0, cumFee = 0;
    const days = units.map((u, i) => {
      const qty = (+u || 0) * perUnitQty;
      const price = +prices[i] || 0;
      const amount = Math.round(qty * mult * price * 100) / 100;
      const f = price > 0 ? buyFee(amount, fee) : 0;
      if (price > 0) { cumQty += qty; cumAmt += amount; cumFee += f; }
      const shares = cumQty * mult;
      return {
        units: +u || 0, qty, price, amount, fee: f, filled: price > 0,
        cumQty, cumAmt, cumCost: cumAmt + cumFee,
        avg: shares ? cumAmt / shares : 0,
        avgWithFee: shares ? (cumAmt + cumFee) / shares : 0,
      };
    });

    const last = days.filter(d => d.filled).pop() || null;
    const shares = cumQty * mult;
    const totalCost = cumAmt + cumFee;
    // 用評估價估算三次全部執行所需資金（未填的天數以評估價推估）
    let projected = 0;
    days.forEach(d => {
      const p = d.filled ? d.price : refPrice;
      const amt = d.qty * mult * p;
      projected += amt + buyFee(amt, fee);
    });
    const avg = shares ? cumAmt / shares : 0;
    const breakEvenPct = last && last.price ? avg / last.price - 1 : 0;
    const breakEvenPrice = shares ? totalCost / (shares * (1 - fee.rate * fee.discount - fee.taxRate)) : 0;
    const breakEvenPctFee = last && last.price ? breakEvenPrice / last.price - 1 : 0;

    return {
      totalUnits, perUnitCash, perUnitQty, days,
      summary: {
        qty: cumQty, shares, amount: cumAmt, fees: cumFee, totalCost,
        avg, avgWithFee: shares ? totalCost / shares : 0,
        cashLeft: capital - totalCost,
        usage: capital ? totalCost / capital : 0,
        projectedCost: projected,
        enough: capital - projected >= 0,
        lastPrice: last ? last.price : 0,
        breakEvenPct, breakEvenPrice, breakEvenPctFee,
      },
    };
  }

  /** 出場損益 */
  function exitPnL(shares, exitPrice, totalCost, fee, capital) {
    const amount = Math.round(shares * exitPrice * 100) / 100;
    const cost = sellCost(amount, fee);
    const pnl = amount - cost - totalCost;
    return { exitPrice, amount, sellCost: cost, pnl, ret: totalCost ? pnl / totalCost : 0, ofCapital: capital ? pnl / capital : 0 };
  }

  /** 股票：第 4 天漲跌幅情境（±10% 漲跌停，價格依升降單位調整） */
  function stockScenarios(shares, basePrice, totalCost, fee, capital) {
    const rows = [];
    for (let i = -10; i <= 10; i++) {
      const pct = i / 100;
      const raw = basePrice * (1 + pct);
      const mode = i === 10 ? 'down' : i === -10 ? 'up' : 'round';
      const px = toTick(raw, stockTick, mode);
      rows.push(Object.assign({ pct }, exitPnL(shares, px, totalCost, fee, capital)));
    }
    return rows;
  }

  /**
   * 權證：以標的漲跌幅 × 實質槓桿估算權證價格（線性近似，不含時間價值與波動率變化）
   */
  function warrantScenarios(units, warrantBase, leverage, totalCost, fee, capital) {
    const rows = [];
    for (let i = -10; i <= 10; i++) {
      const sPct = i / 100;
      const wPct = Math.max(sPct * leverage, -1);
      const px = toTick(Math.max(warrantBase * (1 + wPct), 0.01), warrantTick, 'round');
      rows.push(Object.assign({ pct: sPct, wPct }, exitPnL(units, px, totalCost, fee, capital)));
    }
    return rows;
  }

  /** 權證指標 */
  function warrantMetrics(w) {
    const out = {};
    const S = +w.underlying, K = +w.strike, r = +w.ratio, bid = +w.bid, ask = +w.ask, lev = +w.leverage;
    if (S > 0 && K > 0) {
      // 認購：價內外% = (S-K)/K；認售：(K-S)/K。正值為價內、負值為價外
      out.moneyness = w.type === 'put' ? (K - S) / K : (S - K) / K;
      out.intrinsic = r > 0 ? Math.max(w.type === 'put' ? K - S : S - K, 0) * r : null;
    }
    if (ask > 0 && bid > 0) {
      out.spreadPct = (ask - bid) / ask;
      if (lev > 0) out.spreadLevRatio = out.spreadPct * 100 / lev; // 差槓比（價差% ÷ 實質槓桿）
    }
    if (w.expiry) {
      const today = w.today ? new Date(w.today) : new Date();
      const exp = new Date(w.expiry);
      out.daysLeft = Math.ceil((exp - new Date(today.toDateString())) / 86400000);
    }
    return out;
  }

  const api = { stockTick, warrantTick, toTick, buyFee, sellCost, plan, exitPnL, stockScenarios, warrantScenarios, warrantMetrics };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis);
