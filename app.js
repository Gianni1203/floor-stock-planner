/* 地板股分批試算 — 介面 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const C = window.Calc;
  const STORE_KEY = 'floor-stock-planner-v1';

  // ---------- 格式 ----------
  const nf0 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (x) => (x ? nf0.format(Math.round(x)) : '-');
  const signed = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + nf0.format(Math.abs(Math.round(x)));
  const p2 = (x) => (x ? nf2.format(x) : '-');
  const pct = (x, d = 2) => (x === null || x === undefined || isNaN(x) ? '-' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const kpi = (k, v, cls = '') => `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const todayISO = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

  // ---------- 狀態 ----------
  const DEFAULTS = {
    tab: 'stock',
    stock: {
      query: '3023', code: '3023', name: '信邦', close: null, cap: null, market: '', qdate: '',
      capital: 200000, ref: 278, rate: 0.001425, disc: 1, min: 1, tax: 0.003,
      units: [1, 2, 6], dates: ['2026-10-28', '2026-10-29', '2026-10-30'], prices: [278, 265, 248], exit: '',
    },
    warrant: {
      uquery: '3023', ucode: '3023', uname: '信邦', query: '', code: '', name: '', close: null,
      type: 'call', under: 248, strike: 270, ratio: 0.05, expiry: '', lev: 6, bid: 1.09, ask: 1.1,
      capital: 200000, ref: 1.5, rate: 0.001425, disc: 1, min: 20, tax: 0.001,
      units: [1, 2, 6], dates: ['', '', ''], prices: [1.5, 1.3, 1.1], exit: '', example: true,
    },
    check: { news: '', winrate: '', tail: '', split: '', capManual: '', wDays: 60, wOtm: 15, wSpread: 2, wSLR: 0.3 },
    log: [],
  };
  let S = load();
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        return {
          tab: o.tab || 'stock',
          stock: Object.assign({}, DEFAULTS.stock, o.stock),
          warrant: Object.assign({}, DEFAULTS.warrant, o.warrant),
          check: Object.assign({}, DEFAULTS.check, o.check),
          log: Array.isArray(o.log) ? o.log : [],
        };
      }
    } catch (e) { /* 無痕模式等情況：用預設值 */ }
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  let saveT;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }, 250);
  }

  // ---------- 收盤價資料 ----------
  const DB = { stocks: null, warrants: null, meta: null, wPromise: null };
  async function loadStocks() {
    const st = $('dataStatus');
    try {
      const r = await fetch('data/prices.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      DB.stocks = j.s || {};
      DB.meta = j;
      const n = Object.keys(DB.stocks).length;
      const sample = j.sample ? '（示範資料，部署後由 GitHub Actions 自動更新）' : '';
      st.textContent = `收盤價資料日：${j.date || '未知'}・共 ${nf0.format(n)} 檔・更新於 ${String(j.updated || '').replace('T', ' ').slice(0, 16)}${sample}`;
      st.className = 'data-status ' + (j.sample ? 'warn' : 'ok');
      $('stockList').innerHTML = Object.entries(DB.stocks).map(([c, v]) => `<option value="${esc(c)} ${esc(v[0])}">`).join('');
    } catch (e) {
      DB.stocks = {};
      st.textContent = '本機收盤價資料讀取失敗，查詢時會改用 FinMind 公開 API。';
      st.className = 'data-status warn';
    }
  }
  function loadWarrants() {
    if (DB.wPromise) return DB.wPromise;
    DB.wPromise = fetch('data/warrants.json?t=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { w: {} }))
      .then((j) => {
        DB.warrants = j.w || {};
        DB.wMeta = j;
        const list = Object.entries(DB.warrants);
        $('warrantList').innerHTML = list.slice(0, 40000).map(([c, v]) => `<option value="${esc(c)} ${esc(v[0])}">`).join('');
        return DB.warrants;
      })
      .catch(() => (DB.warrants = {}));
    return DB.wPromise;
  }

  function findIn(map, q) {
    if (!map) return null;
    q = String(q || '').trim();
    if (!q) return null;
    const first = q.split(/\s+/)[0].toUpperCase();
    if (map[first]) return [first, map[first]];
    let hit = Object.entries(map).find(([, v]) => v[0] === q);
    if (!hit) hit = Object.entries(map).find(([, v]) => v[0] && v[0].includes(q));
    return hit || null;
  }

  async function finmindClose(code) {
    const start = new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 10);
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(code)}&start_date=${start}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('FinMind ' + r.status);
    const j = await r.json();
    const rows = (j.data || []).filter((d) => d.close > 0);
    if (!rows.length) throw new Error('查無資料');
    const last = rows[rows.length - 1];
    return { close: +last.close, date: last.date };
  }

  /** 查股票：本機 JSON → FinMind */
  async function lookupStock(q) {
    const hit = findIn(DB.stocks, q);
    if (hit) {
      const [code, v] = hit;
      if (v[1] > 0) return { code, name: v[0], close: v[1], cap: v[2], market: v[3] || '', date: DB.meta && DB.meta.date, src: '證交所／櫃買' };
      const fm = await finmindClose(code).catch(() => null);
      if (fm) return { code, name: v[0], close: fm.close, cap: v[2], market: v[3] || '', date: fm.date, src: 'FinMind（今日無成交，取最近收盤）' };
      throw new Error(`${code} ${v[0]} 今日無收盤價`);
    }
    const code = String(q || '').trim().split(/\s+/)[0];
    if (!/^[0-9A-Z]{4,6}[A-Z]?$/i.test(code)) throw new Error('找不到這個名稱，請改輸入股票代號');
    const fm = await finmindClose(code.toUpperCase());
    return { code: code.toUpperCase(), name: '', close: fm.close, cap: null, market: '', date: fm.date, src: 'FinMind' };
  }
  async function lookupWarrant(q) {
    await loadWarrants();
    const hit = findIn(DB.warrants, q);
    if (hit) {
      const [code, v] = hit;
      if (v[1] > 0) return { code, name: v[0], close: v[1], date: DB.wMeta && DB.wMeta.date, src: '證交所／櫃買' };
      throw new Error(`${code} ${v[0]} 今日無成交，請手動輸入價格`);
    }
    const code = String(q || '').trim().split(/\s+/)[0];
    if (!/^[0-9]{5,6}P?$/i.test(code)) throw new Error('找不到這檔權證，請改輸入代號');
    const fm = await finmindClose(code.toUpperCase());
    return { code: code.toUpperCase(), name: '', close: fm.close, date: fm.date, src: 'FinMind' };
  }

  // ---------- 分頁 ----------
  function showTab(t) {
    S.tab = t;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + t));
    if (t === 'warrant') loadWarrants();
    if (t === 'check') updateChecks();
    if (t === 'log') updateLog();
    save();
  }

  // ---------- 共用：綁定輸入 ----------
  function bindNum(id, obj, key, after) {
    const el = $(id);
    el.value = obj[key] ?? '';
    el.addEventListener('input', () => {
      obj[key] = el.type === 'number' ? (el.value === '' ? '' : +el.value) : el.value;
      after(); save();
    });
  }
  const feeOf = (o) => ({ rate: +o.rate || 0, discount: o.disc === '' ? 1 : +o.disc, minFee: +o.min || 0, taxRate: +o.tax || 0 });

  function daysTable(prefix, unitLabel) {
    const head = `<tr><th>階段</th><th>進場日期</th><th>等份</th><th>買進${unitLabel}</th><th>成交價</th><th></th><th>股款</th><th>手續費</th><th>累計${unitLabel}</th><th>累計成本含費</th><th>均價</th><th>均價含費</th></tr>`;
    let body = '';
    for (let i = 0; i < 3; i++) {
      body += `<tr>
        <td>第${i + 1}天</td>
        <td><input type="date" data-k="dates" data-i="${i}"></td>
        <td><input type="number" class="u" min="0" step="1" data-k="units" data-i="${i}"></td>
        <td id="${prefix}_q${i}"></td>
        <td><input type="number" step="0.01" data-k="prices" data-i="${i}"></td>
        <td><button class="btn ghost small" data-close="${i}">收盤</button></td>
        <td id="${prefix}_a${i}"></td><td id="${prefix}_f${i}"></td><td id="${prefix}_cq${i}"></td>
        <td id="${prefix}_cc${i}"></td><td id="${prefix}_av${i}"></td><td id="${prefix}_aw${i}"></td></tr>`;
    }
    body += `<tr><td>第4天</td><td colspan="11" style="text-align:left">出場（無論停損或獲利）</td></tr>`;
    return head + body;
  }
  function wireDays(tableId, obj, after, closeFn) {
    const t = $(tableId);
    t.querySelectorAll('input[data-k]').forEach((el) => {
      const k = el.dataset.k, i = +el.dataset.i;
      el.value = obj[k][i] ?? '';
      el.addEventListener('input', () => {
        obj[k][i] = el.type === 'number' ? (el.value === '' ? '' : +el.value) : el.value;
        if (k === 'prices') obj.example = false;
        after(); save();
      });
    });
    t.querySelectorAll('button[data-close]').forEach((b) => {
      b.addEventListener('click', async () => {
        const i = +b.dataset.close;
        b.disabled = true;
        try {
          const r = await closeFn();
          obj.prices[i] = r.close;
          if (!obj.dates[i]) obj.dates[i] = r.date || todayISO();
          t.querySelector(`input[data-k="prices"][data-i="${i}"]`).value = r.close;
          t.querySelector(`input[data-k="dates"][data-i="${i}"]`).value = obj.dates[i];
          after(); save();
        } catch (e) { alert(e.message); }
        b.disabled = false;
      });
    });
  }
  function fillDays(prefix, plan, unit) {
    plan.days.forEach((d, i) => {
      $(`${prefix}_q${i}`).textContent = d.qty ? nf0.format(d.qty) + unit : '-';
      $(`${prefix}_a${i}`).textContent = d.filled ? money(d.amount) : '-';
      $(`${prefix}_f${i}`).textContent = d.filled ? money(d.fee) : '-';
      $(`${prefix}_cq${i}`).textContent = d.filled ? nf0.format(d.cumQty) : '-';
      $(`${prefix}_cc${i}`).textContent = d.filled ? money(d.cumCost) : '-';
      $(`${prefix}_av${i}`).textContent = d.filled ? p2(d.avg) : '-';
      $(`${prefix}_aw${i}`).textContent = d.filled ? p2(d.avgWithFee) : '-';
    });
  }
  function scenarioTable(rows, isWarrant) {
    const head = isWarrant
      ? '<tr><th>標的漲跌</th><th>權證估計漲跌</th><th>權證出場價</th><th>賣出金額</th><th>手續費＋稅</th><th>淨損益</th><th>報酬率</th><th>佔總資金</th></tr>'
      : '<tr><th>第4天漲跌</th><th>出場價</th><th>賣出金額</th><th>手續費＋稅</th><th>淨損益</th><th>報酬率</th><th>佔總資金</th></tr>';
    return head + rows.map((r) => {
      const cls = r.pnl > 0 ? 'pos' : r.pnl < 0 ? 'neg' : '';
      return `<tr class="${cls}${r.pct === 0 ? ' base' : ''}"><td>${pct(r.pct, 0)}${Math.abs(r.pct) === 0.1 ? (r.pct > 0 ? ' 漲停' : ' 跌停') : ''}</td>
        ${isWarrant ? `<td>${pct(r.wPct, 0)}</td>` : ''}<td>${p2(r.exitPrice)}</td><td>${money(r.amount)}</td><td>${money(r.sellCost)}</td>
        <td class="pnl">${signed(r.pnl)}</td><td class="pnl">${pct(r.ret)}</td><td>${pct(r.ofCapital)}</td></tr>`;
    }).join('');
  }
  function exitResult(el, plan, price, fee, capital, mult) {
    if (!(price > 0) || !plan.summary.shares) { el.innerHTML = ''; return; }
    const r = C.exitPnL(plan.summary.qty * mult, price, plan.summary.totalCost, fee, capital);
    const c = r.pnl >= 0 ? 'pos' : 'neg';
    el.innerHTML = kpi('淨損益（元）', signed(r.pnl), c + ' key') + kpi('報酬率', pct(r.ret), c) + kpi('佔總資金', pct(r.ofCapital), c);
  }

  // ---------- 股票 ----------
  let stockPlan;
  function quoteHTML(r, extra = '') {
    return `<b>${esc(r.code)} ${esc(r.name)}</b>　收盤 <b>${p2(r.close)}</b> 元　<span>${esc(r.date || '')}</span>${extra}<br><small>來源：${esc(r.src)}</small>`;
  }
  async function doStockLookup() {
    const q = $('s_query').value;
    $('s_quote').innerHTML = '查詢中…';
    try {
      const r = await lookupStock(q);
      Object.assign(S.stock, { query: q, code: r.code, name: r.name, close: r.close, cap: r.cap, market: r.market, qdate: r.date });
      S.stock.ref = r.close;
      S.stock.prices[0] = r.close;
      if (!S.stock.dates[0] || S.stock.dates[0] === DEFAULTS.stock.dates[0]) S.stock.dates[0] = r.date || todayISO();
      $('s_ref').value = r.close;
      $('s_days').querySelector('input[data-k="prices"][data-i="0"]').value = r.close;
      $('s_days').querySelector('input[data-k="dates"][data-i="0"]').value = S.stock.dates[0];
      const cap = r.cap ? `　股本 <b>${nf2.format(r.cap)}</b> 億${r.market ? '（' + r.market + '）' : ''}` : '';
      $('s_quote').innerHTML = quoteHTML(r, cap);
      updateStock(); save();
    } catch (e) {
      $('s_quote').innerHTML = `<span class="err">${esc(e.message)}</span>`;
    }
  }
  function updateStock() {
    const s = S.stock, fee = feeOf(s);
    stockPlan = C.plan({ capital: +s.capital || 0, refPrice: +s.ref || 0, units: s.units, prices: s.prices, fee });
    const p = stockPlan, m = p.summary;
    $('s_split').innerHTML = kpi('總等份', nf0.format(p.totalUnits)) + kpi('每等份金額', money(p.perUnitCash) + ' 元') + kpi('每等份股數', nf0.format(p.perUnitQty) + ' 股', 'key');
    fillDays('s', p, ' 股');
    $('s_summary').innerHTML =
      kpi('總持股', nf0.format(m.shares) + ' 股') + kpi('總股款', money(m.amount)) + kpi('總成本含手續費', money(m.totalCost)) +
      kpi('平均成本（不含費）', p2(m.avg), 'key') + kpi('平均成本（含費）', p2(m.avgWithFee), 'key') +
      kpi('剩餘現金', money(m.cashLeft), m.cashLeft < 0 ? 'neg' : '') + kpi('資金使用率', pct(m.usage, 1).replace('+', '')) +
      kpi('三次執行資金', m.enough ? '✔ 足夠' : '✘ 不足', m.enough ? 'pos' : 'neg') +
      kpi('第4天回本漲幅（不含費）', pct(m.breakEvenPct)) + kpi('損益兩平賣價（含費稅）', p2(m.breakEvenPrice), 'key') +
      kpi('第4天回本漲幅（含費稅）', pct(m.breakEvenPctFee), 'key');
    if (m.lastPrice && m.shares) {
      $('s_scen').innerHTML = scenarioTable(C.stockScenarios(m.shares, m.lastPrice, m.totalCost, fee, +s.capital), false);
    } else $('s_scen').innerHTML = '<tr><td>請先填入成交價</td></tr>';
    exitResult($('s_exitResult'), p, +s.exit, fee, +s.capital, 1);
  }

  // ---------- 權證 ----------
  let warrantPlan;
  async function doUnderLookup() {
    const q = $('w_uquery').value;
    $('w_uquote').innerHTML = '查詢中…';
    try {
      const r = await lookupStock(q);
      Object.assign(S.warrant, { uquery: q, ucode: r.code, uname: r.name, under: r.close });
      $('w_under').value = r.close;
      $('w_uquote').innerHTML = quoteHTML(r);
      updateWarrant(); save();
    } catch (e) { $('w_uquote').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  }
  async function doWarrantLookup() {
    const q = $('w_query').value;
    $('w_quote').innerHTML = '查詢中…';
    try {
      const r = await lookupWarrant(q);
      Object.assign(S.warrant, { query: q, code: r.code, name: r.name, close: r.close, ref: r.close, example: false });
      if (/售/.test(r.name) || /P$/.test(r.code)) { S.warrant.type = 'put'; $('w_type').value = 'put'; }
      S.warrant.prices[0] = r.close;
      $('w_ref').value = r.close;
      $('w_days').querySelector('input[data-k="prices"][data-i="0"]').value = r.close;
      $('w_quote').innerHTML = quoteHTML(r);
      updateWarrant(); save();
    } catch (e) { $('w_quote').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  }
  function updateWarrant() {
    const w = S.warrant, fee = feeOf(w);
    if (w.example && !w.code) $('w_quote').innerHTML = '<small>目前是範例數字，請查詢或輸入實際權證。</small>';
    const mt = C.warrantMetrics({ type: w.type, underlying: w.under, strike: w.strike, ratio: w.ratio, bid: w.bid, ask: w.ask, leverage: w.lev, expiry: w.expiry });
    S._wm = mt;
    const otm = mt.moneyness;
    $('w_metrics').innerHTML =
      kpi('價內外', otm === undefined ? '-' : (otm >= 0 ? '價內 ' : '價外 ') + (Math.abs(otm) * 100).toFixed(1) + '%') +
      kpi('剩餘天數', mt.daysLeft === undefined ? '-' : mt.daysLeft + ' 天', mt.daysLeft !== undefined && mt.daysLeft < S.check.wDays ? 'neg' : '') +
      kpi('買賣價差比', mt.spreadPct === undefined ? '-' : (mt.spreadPct * 100).toFixed(2) + '%') +
      kpi('差槓比', mt.spreadLevRatio === undefined ? '-' : mt.spreadLevRatio.toFixed(3)) +
      kpi('每單位內含價值', mt.intrinsic === null || mt.intrinsic === undefined ? '-' : mt.intrinsic.toFixed(3));

    warrantPlan = C.plan({ capital: +w.capital || 0, refPrice: +w.ref || 0, units: w.units, prices: w.prices, multiplier: 1000, fee });
    const p = warrantPlan, m = p.summary;
    $('w_split').innerHTML = kpi('總等份', nf0.format(p.totalUnits)) + kpi('每等份金額', money(p.perUnitCash) + ' 元') +
      kpi('每等份張數', nf0.format(p.perUnitQty) + ' 張', 'key') + (p.perUnitQty === 0 && w.ref ? kpi('提醒', '資金不足 1 張', 'neg') : '');
    fillDays('w', p, ' 張');
    $('w_summary').innerHTML =
      kpi('總持有', nf0.format(m.qty) + ' 張') + kpi('總權利金', money(m.amount)) + kpi('總成本含手續費', money(m.totalCost)) +
      kpi('平均成本（不含費）', m.avg ? m.avg.toFixed(3) : '-', 'key') + kpi('平均成本（含費）', m.avgWithFee ? m.avgWithFee.toFixed(3) : '-', 'key') +
      kpi('剩餘現金', money(m.cashLeft), m.cashLeft < 0 ? 'neg' : '') + kpi('資金使用率', pct(m.usage, 1).replace('+', '')) +
      kpi('三次執行資金', m.enough ? '✔ 足夠' : '✘ 不足', m.enough ? 'pos' : 'neg') +
      kpi('損益兩平權證價（含費稅）', m.breakEvenPrice ? m.breakEvenPrice.toFixed(3) : '-', 'key') +
      kpi('權證需漲（含費稅）', pct(m.breakEvenPctFee), 'key') +
      kpi('約當標的需漲', +w.lev ? pct(m.breakEvenPctFee / +w.lev) : '-');
    if (m.lastPrice && m.shares && +w.lev) {
      $('w_scen').innerHTML = scenarioTable(C.warrantScenarios(m.shares, m.lastPrice, +w.lev, m.totalCost, fee, +w.capital), true);
    } else $('w_scen').innerHTML = '<tr><td>請填入成交價與實質槓桿</td></tr>';
    exitResult($('w_exitResult'), p, +w.exit, fee, +w.capital, 1000);
  }

  // ---------- 檢查 ----------
  const yn = (k) => `<select data-ck="${k}"><option value="">—</option><option value="是">是</option><option value="否">否</option></select>`;
  function renderChecks() {
    $('c_stock').innerHTML = [
      ['1', '已查詢：無假帳、虧空、財務危機等不利新聞', '查公開資訊觀測站重大訊息＋新聞', yn('news'), 'r_news'],
      ['2', '股本 ≥ 20 億', '股本太小風險偏高；有資料會自動帶入，也可手動填（億元）', `<input type="number" step="0.1" data-ck="capManual" placeholder="自動">`, 'r_cap'],
      ['3', '已確認勝率最高的持有天數（例：第 3 天以後）', '看到訊號先看勝率', yn('winrate'), 'r_win'],
      ['4', '資金足夠執行到勝率最高那天', '自動帶入「股票試算」', '<span class="auto">自動</span>', 'r_fund'],
      ['5', '預計尾盤進場（接近收盤價買進）', '尾盤進場較能取得低價', yn('tail'), 'r_tail'],
      ['6', '資金已按 1：2：6 分批規劃', '不可一次重押', yn('split'), 'r_split'],
    ].map(([n, t, s, i, r]) => `<div class="check"><span class="n">${n}</span><span class="t">${t}<small>${s}</small></span><span class="i">${i}</span><span class="r" id="${r}"></span></div>`).join('');
    $('c_warrant').innerHTML = [
      ['1', '剩餘天數 ≥', `<input type="number" data-ck="wDays" step="5"> 天`, 'r_wdays', '避開快到期、時間價值流失快的權證'],
      ['2', '價外程度 ≤', `<input type="number" data-ck="wOtm" step="1"> %`, 'r_wotm', '太價外的權證 Delta 低、容易歸零'],
      ['3', '買賣價差比 ≤', `<input type="number" data-ck="wSpread" step="0.5"> %`, 'r_wspread', '價差大等於一進場就先虧'],
      ['4', '差槓比 ≤', `<input type="number" data-ck="wSLR" step="0.05">`, 'r_wslr', '價差比 ÷ 實質槓桿，越小越好'],
      ['5', '標的股通過上方股票檢查', '權證只是工具，標的本身要先合格', 'r_wstock', ''],
      ['6', '資金足夠執行三次（權證試算）', '自動帶入「權證試算」', 'r_wfund', ''],
    ].map(([n, t, i, r, s]) => {
      const isInput = i.startsWith('<');
      return `<div class="check"><span class="n">${n}</span><span class="t">${t}<small>${isInput ? s : i}</small></span><span class="i">${isInput ? i : ''}</span><span class="r" id="${r}"></span></div>`;
    }).join('');
    document.querySelectorAll('[data-ck]').forEach((el) => {
      const k = el.dataset.ck;
      el.value = S.check[k] ?? '';
      el.addEventListener('input', () => {
        S.check[k] = el.tagName === 'SELECT' ? el.value : el.value === '' ? '' : +el.value;
        updateChecks(); if (k === 'wDays') updateWarrant(); save();
      });
    });
  }
  function setR(id, state, text) {
    const el = $(id);
    el.className = 'r ' + (state === true ? 'ok' : state === false ? 'bad' : 'pend');
    el.textContent = state === true ? '✔ ' + (text || '通過') : state === false ? '✘ ' + (text || '不符') : text || '待填';
    return state;
  }
  function updateChecks() {
    if (!$('r_news')) return;
    const c = S.check;
    const ynr = (v) => (v === '是' ? true : v === '否' ? false : null);
    const capVal = c.capManual !== '' ? +c.capManual : S.stock.cap;
    const res = [
      setR('r_news', ynr(c.news)),
      setR('r_cap', capVal ? capVal >= 20 : null, capVal ? `${nf2.format(capVal)} 億` : '待填'),
      setR('r_win', ynr(c.winrate)),
      setR('r_fund', stockPlan ? stockPlan.summary.enough : null, stockPlan ? (stockPlan.summary.enough ? '足夠' : '不足') : ''),
      setR('r_tail', ynr(c.tail)),
      setR('r_split', ynr(c.split)),
    ];
    const allOk = res.every((x) => x === true);
    const v = $('c_stockVerdict');
    v.className = 'verdict ' + (allOk ? 'ok' : 'bad');
    v.textContent = allOk ? '✅ 全部通過，可依計畫執行' : '⛔ 尚有項目未通過或待填，暫不進場';

    const mt = S._wm || {};
    const wres = [
      setR('r_wdays', mt.daysLeft === undefined ? null : mt.daysLeft >= c.wDays, mt.daysLeft === undefined ? '請填到期日' : mt.daysLeft + ' 天'),
      setR('r_wotm', mt.moneyness === undefined ? null : mt.moneyness >= -c.wOtm / 100, mt.moneyness === undefined ? '請填履約價' : (mt.moneyness >= 0 ? '價內 ' : '價外 ') + Math.abs(mt.moneyness * 100).toFixed(1) + '%'),
      setR('r_wspread', mt.spreadPct === undefined ? null : mt.spreadPct * 100 <= c.wSpread, mt.spreadPct === undefined ? '請填買賣價' : (mt.spreadPct * 100).toFixed(2) + '%'),
      setR('r_wslr', mt.spreadLevRatio === undefined ? null : mt.spreadLevRatio <= c.wSLR, mt.spreadLevRatio === undefined ? '請填槓桿' : mt.spreadLevRatio.toFixed(3)),
      setR('r_wstock', allOk ? true : res.some((x) => x === false) ? false : null, allOk ? '通過' : res.some((x) => x === false) ? '未通過' : '待完成'),
      setR('r_wfund', warrantPlan ? warrantPlan.summary.enough && warrantPlan.perUnitQty > 0 : null, warrantPlan ? (warrantPlan.summary.enough && warrantPlan.perUnitQty > 0 ? '足夠' : '不足') : ''),
    ];
    const wOk = wres.every((x) => x === true);
    const wv = $('c_warrantVerdict');
    wv.className = 'verdict ' + (wOk ? 'ok' : 'bad');
    wv.textContent = wOk ? '✅ 權證條件全部通過' : '⛔ 權證條件尚未全部通過';
  }

  // ---------- 交易紀錄 ----------
  const LOG_COLS = [
    ['date', '日期', 'date'], ['name', '名稱', 'text'], ['code', '代號', 'text'], ['stage', '階段', 'text'],
    ['kind', '股票/權證', 'kind'], ['side', '買/賣', 'side'], ['price', '成交價', 'number'], ['qty', '數量（股或張）', 'number'], ['note', '備註', 'text'],
  ];
  function renderLog() {
    const head = '<tr>' + LOG_COLS.map((c) => `<th>${c[1]}</th>`).join('') + '<th>金額</th><th>手續費＋稅</th><th></th></tr>';
    const rows = S.log.map((r, i) => '<tr>' + LOG_COLS.map(([k, , t], j) => {
      let inp;
      if (t === 'side') inp = `<select data-l="${k}" data-i="${i}"><option>買</option><option>賣</option></select>`;
      else if (t === 'kind') inp = `<select data-l="${k}" data-i="${i}"><option>股票</option><option>權證</option></select>`;
      else inp = `<input type="${t}" ${t === 'number' ? 'step="any"' : ''} class="${k === 'note' || k === 'name' ? 'wide' : ''}" data-l="${k}" data-i="${i}">`;
      return j === 0 ? `<td>${inp}</td>` : `<td>${inp}</td>`;
    }).join('') + `<td id="l_amt${i}"></td><td id="l_fee${i}"></td><td><button class="btn ghost small" data-del="${i}">刪除</button></td></tr>`).join('');
    $('l_table').innerHTML = head + (rows || `<tr><td colspan="${LOG_COLS.length + 3}" style="text-align:center;color:var(--muted)">還沒有紀錄</td></tr>`);
    $('l_table').querySelectorAll('[data-l]').forEach((el) => {
      const r = S.log[+el.dataset.i], k = el.dataset.l;
      el.value = r[k] ?? (k === 'side' ? '買' : k === 'kind' ? '股票' : '');
      el.addEventListener('input', () => { r[k] = el.type === 'number' ? (el.value === '' ? '' : +el.value) : el.value; updateLog(); save(); });
    });
    $('l_table').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm('刪除這筆紀錄？')) return;
      S.log.splice(+b.dataset.del, 1); renderLog(); updateLog(); save();
    }));
    updateLog();
  }
  function logRowCalc(r) {
    const isW = r.kind === '權證';
    const src = isW ? S.warrant : S.stock;
    const fee = feeOf(src);
    const amount = (+r.price || 0) * (+r.qty || 0) * (isW ? 1000 : 1);
    if (!amount) return { amount: 0, cost: 0 };
    const cost = r.side === '賣' ? C.sellCost(amount, fee) : C.buyFee(amount, fee);
    return { amount, cost };
  }
  function updateLog() {
    let buy = 0, sell = 0, fees = 0;
    S.log.forEach((r, i) => {
      const { amount, cost } = logRowCalc(r);
      const a = $('l_amt' + i), f = $('l_fee' + i);
      if (a) { a.textContent = money(amount); f.textContent = money(cost); }
      if (r.side === '賣') sell += amount; else buy += amount;
      fees += cost;
    });
    const net = sell - buy - fees;
    $('l_summary').innerHTML = S.log.length
      ? kpi('買進金額', money(buy)) + kpi('賣出金額', money(sell)) + kpi('手續費＋稅', money(fees)) +
        kpi('已實現淨損益', sell ? signed(net) : '-', sell ? (net >= 0 ? 'pos key' : 'neg key') : '')
      : '';
  }
  function addFromPlan(isW) {
    const src = isW ? S.warrant : S.stock;
    const plan = isW ? warrantPlan : stockPlan;
    const name = isW ? src.name || '權證' : src.name, code = isW ? src.code : src.code;
    plan.days.forEach((d, i) => {
      if (!d.filled) return;
      S.log.push({ date: src.dates[i] || '', name, code, stage: `第${i + 1}天`, kind: isW ? '權證' : '股票', side: '買', price: d.price, qty: d.qty, note: i === 0 ? '尾盤進場' : '' });
    });
    renderLog(); save();
  }
  function exportCSV() {
    const head = LOG_COLS.map((c) => c[1]).concat(['金額', '手續費＋稅']);
    const lines = [head].concat(S.log.map((r) => {
      const { amount, cost } = logRowCalc(r);
      return LOG_COLS.map(([k]) => r[k] ?? (k === 'side' ? '買' : k === 'kind' ? '股票' : '')).concat([Math.round(amount), cost]);
    }));
    const csv = '﻿' + lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `地板股交易紀錄_${todayISO()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- 初始化 ----------
  function init() {
    // 股票
    $('s_query').value = S.stock.query || '';
    if (S.stock.close) $('s_quote').innerHTML = quoteHTML({ code: S.stock.code, name: S.stock.name, close: S.stock.close, date: S.stock.qdate, src: '上次查詢' });
    else $('s_quote').innerHTML = '<small>預設是信邦 10/28 的範例數字；輸入代號後按「帶入收盤價」。</small>';
    ['capital', 'ref', 'rate', 'disc', 'min', 'tax', 'exit'].forEach((k) => bindNum('s_' + k, S.stock, k, () => { updateStock(); updateChecks(); }));
    $('s_days').innerHTML = daysTable('s', '股數');
    wireDays('s_days', S.stock, () => { updateStock(); updateChecks(); }, () => lookupStock(S.stock.code || $('s_query').value));
    $('s_lookup').addEventListener('click', doStockLookup);
    $('s_query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doStockLookup(); });

    // 權證
    $('w_uquery').value = S.warrant.uquery || '';
    $('w_query').value = S.warrant.query || '';
    if (S.warrant.code && S.warrant.close) $('w_quote').innerHTML = quoteHTML({ code: S.warrant.code, name: S.warrant.name, close: S.warrant.close, src: '上次查詢' });
    ['under', 'strike', 'ratio', 'lev', 'bid', 'ask', 'capital', 'ref', 'rate', 'disc', 'min', 'tax', 'exit'].forEach((k) =>
      bindNum('w_' + k, S.warrant, k, () => { updateWarrant(); updateChecks(); }));
    bindNum('w_expiry', S.warrant, 'expiry', () => { updateWarrant(); updateChecks(); });
    bindNum('w_type', S.warrant, 'type', () => { updateWarrant(); updateChecks(); });
    $('w_days').innerHTML = daysTable('w', '張數');
    wireDays('w_days', S.warrant, () => { updateWarrant(); updateChecks(); }, () => lookupWarrant(S.warrant.code || $('w_query').value));
    $('w_ulookup').addEventListener('click', doUnderLookup);
    $('w_lookup').addEventListener('click', doWarrantLookup);
    $('w_uquery').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnderLookup(); });
    $('w_query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doWarrantLookup(); });

    // 檢查、紀錄
    renderChecks();
    $('l_add').addEventListener('click', () => { S.log.push({ date: todayISO(), side: '買', kind: '股票' }); renderLog(); save(); });
    $('l_fromStock').addEventListener('click', () => addFromPlan(false));
    $('l_fromWarrant').addEventListener('click', () => addFromPlan(true));
    $('l_csv').addEventListener('click', exportCSV);
    renderLog();

    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    updateStock(); updateWarrant(); updateChecks();
    showTab(S.tab || 'stock');
    loadStocks();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
