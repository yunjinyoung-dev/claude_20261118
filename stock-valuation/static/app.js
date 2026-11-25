/* 밸류 체커 — 화면 로직 */
(() => {
  'use strict';
  const S = window.ValueStats;
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 30000;
  const LEVEL_LABEL = { 2: '강한 고평가 경계', 1: '고평가 경계', 0: '평균', '-1': '1차 매수', '-1.5': '2차 매수', '-2': '3차 매수', '-2.5': '추가 매수' };
  const LEVEL_COLOR = { 2: 'var(--over-2)', 1: 'var(--over-1)', 0: 'var(--fair)', '-1': 'var(--under-1)', '-1.5': 'var(--under-1)', '-2': 'var(--under-2)', '-2.5': 'var(--under-2)' };

  const st = { data: null, n: 250, timer: null, busy: false, reqId: 0 };

  /* ---------- 서식 ---------- */
  const isKRW = () => st.data && st.data.quote.currency === 'KRW';
  function money(v, opts = {}) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    if (isKRW()) return Math.round(v).toLocaleString('ko-KR') + (opts.bare ? '' : '원');
    const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '-' : '') + (opts.bare ? '' : '$') + s;
  }
  const pct = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d) + '%');
  const signCls = (v) => (v > 0 ? 'rise' : v < 0 ? 'fall' : '');
  const fmtNum = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? null : v.toLocaleString('ko-KR', { maximumFractionDigits: d }));
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v);
    }
    for (const k of kids) if (k !== null && k !== undefined) e.append(k instanceof Node ? k : String(k));
    return e;
  }

  /* ---------- 서버 ---------- */
  async function api(path) {
    let res;
    try { res = await fetch(path); } catch (e) { throw new Error('밸류 체커 서버에 연결할 수 없어요. 서버 창이 켜져 있는지 확인해 주세요.'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error || `요청 실패 (${res.status})`);
    return body;
  }

  /* ---------- 불러오기 ---------- */
  async function load(q, nation) {
    q = String(q || '').trim();
    if (!q) return;
    const id = ++st.reqId;
    hideSuggest();
    $('error').hidden = true;
    $('empty').hidden = true;
    $('loading').hidden = false;
    $('loading').textContent = `${q} 시세를 불러오는 중…`;
    try {
      const data = await api(`/api/stock?q=${encodeURIComponent(q)}${nation ? '&nation=' + nation : ''}`);
      if (id !== st.reqId) return;
      st.data = data;
      $('q').value = '';
      addRecent(data.item);
      const hash = '#' + encodeURIComponent(data.item.code) + (data.item.nation === 'USA' ? '-US' : '');
      try { if (location.hash !== hash) history.replaceState(null, '', hash); } catch (e) { /* 주소 갱신이 막힌 환경 */ }
      document.title = `${data.item.name} · 밸류 체커`;
      $('result').hidden = false;
      render();
      schedule();
    } catch (e) {
      if (id !== st.reqId) return;
      $('error').textContent = e.message;
      $('error').hidden = false;
      if (!st.data) $('empty').hidden = false;
    } finally {
      if (id === st.reqId) $('loading').hidden = true;
    }
  }

  async function refreshQuote(manual) {
    if (!st.data || st.busy) return;
    st.busy = true;
    try {
      const { item } = st.data;
      const r = await api(`/api/quote?code=${encodeURIComponent(item.code)}&nation=${item.nation}`);
      if (!st.data || st.data.item.code !== item.code) return;
      const old = st.data.quote.price;
      st.data.quote = Object.assign({}, st.data.quote, r.quote);
      if (st.data.etf && r.nav) st.data.etf.nav = r.nav;
      const day = (r.quote.tradedAt || '').slice(0, 10);
      const h = st.data.history;
      if (r.quote.price && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
        if (h.length && h[h.length - 1][0] === day) h[h.length - 1][1] = r.quote.price;
        else if (!h.length || h[h.length - 1][0] < day) h.push([day, r.quote.price]);
      }
      st.data.fetchedAt = new Date().toISOString();
      render();
      if (old !== r.quote.price) { const p = $('price'); p.classList.remove('flash'); void p.offsetWidth; p.classList.add('flash'); }
    } catch (e) {
      if (manual) { $('error').textContent = e.message; $('error').hidden = false; }
    } finally {
      st.busy = false;
    }
  }
  function schedule() {
    clearInterval(st.timer);
    if ($('auto').checked) st.timer = setInterval(() => { if (document.visibilityState === 'visible') refreshQuote(false); }, REFRESH_MS);
  }

  /* ---------- 그리기 ---------- */
  function render() {
    const d = st.data;
    const a = S.analyze(d.history, st.n);
    renderQuote(d);
    if (a.error) {
      $('error').textContent = a.error; $('error').hidden = false;
      return;
    }
    $('error').hidden = true;
    renderVerdict(d, a);
    renderLevels(d, a);
    renderScenarios(a);
    renderFundamentals(d);
    drawChart(a);
  }

  const STATUS = { OPEN: '장중', CLOSE: '장 마감', PREOPEN: '장 시작 전', AFTERMARKET: '시간외' };
  function renderQuote(d) {
    const { item, quote } = d;
    $('name').textContent = item.name;
    const badges = $('badges');
    badges.replaceChildren(...[
      el('span', { class: 'badge' }, item.nation === 'KOR' ? '한국' : '미국'),
      item.isEtf ? el('span', { class: 'badge etf' }, 'ETF') : null,
    ].filter(Boolean));
    $('meta').textContent = [item.code, quote.exchange || item.market, quote.nameEng && quote.nameEng !== item.name ? quote.nameEng : null].filter(Boolean).join(' · ');
    $('price').textContent = money(quote.price);
    const ch = $('change');
    ch.className = 'q-change ' + signCls(quote.change);
    ch.textContent = `${quote.change > 0 ? '▲ ' : quote.change < 0 ? '▼ ' : ''}${money(Math.abs(quote.change || 0), { bare: true })} (${pct(quote.changeRate, 2)})`;
    const open = quote.marketStatus === 'OPEN';
    const t = (quote.tradedAt || '').replace('T', ' ').slice(0, 16);
    const status = $('status');
    status.replaceChildren(
      el('span', { class: 'dot' + (open ? ' live' : '') }),
      `${STATUS[quote.marketStatus] || quote.marketStatus || ''}${t ? ' · ' + t + (item.nation === 'USA' ? ' (미국 현지)' : '') + ' 체결 기준' : ''} · ${new Date(d.fetchedAt).toLocaleTimeString('ko-KR')} 조회`,
    );
    if (quote.overMarket && quote.overMarket.price) {
      status.append(` · 시간외 ${money(quote.overMarket.price)} (${pct(quote.overMarket.changeRate, 2)})`);
    }
  }

  function renderVerdict(d, a) {
    const pill = $('zonePill');
    pill.className = 'zone-pill ' + a.zone.key;
    pill.textContent = a.zone.label;
    $('zValue').textContent = `z = ${a.z >= 0 ? '+' : ''}${a.z.toFixed(2)}σ`;
    const diff = a.price / a.sma - 1;
    $('vText').textContent =
      `현재가 ${money(a.price)}는 최근 ${a.n}거래일 평균 ${money(a.sma)}보다 ${Math.abs(diff * 100).toFixed(1)}% ${diff >= 0 ? '높아요' : '낮아요'}. ` +
      `표준편차(σ)가 ${money(a.sd)}이므로 평균에서 ${a.z >= 0 ? '위로' : '아래로'} ${Math.abs(a.z).toFixed(2)}σ 떨어진 위치예요.`;
    $('gMarker').style.left = Math.max(0, Math.min(1, (a.z + 3) / 6)) * 100 + '%';
    const facts = [
      ['비교 기간', `${a.from} ~ ${a.to}`],
      ['기간 내 가격 위치', `하위 ${a.percentile.toFixed(0)}%`],
      ['기간 최고 / 최저', `${money(a.hi)} / ${money(a.lo)}`],
      ['연 변동성', `${(a.annualVol * 100).toFixed(1)}%`],
    ];
    $('facts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

    const notes = [];
    const nav = d.etf && d.etf.nav;
    if (nav) {
      const g = (a.price / nav - 1) * 100;
      const word = Math.abs(g) < 0.3 ? '기준가와 거의 같게 거래되고 있어요' : g > 0 ? '기준가보다 비싸게(할증) 거래되고 있어요' : '기준가보다 싸게(할인) 거래되고 있어요';
      notes.push(`기준가(NAV) ${money(nav)} · 괴리율 ${pct(g, 2)} — ${word}.`);
    }
    const f = d.fundamentals || {};
    if (f.targetPrice) notes.push(`애널리스트 평균 목표가 ${money(f.targetPrice)} (현재가 대비 ${pct((f.targetPrice / a.price - 1) * 100)}).`);
    $('extraNote').replaceChildren(...notes.map((t) => el('div', {}, t)));
  }

  function renderLevels(d, a) {
    $('levelsPeriod').textContent = `최근 ${a.n}거래일 기준 · 평균 ± kσ`;
    const rows = [];
    const levels = a.levels.map((l) => ({ ...l, show: l.k < 0 ? S.tickFloor(l.price, d.quote.currency, d.item.isEtf) : l.price }));
    let nowPlaced = false;
    const nowRow = () => el('tr', { class: 'now' },
      el('td', {}, el('span', { class: 'lv' }, el('i', { style: 'background:var(--text)' }), '현재가', el('span', { class: 'sub' }, `${a.z >= 0 ? '+' : ''}${a.z.toFixed(2)}σ`))),
      el('td', { class: 'num' }, money(a.price)), el('td', { class: 'num' }, '–'), el('td', { class: 'num' }, '–'));
    for (const l of levels) {
      if (!nowPlaced && a.price >= l.price) { rows.push(nowRow()); nowPlaced = true; }
      const label = LEVEL_LABEL[String(l.k)];
      const kTxt = l.k === 0 ? '평균' : `${l.k > 0 ? '+' : '−'}${Math.abs(l.k)}σ`;
      const first = el('span', { class: 'lv' }, el('i', { style: `background:${LEVEL_COLOR[String(l.k)]}` }), label, el('span', { class: 'sub' }, l.k === 0 ? '' : kTxt));
      if (l.k < 0 && l.reached) first.append(el('span', { class: 'chk' }, '도달'));
      const freq = l.freq === null ? '–' : el('span', {}, `${(l.freq * 100).toFixed(1)}%`, el('span', { class: 'long' }, l.k < 0 ? ' 아래' : ' 위'));
      rows.push(el('tr', { class: (l.k < 0 ? 'buy' : '') + (l.k === 0 ? ' mean' : '') },
        el('td', {}, first),
        el('td', { class: 'num' }, l.show > 0 ? money(l.show) : '–'),
        el('td', { class: 'num ' + signCls(l.diff) }, pct(l.diff * 100)),
        el('td', { class: 'num' }, freq)));
    }
    if (!nowPlaced) rows.push(nowRow());
    $('levelsTbl').tBodies[0].replaceChildren(...rows);
  }

  function renderScenarios(a) {
    $('volNote').textContent = `일간 변동성 ${(a.sdDaily * 100).toFixed(2)}%`;
    $('scenTbl').tBodies[0].replaceChildren(...a.scenarios.map((s) => el('tr', {},
      el('td', {}, s.label),
      el('td', { class: 'num' }, `${money(s.down1)} `, el('span', { class: 'muted small' }, pct((s.down1 / a.price - 1) * 100))),
      el('td', { class: 'num' }, `${money(s.down2)} `, el('span', { class: 'muted small' }, pct((s.down2 / a.price - 1) * 100))),
      el('td', { class: 'num' }, `${money(s.up1)} `, el('span', { class: 'muted small' }, pct((s.up1 / a.price - 1) * 100))),
    )));
  }

  function renderFundamentals(d) {
    const f = d.fundamentals || {}, e = d.etf, kr = d.item.nation === 'KOR';
    const rows = [];
    const add = (k, v) => { if (v !== null && v !== undefined && v !== '' && v !== 'N/A') rows.push([k, v]); };
    const x = (v, unit = '배') => (fmtNum(v) === null ? null : fmtNum(v) + unit);
    if (e) {
      $('fundTitle').textContent = 'ETF 정보';
      if (e.nav) { add('기준가(NAV)', money(e.nav)); add('괴리율', pct((d.quote.price / e.nav - 1) * 100, 2)); }
      add('기초지수', e.baseIndex);
      add('운용사', e.issuer);
      add('총보수', e.fee !== null && e.fee !== undefined ? `연 ${e.fee}%` : null);
      add('순자산', e.totalNav);
      add('1개월 수익률', e.return1m !== undefined && e.return1m !== null ? pct(e.return1m) : null);
      add('3개월 수익률', e.return3m !== undefined && e.return3m !== null ? pct(e.return3m) : null);
      add('1년 수익률', e.return1y !== undefined && e.return1y !== null ? pct(e.return1y) : null);
      add('분배금 수익률', e.dividendYield ? e.dividendYield + '%' : (f.dividendYield ? f.dividendYield + '%' : null));
      add('52주 최고 / 최저', f.high52 ? `${money(f.high52)} / ${money(f.low52)}` : null);
      add('시가총액', f.marketValue);
    } else {
      $('fundTitle').textContent = '투자 지표';
      add('PER', x(f.per));
      add('추정 PER', x(f.cnsPer));
      add('PBR', x(f.pbr));
      add('EPS', f.eps !== null && f.eps !== undefined ? money(f.eps) : null);
      add('BPS', f.bps !== null && f.bps !== undefined ? money(f.bps) : null);
      add('배당수익률', f.dividendYield ? f.dividendYield + '%' : null);
      add('52주 최고 / 최저', f.high52 ? `${money(f.high52)} / ${money(f.low52)}` : null);
      add('시가총액', f.marketValue);
      add('평균 목표가', f.targetPrice ? `${money(f.targetPrice)} (${pct((f.targetPrice / d.quote.price - 1) * 100)})` : null);
      if (f.targetHigh) add('목표가 범위', `${money(f.targetLow)} ~ ${money(f.targetHigh)}`);
      add('투자의견 평균', f.recommMean ? `${f.recommMean.toFixed(2)} / 5` : null);
    }
    $('fund').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    $('fundCard').hidden = rows.length === 0;
    $('fundSrc').textContent = (d.sources || []).join(' · ');
    const notes = [];
    if (!e && f.per && f.cnsPer) notes.push(f.cnsPer < f.per ? `추정 PER(${f.cnsPer}배)이 현재 PER(${f.per}배)보다 낮아요. 애널리스트들은 앞으로 이익이 늘어날 것으로 보고 있어요.` : `추정 PER(${f.cnsPer}배)이 현재 PER(${f.per}배)보다 높아요. 애널리스트들은 이익이 줄어들 것으로 보고 있어요.`);
    if (!e && f.recommMean) notes.push('투자의견은 1(매도)~5(강력 매수) 사이 애널리스트 의견의 평균이에요.' + (f.consensusDate ? ` (${f.consensusDate} 기준)` : ''));
    if (e && !kr) notes.push('미국 ETF는 기준가(NAV)·괴리율 정보를 제공하지 않아요. 가격 통계로 판단해 주세요.');
    if (!e && !kr && !f.per) notes.push('이 종목은 PER 정보가 없어요(적자이거나 데이터 미제공).');
    $('fundNote').textContent = notes.join(' ');
  }

  /* ---------- 차트 ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  function niceTicks(lo, hi, count) {
    const span = hi - lo, raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  let lastChart = null;
  function drawChart(a) {
    lastChart = a;
    const box = $('chart');
    const W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return;
    const ser = a.series;
    const m = { l: 6, r: isKRW() ? 70 : 58, t: 10, b: 24 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    let lo = Infinity, hi = -Infinity;
    for (const p of ser) { lo = Math.min(lo, p.close, p.sma - 2 * p.sd); hi = Math.max(hi, p.close, p.sma + 2 * p.sd); }
    const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
    const X = (i) => m.l + (ser.length < 2 ? iw / 2 : (i / (ser.length - 1)) * iw);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${st.data.item.name} 종가와 ${a.n}거래일 이동평균, 표준편차 밴드` });

    const ax = svgEl('g', { class: 'axis' });
    for (const v of niceTicks(lo, hi, 5)) {
      ax.append(svgEl('line', { class: 'gridline', x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v) }));
      const t = svgEl('text', { x: m.l + iw + 8, y: Y(v) + 4 }); t.textContent = money(v, { bare: true }); ax.append(t);
    }
    // 월 눈금
    const months = [];
    ser.forEach((p, i) => { const ym = p.date.slice(0, 7); if (!months.length || months[months.length - 1].ym !== ym) months.push({ ym, i }); });
    const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(iw / 80))));
    months.forEach((mm, k) => {
      if (k === 0 || k % every) return;
      const t = svgEl('text', { x: X(mm.i), y: H - 6, 'text-anchor': 'middle' });
      t.textContent = mm.ym.slice(2).replace('-', '.'); ax.append(t);
    });
    svg.append(ax);

    const area = (k) => {
      const up = ser.map((p, i) => `${X(i)},${Y(p.sma + k * p.sd)}`);
      const dn = ser.map((p, i) => `${X(i)},${Y(p.sma - k * p.sd)}`).reverse();
      return 'M' + up.join('L') + 'L' + dn.join('L') + 'Z';
    };
    const line = (fn) => 'M' + ser.map((p, i) => `${X(i)},${Y(fn(p))}`).join('L');
    svg.append(svgEl('path', { d: area(2), fill: 'var(--band2)' }));
    svg.append(svgEl('path', { d: area(1), fill: 'var(--band1)' }));
    svg.append(svgEl('path', { d: line((p) => p.sma), fill: 'none', stroke: 'var(--sma)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
    svg.append(svgEl('path', { d: line((p) => p.close), fill: 'none', stroke: 'var(--line)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const last = ser[ser.length - 1];
    svg.append(svgEl('circle', { cx: X(ser.length - 1), cy: Y(last.close), r: 4.5, fill: 'var(--line)', stroke: 'var(--surface)', 'stroke-width': 2 }));

    const cross = svgEl('line', { class: 'cross', y1: m.t, y2: m.t + ih, x1: -10, x2: -10, visibility: 'hidden' });
    const dot = svgEl('circle', { r: 4.5, fill: 'var(--line)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    svg.append(cross, dot);
    const hit = svgEl('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
    svg.append(hit);
    const tip = $('tip');
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(ser.length - 1, Math.round(((px - m.l) / iw) * (ser.length - 1))));
      const p = ser[i];
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(p.close)); dot.setAttribute('visibility', 'visible');
      const row = (label, val, key) => el('div', { class: 'r' }, el('span', {}, key ? el('i', { class: 'lk ' + key }) : null, label), el('b', {}, val));
      tip.replaceChildren(
        el('div', { class: 'd' }, p.date),
        row('종가', money(p.close), 'price'),
        row(`${a.n}일 평균`, money(p.sma), 'sma'),
        row('−1σ ~ +1σ', `${money(p.sma - p.sd, { bare: true })} ~ ${money(p.sma + p.sd, { bare: true })}`, 'b1'),
        row('위치', `${p.z >= 0 ? '+' : ''}${p.z.toFixed(2)}σ · ${S.zone(p.z).label}`),
      );
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = ev.clientX + 14; if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
      let top = ev.clientY - th - 12; if (top < 8) top = ev.clientY + 16;
      tip.style.left = Math.max(8, left) + 'px'; tip.style.top = top + 'px';
    };
    const leave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
    box.replaceChildren(svg);
  }
  new ResizeObserver(() => { if (lastChart && !$('result').hidden) drawChart(lastChart); }).observe($('chart'));

  /* ---------- 검색 자동완성 ---------- */
  let sugItems = [], sugIdx = -1, sugTimer = null, sugReq = 0;
  function hideSuggest() { $('suggest').hidden = true; sugItems = []; sugIdx = -1; $('q').setAttribute('aria-expanded', 'false'); }
  function showSuggest(items) {
    sugItems = items; sugIdx = -1;
    const ul = $('suggest');
    if (!items.length) { hideSuggest(); return; }
    ul.replaceChildren(...items.map((it, i) => {
      const li = el('li', { role: 'option', 'data-i': i, 'aria-selected': 'false' },
        el('span', { class: 'code' }, it.code), el('span', {}, it.name),
        el('span', { class: 'mk' }, `${it.nation === 'KOR' ? '한국' : '미국'} · ${it.isEtf ? 'ETF' : it.market}`));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); load(it.code, it.nation); });
      return li;
    }));
    ul.hidden = false;
    $('q').setAttribute('aria-expanded', 'true');
  }
  function markSuggest() { [...$('suggest').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sugIdx))); }
  $('q').addEventListener('input', () => {
    clearTimeout(sugTimer);
    const q = $('q').value.trim();
    if (!q) { hideSuggest(); return; }
    sugTimer = setTimeout(async () => {
      const id = ++sugReq;
      try { const r = await api('/api/search?q=' + encodeURIComponent(q)); if (id === sugReq && $('q').value.trim() === q) showSuggest(r.items || []); } catch (e) { hideSuggest(); }
    }, 200);
  });
  $('q').addEventListener('keydown', (e) => {
    if ($('suggest').hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sugIdx = Math.min(sugItems.length - 1, sugIdx + 1); markSuggest(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sugIdx = Math.max(-1, sugIdx - 1); markSuggest(); }
    else if (e.key === 'Escape') hideSuggest();
  });
  $('q').addEventListener('blur', () => setTimeout(hideSuggest, 150));
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const it = sugItems[sugIdx];
    if (it) load(it.code, it.nation); else load($('q').value);
  });

  /* ---------- 최근 본 종목 ---------- */
  const RKEY = 'valuechecker.recent';
  const getRecent = () => { try { return JSON.parse(localStorage.getItem(RKEY)) || []; } catch (e) { return []; } };
  function setRecent(list) { try { localStorage.setItem(RKEY, JSON.stringify(list)); } catch (e) { /* 저장 불가 환경 */ } renderRecent(); }
  function addRecent(it) { setRecent([{ code: it.code, name: it.name, nation: it.nation }, ...getRecent().filter((r) => !(r.code === it.code && r.nation === it.nation))].slice(0, 10)); }
  function renderRecent() {
    $('recent').replaceChildren(...getRecent().map((r) => {
      const b = el('button', { type: 'button', title: `${r.name} 다시 보기` }, r.name, el('span', { class: 'x', title: '목록에서 지우기', 'data-x': '1' }, '×'));
      b.addEventListener('click', (e) => {
        if (e.target.dataset.x) { setRecent(getRecent().filter((x) => !(x.code === r.code && x.nation === r.nation))); return; }
        load(r.code, r.nation);
      });
      return b;
    }));
  }

  /* ---------- 이벤트 ---------- */
  $('examples').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) load(b.dataset.q, b.dataset.n); });
  $('period').addEventListener('change', (e) => { st.n = +e.target.value; try { localStorage.setItem('valuechecker.n', st.n); } catch (_) { /* 무시 */ } if (st.data) render(); });
  $('auto').addEventListener('change', schedule);
  $('refresh').addEventListener('click', () => refreshQuote(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('auto').checked && st.data) refreshQuote(false); });

  // 시작
  try { const n = +localStorage.getItem('valuechecker.n'); if ([60, 120, 250, 500].includes(n)) { st.n = n; $('period').value = String(n); } } catch (e) { /* 무시 */ }
  renderRecent();
  function loadFromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return;
    const us = /[.-]US$/.test(h), code = us ? h.slice(0, -3) : h;
    if (st.data && st.data.item.code === code) return;
    load(code, us ? 'USA' : 'KOR');
  }
  window.addEventListener('hashchange', loadFromHash);
  loadFromHash();
})();
