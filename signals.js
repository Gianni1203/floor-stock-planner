/* 小哥訊號：統計與登錄 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (x, d = 1) => (x === null || x === undefined || isNaN(x) ? '-' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
  const KEY = 'floor-stock-signals-v1';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } },
    set(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* ignore */ } },
  };
  const pref = store.get();

  let CATS = [];
  let DATA = null;
  let NAMES = {};
  let listLimit = 100;

  async function getJSON(url) {
    const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  // ---------------- 統計 ----------------
  function filtered() {
    if (!DATA) return [];
    const p = $('sg_period').value;
    if (p === 'all') return DATA.signals;
    const latest = DATA.signals.reduce((m, s) => (s.date > m ? s.date : m), '');
    const from = new Date(Date.parse(latest) - (+p) * 86400e3).toISOString().slice(0, 10);
    return DATA.signals.filter((s) => s.date >= from);
  }

  function aggregate(rows) {
    const metric = $('sg_metric').value, cost = +$('sg_cost').value;
    const H = DATA.horizons;
    const by = {};
    CATS.forEach((c) => (by[c.key] = { n: 0, h: {}, gap: [], d1High: [], mfe: [], mae: [] }));
    rows.forEach((s) => {
      const b = by[s.cat];
      if (!b) return;
      b.n++;
      const src = s[metric] || {};
      H.forEach((h) => {
        const v = src[h];
        if (v === undefined || v === null) return;
        (b.h[h] = b.h[h] || []).push(v - cost);
      });
      if (s.gap !== undefined && s.gap !== null) b.gap.push(s.gap);
      if (s.d1High !== undefined && s.d1High !== null) b.d1High.push(s.d1High);
      if (s.mfe5 !== undefined) b.mfe.push(s.mfe5);
      if (s.mae5 !== undefined) b.mae.push(s.mae5);
    });
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const out = {};
    Object.entries(by).forEach(([k, b]) => {
      const hs = {};
      H.forEach((h) => {
        const a = b.h[h] || [];
        hs[h] = { n: a.length, win: a.length ? a.filter((v) => v > 0).length / a.length : null, avg: avg(a) };
      });
      let best = null;
      H.forEach((h) => { if (hs[h].n >= 10 && (best === null || hs[h].avg > hs[best].avg)) best = h; });
      out[k] = { n: b.n, hs, best, gap: avg(b.gap), d1High: avg(b.d1High), mfe: avg(b.mfe), mae: avg(b.mae) };
    });
    return out;
  }

  function heat(v) {
    if (v === null) return '';
    const a = Math.min(Math.abs(v) / 0.03, 1); // 3% 以上全色
    return v >= 0 ? `background:rgba(15,123,63,${(0.08 + a * 0.32).toFixed(2)})` : `background:rgba(180,35,24,${(0.08 + a * 0.32).toFixed(2)})`;
  }

  function renderStats() {
    if (!DATA) return;
    const agg = aggregate(filtered());
    const H = DATA.horizons;
    let html = '<tr><th>類別</th><th>方向</th><th>訊號數</th>' + H.map((h) => `<th>持有 ${h} 天</th>`).join('') +
      '<th>隔天跳空</th><th>隔天最高</th><th>5 天內最大有利</th><th>5 天內最大不利</th></tr>';
    CATS.forEach((c) => {
      const a = agg[c.key];
      const thin = a.n < 20 ? ' thin' : '';
      html += `<tr class="${thin}"><td title="${esc(c.note)}">${esc(c.label)}</td><td><span class="dir ${c.dir > 0 ? 'long' : 'short'}">${c.dir > 0 ? '多' : '空'}</span></td><td>${a.n}</td>` +
        H.map((h) => {
          const x = a.hs[h];
          if (!x.n) return '<td class="hc">-</td>';
          return `<td class="hc${a.best === h ? ' best' : ''}" style="${heat(x.avg)}"><b>${(x.win * 100).toFixed(0)}%</b><small>${pct(x.avg, 2)}・${x.n}筆</small></td>`;
        }).join('') +
        `<td>${pct(a.gap)}</td><td>${pct(a.d1High)}</td><td>${pct(a.mfe)}</td><td>${pct(a.mae)}</td></tr>`;
    });
    $('sg_table').innerHTML = html;
    renderLatest(agg);
  }

  function rowReturns(s) {
    const H = DATA.horizons;
    return H.map((h) => {
      const v = (s.r || {})[h];
      const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
      return `<td class="${cls}">${v === undefined ? '·' : pct(v)}</td>`;
    }).join('');
  }
  const statusText = (s) => ({ pending: '待開盤', tracking: `追蹤中（第 ${s.days} 天）`, done: '完成' }[s.status] || s.status);
  const nameOf = (s) => s.name || NAMES[s.code] || '';

  function renderLatest(agg) {
    const latest = DATA.signals.reduce((m, s) => (s.date > m ? s.date : m), '');
    $('sg_latestDate').textContent = latest || '';
    if (!latest) { $('sg_latest').innerHTML = '<p class="note">還沒有登錄任何訊號。到「訊號登錄」新增第一天。</p>'; return; }
    const today = DATA.signals.filter((s) => s.date === latest);
    let html = '';
    CATS.forEach((c) => {
      const rows = today.filter((s) => s.cat === c.key);
      if (!rows.length) return;
      const a = agg[c.key];
      const hint = a.best ? `歷史上持有 ${a.best} 天最好：勝率 ${(a.hs[a.best].win * 100).toFixed(0)}%、平均 ${pct(a.hs[a.best].avg, 2)}（${a.hs[a.best].n} 筆）` : '樣本還不夠，先累積';
      html += `<div class="latest-cat"><div class="lc-head"><b>${esc(c.label)}</b> <span class="dir ${c.dir > 0 ? 'long' : 'short'}">${c.dir > 0 ? '多' : '空'}</span><small>${hint}</small></div>
        <div class="chips">${rows.map((s) => `<span class="chip" title="${esc(statusText(s))}">${esc(s.code)} ${esc(nameOf(s))}${s.r && s.r[1] !== undefined ? ` <em class="${s.r[1] > 0 ? 'pos' : 'neg'}">${pct(s.r[1])}</em>` : ''}</span>`).join('')}</div></div>`;
    });
    $('sg_latest').innerHTML = html;
  }

  function renderList() {
    if (!DATA) return;
    const cat = $('sg_fcat').value, q = $('sg_fcode').value.trim();
    let rows = filtered();
    if (cat) rows = rows.filter((s) => s.cat === cat);
    if (q) rows = rows.filter((s) => s.code.includes(q.toUpperCase()) || nameOf(s).includes(q));
    const H = DATA.horizons;
    const catLabel = Object.fromEntries(CATS.map((c) => [c.key, c.label]));
    let html = '<tr><th>訊號日</th><th>代號</th><th>名稱</th><th>類別</th><th>進場價</th>' + H.map((h) => `<th>${h} 天</th>`).join('') + '<th>狀態</th></tr>';
    html += rows.slice(0, listLimit).map((s) => `<tr><td>${s.date}</td><td>${esc(s.code)}</td><td>${esc(nameOf(s))}</td><td>${esc(catLabel[s.cat] || s.cat)}</td>
      <td>${s.entry ? s.entry.toFixed(2) : '-'}</td>${rowReturns(s)}<td>${statusText(s)}</td></tr>`).join('');
    if (!rows.length) html += `<tr><td colspan="${H.length + 6}" style="text-align:center;color:var(--muted)">沒有符合的訊號</td></tr>`;
    $('sg_list').innerHTML = html;
    $('sg_more').hidden = rows.length <= listLimit;
  }

  async function loadStats() {
    try {
      DATA = await getJSON('data/signals.json');
      CATS = DATA.categories;
      $('sg_meta').textContent = `共 ${DATA.count} 筆・價格資料到 ${DATA.histTo || '-'}・更新於 ${String(DATA.updated || '').replace('T', ' ')}`;
    } catch (e) {
      DATA = { signals: [], horizons: [1, 2, 3, 5, 10, 20], categories: CATS };
      $('sg_meta').textContent = '尚無統計資料（第一次 GitHub Actions 跑完後會出現）';
    }
    $('sg_fcat').innerHTML = '<option value="">全部類別</option>' + CATS.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('');
    renderStats();
    renderList();
  }

  // ---------------- 登錄 ----------------
  const CODE_RE = /(^|[^0-9A-Z])(\d{4,6}[A-Z]?)(?![0-9])/g;
  function parseCodes(text) {
    const out = [];
    let m;
    CODE_RE.lastIndex = 0;
    const t = String(text || '').toUpperCase();
    while ((m = CODE_RE.exec(t))) {
      const c = m[2];
      if (/^20\d{2}$/.test(c) && !NAMES[c]) continue; // 年份
      if (!out.includes(c)) out.push(c);
    }
    return out;
  }
  function entryState() {
    const st = store.get();
    st.entry = st.entry || {};
    return st;
  }
  function buildEntry() {
    const st = entryState();
    $('en_cats').innerHTML = CATS.map((c) => `
      <div class="entry-cat">
        <div class="ec-head"><b>${esc(c.label)}</b> <span class="dir ${c.dir > 0 ? 'long' : 'short'}">${c.dir > 0 ? '多' : '空'}</span></div>
        <textarea data-cat="${esc(c.key)}" rows="3" placeholder="貼上代號，空白、逗號、換行都可以">${esc((st.entry[c.key]) || '')}</textarea>
        <div class="chips" id="en_chips_${esc(c.key)}"></div>
      </div>`).join('');
    $('en_cats').querySelectorAll('textarea').forEach((ta) => ta.addEventListener('input', () => {
      const s2 = entryState(); s2.entry[ta.dataset.cat] = ta.value; store.set(s2); updateEntry();
    }));
    updateEntry();
  }
  function currentRows() {
    const rows = [];
    $('en_cats').querySelectorAll('textarea').forEach((ta) => {
      parseCodes(ta.value).forEach((code) => rows.push({ code, cat: ta.dataset.cat }));
    });
    return rows;
  }
  function csvText() {
    return 'code,cat,note\n' + currentRows().map((r) => `${r.code},${r.cat},${NAMES[r.code] || ''}`).join('\n') + '\n';
  }
  function updateEntry() {
    const known = Object.keys(NAMES).length > 0;
    $('en_cats').querySelectorAll('textarea').forEach((ta) => {
      const codes = parseCodes(ta.value);
      $('en_chips_' + ta.dataset.cat).innerHTML = codes.map((c) => {
        const n = NAMES[c];
        const bad = known && !n;
        return `<span class="chip${bad ? ' bad' : ''}" title="${bad ? '收盤價資料裡找不到這個代號' : ''}">${esc(c)} ${esc(n || (bad ? '？' : ''))}</span>`;
      }).join('');
    });
    const rows = currentRows();
    $('en_count').textContent = `${rows.length} 筆`;
    $('en_csv').textContent = csvText();
  }
  function repo() {
    const v = $('en_repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    return /^[\w.-]+\/[\w.-]+$/.test(v) ? v : '';
  }
  function detectRepo() {
    const h = location.hostname;
    const m = h.match(/^([\w-]+)\.github\.io$/i);
    if (m) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      return `${m[1]}/${seg && !seg.includes('.') ? seg : m[1] + '.github.io'}`;
    }
    return '';
  }
  function defaultDate() {
    const d = new Date(Date.now() + 8 * 3600e3);
    // 週末預設回到週五
    const wd = d.getUTCDay();
    if (wd === 6) d.setUTCDate(d.getUTCDate() - 1);
    if (wd === 0) d.setUTCDate(d.getUTCDate() - 2);
    return d.toISOString().slice(0, 10);
  }
  function needRepo() {
    const r = repo();
    if (!r) { alert('請先填「GitHub 帳號/Repo」，例如 mingcing/floor-stock-planner'); $('en_repo').focus(); }
    return r;
  }
  function wireEntry() {
    $('en_date').value = pref.date || defaultDate();
    $('en_repo').value = pref.repo || detectRepo();
    $('en_date').addEventListener('change', () => { const s = store.get(); s.date = $('en_date').value; store.set(s); });
    $('en_repo').addEventListener('input', () => { const s = store.get(); s.repo = $('en_repo').value.trim(); store.set(s); });
    $('en_github').addEventListener('click', () => {
      const r = needRepo(); if (!r) return;
      if (!currentRows().length) { alert('還沒有任何代號'); return; }
      const url = `https://github.com/${r}/new/main?filename=${encodeURIComponent('signals/' + $('en_date').value + '.csv')}&value=${encodeURIComponent(csvText())}&message=${encodeURIComponent('📝 data(signals): 登錄 ' + $('en_date').value + ' 小哥訊號')}`;
      window.open(url, '_blank', 'noopener');
    });
    $('en_edit').addEventListener('click', () => {
      const r = needRepo(); if (!r) return;
      window.open(`https://github.com/${r}/edit/main/signals/${$('en_date').value}.csv`, '_blank', 'noopener');
    });
    $('en_copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(csvText()); $('en_copy').textContent = '已複製 ✓'; setTimeout(() => ($('en_copy').textContent = '複製 CSV'), 1500); }
      catch (e) { alert('瀏覽器不允許複製，請手動選取預覽內容'); }
    });
    $('en_download').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csvText()], { type: 'text/csv;charset=utf-8' }));
      a.download = $('en_date').value + '.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('en_load').addEventListener('click', async () => {
      try {
        const r = await fetch(`signals/${$('en_date').value}.csv?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) throw new Error('這天還沒有登錄檔案');
        const text = await r.text();
        const by = {};
        text.split(/\r?\n/).slice(1).forEach((line) => {
          const [code, cat] = line.split(',');
          if (code && cat) (by[cat] = by[cat] || []).push(code.trim());
        });
        const s = entryState();
        CATS.forEach((c) => (s.entry[c.key] = (by[c.key] || []).join(' ')));
        store.set(s);
        buildEntry();
      } catch (e) { alert(e.message); }
    });
  }

  async function init() {
    try { CATS = await getJSON('signals/categories.json'); } catch (e) { CATS = []; }
    try { const p = await getJSON('data/prices.json'); NAMES = Object.fromEntries(Object.entries(p.s || {}).map(([c, v]) => [c, v[0]])); } catch (e) { NAMES = {}; }
    wireEntry();
    buildEntry();
    ['sg_period', 'sg_metric', 'sg_cost'].forEach((id) => $(id).addEventListener('change', () => { renderStats(); renderList(); }));
    $('sg_fcat').addEventListener('change', () => { listLimit = 100; renderList(); });
    $('sg_fcode').addEventListener('input', () => { listLimit = 100; renderList(); });
    $('sg_more').addEventListener('click', () => { listLimit += 200; renderList(); });
    await loadStats();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
