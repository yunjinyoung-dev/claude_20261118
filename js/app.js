/* 우리집 가계부 — 화면 로직 */
(() => {
  'use strict';

  const F = window.Formula;
  const X = window.MiniXlsx;
  const KEY = 'gagyebu.v1';
  const SHEET = '거래내역';
  const FX_SHEET = '수식';
  const HEAD = ['날짜', '구분', '분류', '내용', '금액', '결제수단', '메모'];
  const DEFAULTS = {
    expenseCats: ['식비', '카페/간식', '생활용품', '주거/관리비', '통신', '교통', '의료/건강', '교육', '문화/여가', '의류/미용', '경조사', '보험', '기타'],
    incomeCats: ['급여', '부수입', '용돈', '이자/배당', '기타'],
    methods: ['신용카드', '체크카드', '현금', '계좌이체'],
    budget: 0,
  };
  const WD = ['일', '월', '화', '수', '목', '금', '토'];

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtNum = (n) => (Number.isInteger(n) ? n.toLocaleString('ko-KR') : n.toLocaleString('ko-KR', { maximumFractionDigits: 4 }));
  const won = (n) => fmtNum(Math.round(n * 100) / 100) + '원';
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const ymOf = (iso) => iso.slice(0, 7);
  const ymParts = (ym) => ym.split('-').map(Number);
  const shiftYm = (ym, k) => { const [y, m] = ymParts(ym); const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const ymLabel = (ym) => { const [y, m] = ymParts(ym); return `${y}년 ${m}월`; };

  /* ---------- 저장 ----------
   * claude.ai 아티팩트에서 열면: 계정별 비공개 저장소(db)에 월별 문서로 저장 → 여러 기기에서 동기화
   * 그 밖의 환경(파일로 열기 등): 이 브라우저의 localStorage 에 저장 */
  function validTx(t) { return t && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && (t.type === '수입' || t.type === '지출') && typeof t.amount === 'number' && isFinite(t.amount); }
  function normalize(d) {
    d = d || {};
    const st = {
      tx: Array.isArray(d.tx) ? d.tx.filter(validTx) : [],
      formulas: Array.isArray(d.formulas) ? d.formulas.filter((f) => f && typeof f.f === 'string') : [],
      settings: Object.assign({}, DEFAULTS, d.settings || {}),
      seq: Number(d.seq) || 1,
    };
    st.seq = Math.max(st.seq, ...st.tx.map((t) => t.id + 1), ...st.formulas.map((f) => f.id + 1), 1);
    return st;
  }
  function loadLocal() {
    try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return normalize({}); }
  }
  function saveLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('저장하지 못했어요. 브라우저 저장공간을 확인해 주세요.'); }
  }

  // mode: 'pending'(연결 확인 중) | 'cloud' | 'local'
  const store = { mode: 'local', ready: true, db: null, col: null, synced: {}, flushing: false, dirty: false, timer: null, unsub: null, readOnly: false };
  const hasClaude = typeof window.claude === 'object' && window.claude && typeof window.claude.use === 'function';
  let state = hasClaude ? normalize({}) : loadLocal();
  if (hasClaude) { store.mode = 'pending'; store.ready = false; }
  const nextId = () => state.seq++;

  function setStatus(text, kind) {
    const el = $('saveStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'status ' + (kind || '');
  }
  function toDocs(st) {
    const docs = { meta: { settings: st.settings, formulas: st.formulas, seq: st.seq, v: 1 } };
    for (const t of st.tx) {
      const id = 'm-' + t.date.slice(0, 7);
      (docs[id] = docs[id] || { tx: [] }).tx.push(t);
    }
    return docs;
  }
  function fromDocs(docs) {
    const meta = docs.meta || {};
    const tx = [];
    Object.keys(docs).filter((k) => k.startsWith('m-')).forEach((k) => { if (Array.isArray(docs[k].tx)) tx.push(...docs[k].tx); });
    return normalize({ tx, formulas: meta.formulas, settings: meta.settings, seq: meta.seq });
  }
  function save() {
    if (store.mode === 'local') { saveLocal(); return; }
    if (store.mode !== 'cloud' || store.readOnly) return;
    store.dirty = true;
    setStatus('저장 중…', 'busy');
    clearTimeout(store.timer);
    store.timer = setTimeout(flush, 250);
  }
  async function flush() {
    if (store.flushing) return;
    store.flushing = true;
    try {
      while (store.dirty) {
        store.dirty = false;
        const docs = toDocs(state);
        const ids = new Set([...Object.keys(docs), ...Object.keys(store.synced)]);
        for (const id of ids) {
          const body = docs[id];
          const json = body ? JSON.stringify(body) : null;
          if (json === (store.synced[id] ?? null)) continue;
          if (body) await store.col.doc(id).set(body); else await store.col.doc(id).delete();
          if (json === null) delete store.synced[id]; else store.synced[id] = json;
        }
      }
      setStatus('계정에 저장됨', 'ok');
    } catch (e) {
      console.error(e);
      if (e && e.code === 'invalid_argument') { store.readOnly = true; setStatus('보기 전용', 'warn'); toast('이 가계부에 저장할 권한이 없어요. 소유자에게 편집 권한을 받아 주세요.'); }
      else if (e && e.code === 'quota_exceeded') { setStatus('저장 공간 부족', 'warn'); toast('저장 공간이 가득 찼어요. 오래된 내역을 엑셀로 내보낸 뒤 지워 주세요.'); }
      else { setStatus('저장 실패 · 다시 시도', 'warn'); store.dirty = true; setTimeout(flush, 3000 + Math.random() * 2000); }
    } finally {
      store.flushing = false;
    }
  }
  function goLocal(reason) {
    if (store.unsub) { store.unsub(); store.unsub = null; }
    store.mode = 'local'; store.ready = true;
    state = loadLocal();
    cache = null;
    setStatus('이 브라우저에만 저장', 'warn');
    if (reason) toast(reason);
    if (typeof render === 'function' && booted) { setType(view.type); fillSelect($('fMethod'), state.settings.methods); render(); }
  }
  async function connectCloud() {
    let db = null, user = null;
    try { [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]); } catch (e) { db = null; }
    const uid = user ? await user.id().catch(() => null) : null;
    if (!db || !uid) { goLocal(); return; }
    store.db = db;
    store.col = db.collection('data/users/' + uid);
    setStatus('불러오는 중…', 'busy');
    const slow = setTimeout(() => { if (!store.ready) setStatus('서버 응답을 기다리는 중…', 'warn'); }, 10000);
    store.unsub = store.col.onSnapshot((snap) => {
      if (snap.metadata.fromCache && !store.ready) return; // 확정된 데이터를 기다림
      clearTimeout(slow);
      if (store.dirty || store.flushing || snap.metadata.hasPendingWrites) return; // 내 변경이 더 최신
      const docs = {};
      snap.docs.forEach((d) => { const v = d.data(); if (v) docs[d.id] = JSON.parse(JSON.stringify(v)); });
      store.synced = {};
      Object.keys(docs).forEach((k) => { store.synced[k] = JSON.stringify(docs[k]); });
      const next = fromDocs(docs);
      const first = !store.ready;
      store.mode = 'cloud'; store.ready = true;
      if (first || JSON.stringify(toDocs(next)) !== JSON.stringify(toDocs(state))) {
        state = next; cache = null;
        if (first && view.editId) resetForm();
        setType(view.type); fillSelect($('fMethod'), state.settings.methods); render();
      }
      if (!store.readOnly) setStatus('계정에 저장됨', 'ok');
    }, (err) => {
      clearTimeout(slow);
      console.error(err);
      if (!store.ready) goLocal('계정 저장소에 연결하지 못해 이 브라우저에만 저장해요.');
      else setStatus('연결 끊김 · 새로고침 필요', 'warn');
    });
  }
  function ensureReady() {
    if (store.ready) return true;
    toast('가계부를 불러오는 중이에요. 잠시만요.');
    return false;
  }

  /* ---------- 거래내역 시트 (엑셀과 같은 행 순서: 날짜 오름차순) ---------- */
  let cache = null;
  function sheet() {
    if (!cache) {
      const rows = [...state.tx].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
      cache = { rows, rowOf: new Map(rows.map((t, i) => [t.id, i + 2])) };
    }
    return cache;
  }
  function sheetCtx() {
    const { rows } = sheet();
    return {
      getCell(sh, c, r) {
        if (sh !== null && sh !== SHEET) throw new F.XlError('#REF!');
        if (r === 1) return HEAD[c - 1] ?? null;
        const t = rows[r - 2];
        if (!t) return null;
        switch (c) {
          case 1: return F.isoToSerial(t.date);
          case 2: return t.type;
          case 3: return t.cat || null;
          case 4: return t.desc || null;
          case 5: return t.amount;
          case 6: return t.method || null;
          case 7: return t.memo || null;
        }
        return null;
      },
      maxRow: () => rows.length + 1,
    };
  }
  function commit() { cache = null; save(); render(); }

  /* ---------- 화면 상태 ---------- */
  const view = { ym: ymOf(todayIso()), all: false, q: '', type: '지출', editId: null, fxEditId: null };

  /* ---------- 금액 입력 ---------- */
  function parseAmount(raw) {
    const s = String(raw).trim();
    if (!s) return { error: '금액을 입력하세요' };
    if (s.startsWith('=')) {
      if (F.hasRefs(s)) return { error: '금액 수식에는 셀 참조를 쓸 수 없어요' };
      const r = F.evaluate(s, {});
      if (r.error) return { error: r.message || r.error };
      if (typeof r.value !== 'number') return { error: '결과가 숫자가 아니에요' };
      return { amount: Math.round(r.value * 100) / 100, formula: s };
    }
    const t = s.replace(/[\s,₩]|원$/g, '');
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(만|천)?$/.exec(t);
    if (!m) return { error: '숫자 또는 =수식을 입력하세요' };
    const n = parseFloat(m[1]) * (m[2] === '만' ? 10000 : m[2] === '천' ? 1000 : 1);
    return { amount: Math.round(n * 100) / 100, formula: null, unit: !!m[2] };
  }

  /* ---------- 렌더링 ---------- */
  function monthTx(ym) { return state.tx.filter((t) => t.date.startsWith(ym)); }
  const total = (list, type) => list.reduce((s, t) => s + (t.type === type ? t.amount : 0), 0);

  function render() {
    $('monthText').textContent = ymLabel(view.ym);
    $('monthPicker').value = view.ym;
    renderCards();
    renderTable();
    renderCats();
    renderFormulas();
    renderDescList();
  }

  function renderCards() {
    const cur = monthTx(view.ym), prev = monthTx(shiftYm(view.ym, -1));
    const inc = total(cur, '수입'), exp = total(cur, '지출'), bal = inc - exp;
    const pexp = total(prev, '지출');
    let diff = '';
    if (pexp > 0) { const p = Math.round(((exp - pexp) / pexp) * 100); diff = `전월 대비 ${p > 0 ? '+' : ''}${p}%`; }
    else diff = `${cur.filter((t) => t.type === '지출').length}건`;
    const budget = Number(state.settings.budget) || 0;
    let fourth;
    if (budget > 0) {
      const left = budget - exp, pct = Math.min(100, Math.round((exp / budget) * 100));
      const cls = exp > budget ? 'over' : pct >= 80 ? 'warn' : '';
      fourth = `<div class="card"><div class="label">예산 남은 금액</div><div class="value" style="${left < 0 ? 'color:var(--expense)' : ''}">${won(left)}</div>
        <div class="sub">예산 ${won(budget)} 중 ${Math.round((exp / budget) * 100)}% 사용</div><div class="meter ${cls}"><span style="width:${pct}%"></span></div></div>`;
    } else {
      const rate = inc > 0 ? Math.round((bal / inc) * 1000) / 10 : null;
      fourth = `<div class="card"><div class="label">저축률</div><div class="value">${rate === null ? '–' : rate + '%'}</div><div class="sub">설정에서 월 예산을 정할 수 있어요</div></div>`;
    }
    $('cards').innerHTML = `
      <div class="card income"><div class="label">수입</div><div class="value">${won(inc)}</div><div class="sub">${cur.filter((t) => t.type === '수입').length}건</div></div>
      <div class="card expense"><div class="label">지출</div><div class="value">${won(exp)}</div><div class="sub">${diff}</div></div>
      <div class="card"><div class="label">잔액 (수입 − 지출)</div><div class="value" style="color:${bal < 0 ? 'var(--expense)' : 'inherit'}">${won(bal)}</div><div class="sub">${ymLabel(view.ym)}</div></div>
      ${fourth}`;
  }

  function renderTable() {
    const { rows, rowOf } = sheet();
    let list = view.all ? rows : rows.filter((t) => t.date.startsWith(view.ym));
    const q = view.q.trim().toLowerCase();
    if (q) list = list.filter((t) => [t.desc, t.cat, t.memo, t.method, t.type, String(t.amount)].some((v) => (v || '').toLowerCase().includes(q)));
    list = [...list].reverse();
    $('txCount').textContent = list.length ? `${list.length}건` : '';
    $('emptyState').hidden = state.tx.length > 0;
    $('txTable').hidden = state.tx.length === 0;

    let html = '', day = null;
    const daySum = (d) => {
      const items = list.filter((t) => t.date === d);
      const i = total(items, '수입'), e = total(items, '지출');
      return (i ? `<span class="amt-in">+${fmtNum(i)}</span> ` : '') + (e ? `−${fmtNum(e)}` : '');
    };
    for (const t of list) {
      if (t.date !== day) {
        day = t.date;
        const [y, m, d] = day.split('-').map(Number);
        const wd = WD[new Date(y, m - 1, d).getDay()];
        html += `<tr class="day"><td colspan="9"><div class="day-in"><span>${view.all ? y + '년 ' : ''}${m}월 ${d}일 (${wd})</span><span>${daySum(day)}</span></div></td></tr>`;
      }
      const isIn = t.type === '수입';
      html += `<tr data-id="${t.id}"${view.editId === t.id ? ' class="sel"' : ''}>
        <td class="rn">${rowOf.get(t.id)}</td>
        <td class="dt">${t.date.slice(5)}</td>
        <td class="opt-m"><span class="tag ${isIn ? 'in' : 'out'}">${t.type}</span></td>
        <td>${escHtml(t.cat)}</td>
        <td class="desc">${escHtml(t.desc)}</td>
        <td class="num ${isIn ? 'amt-in' : 'amt-out'}">${isIn ? '+' : ''}${fmtNum(t.amount)}${t.formula ? `<span class="fxmark" title="${escHtml(t.formula)}">fx</span>` : ''}</td>
        <td class="opt">${escHtml(t.method)}</td>
        <td class="opt memo">${escHtml(t.memo)}</td>
        <td class="act"><button type="button" class="del" data-del="${t.id}" aria-label="삭제" title="삭제">×</button></td>
      </tr>`;
    }
    if (!list.length && state.tx.length) html = `<tr class="day"><td colspan="9" style="text-align:center;padding:24px">${q ? '검색 결과가 없어요' : '이 달에는 내역이 없어요'}</td></tr>`;
    $('txBody').innerHTML = html;
  }

  function renderCats() {
    const list = (view.all ? state.tx : monthTx(view.ym)).filter((t) => t.type === '지출');
    $('catPeriod').textContent = view.all ? '전체 기간' : ymLabel(view.ym);
    const by = new Map();
    list.forEach((t) => by.set(t.cat || '기타', (by.get(t.cat || '기타') || 0) + t.amount));
    const sum = [...by.values()].reduce((a, b) => a + b, 0);
    const items = [...by.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
    if (!items.length) { $('catBars').innerHTML = '<p class="muted small">지출 내역이 없어요.</p>'; return; }
    const max = Math.max(...items.map(([, v]) => Math.abs(v)));
    $('catBars').innerHTML = items.map(([k, v]) => `
      <div class="bar-row"><span>${escHtml(k)}</span><span class="amt">${won(v)}<span class="pct">${sum ? Math.round((v / sum) * 100) : 0}%</span></span>
      <div class="track"><span style="width:${Math.max(2, (Math.abs(v) / max) * 100)}%"></span></div></div>`).join('');
  }

  function renderDescList() {
    const seen = new Set(), opts = [];
    for (let i = state.tx.length - 1; i >= 0 && opts.length < 300; i--) {
      const d = state.tx[i].desc;
      if (d && !seen.has(d)) { seen.add(d); opts.push(`<option value="${escHtml(d)}">`); }
    }
    $('descList').innerHTML = opts.join('');
  }

  /* ---------- 수식 ---------- */
  function fmtVal(v) {
    if (typeof v === 'number') return fmtNum(Math.round(v * 10000) / 10000);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }
  function evalFx(src) { return F.evaluate(src, sheetCtx()); }
  function looksDate(src, v) { return typeof v === 'number' && v > 20000 && v < 80000 && /\b(DATE|TODAY|EDATE|EOMONTH)\s*\(/i.test(src) && !/\b(SUM|COUNT|AVERAGE)/i.test(src); }

  function showFxResult() {
    const src = $('fxInput').value.trim();
    const box = $('fxResult');
    if (!src) { box.innerHTML = '<span class="msg">수식을 입력하면 바로 계산됩니다.</span>'; return; }
    const r = evalFx(src.startsWith('=') ? src : '=' + src);
    if (r.error) box.innerHTML = `<span class="err">${escHtml(r.error)}</span>${r.message ? `<span class="msg">${escHtml(r.message)}</span>` : errHelp(r.error)}`;
    else box.innerHTML = escHtml(fmtVal(r.value)) + (looksDate(src, r.value) ? `<span class="msg">날짜로 보면 ${F.serialToIso(r.value)}</span>` : '');
  }
  function errHelp(code) {
    const m = { '#NAME?': '지원하지 않는 함수 이름이에요. 아래 함수 목록을 확인하세요.', '#VALUE!': '값의 종류가 맞지 않거나 범위 크기가 서로 달라요.', '#DIV/0!': '0으로 나누었어요.', '#REF!': `참조할 수 없는 시트예요. ${SHEET} 시트만 쓸 수 있어요.`, '#NUM!': '계산할 수 없는 숫자예요.', '#N/A': '해당하는 값이 없어요.' };
    return m[code] ? `<span class="msg">${m[code]}</span>` : '';
  }

  function examples() {
    const [y, m] = ymParts(view.ym);
    const d0 = `DATE(${y},${m},1)`;
    const month = `A:A,">="&${d0},A:A,"<"&EDATE(${d0},1)`;
    return [
      [`${m}월 지출`, `=SUMIFS(E:E,B:B,"지출",${month})`],
      [`${m}월 식비`, `=SUMIFS(E:E,B:B,"지출",C:C,"식비",${month})`],
      [`${m}월 하루 평균 지출`, `=ROUND(SUMIFS(E:E,B:B,"지출",${month})/DAY(EOMONTH(${d0},0)),0)`],
      ['전체 수입 합계', '=SUMIF(B:B,"수입",E:E)'],
      ['지출 건수', '=COUNTIF(B:B,"지출")'],
      ['가장 큰 지출', '=MAXIFS(E:E,B:B,"지출")'],
      ['카드 사용액', '=SUMIFS(E:E,B:B,"지출",F:F,"*카드")'],
      ['1만원 이상 지출 건수', '=COUNTIFS(B:B,"지출",E:E,">=10000")'],
    ];
  }

  function renderFormulas() {
    $('fxExamples').innerHTML = examples().map(([n, f], i) => `<button type="button" class="chip" data-ex="${i}" title="${escHtml(f)}">${escHtml(n)}</button>`).join('');
    $('fxSaved').innerHTML = state.formulas.map((x) => {
      const r = evalFx(x.f);
      const val = r.error ? `<span class="val err">${escHtml(r.error)}</span>` : `<span class="val">${escHtml(fmtVal(r.value))}</span>`;
      return `<li data-fx="${x.id}"><span class="nm">${escHtml(x.name)}</span>${val}
        <span class="src" title="수식 입력줄로 불러오기">${escHtml(x.f)}</span>
        <span class="ops"><button type="button" data-fxedit="${x.id}">수정</button><button type="button" data-fxdel="${x.id}">삭제</button></span></li>`;
    }).join('');
    showFxResult();
  }

  function insertAtCursor(input, text) {
    let v = input.value;
    if (!v.trim()) { input.value = '=' + text; input.setSelectionRange(input.value.length, input.value.length); }
    else {
      const a = input.selectionStart ?? v.length, b = input.selectionEnd ?? v.length;
      input.value = v.slice(0, a) + text + v.slice(b);
      input.setSelectionRange(a + text.length, a + text.length);
    }
    input.focus();
    showFxResult();
  }

  function saveFormula() {
    if (!ensureReady()) return;
    let src = $('fxInput').value.trim();
    if (!src) { $('fxInput').focus(); return; }
    if (!src.startsWith('=')) src = '=' + src;
    const r = evalFx(src);
    if (r.error === '#ERROR!') { toast('수식에 문법 오류가 있어요: ' + (r.message || '')); return; }
    const name = $('fxName').value.trim() || src.slice(1, 30);
    const ex = state.formulas.find((x) => x.id === view.fxEditId);
    if (ex) { ex.name = name; ex.f = src; }
    else state.formulas.push({ id: nextId(), name, f: src });
    view.fxEditId = null;
    $('fxName').value = '';
    $('fxSave').textContent = '저장';
    commit();
    toast('수식을 저장했어요. 엑셀로 내보내면 「수식」 시트에 그대로 들어갑니다.');
  }

  /* ---------- 입력 폼 ---------- */
  function catsFor(type) { return type === '수입' ? state.settings.incomeCats : state.settings.expenseCats; }
  function fillSelect(sel, list, keep) {
    const cur = keep ?? sel.value;
    const opts = [...list];
    if (cur && !opts.includes(cur)) opts.push(cur);
    sel.innerHTML = opts.map((c) => `<option>${escHtml(c)}</option>`).join('');
    if (cur && opts.includes(cur)) sel.value = cur;
  }
  function setType(type, keepCat) {
    view.type = type;
    document.querySelectorAll('.seg-btn').forEach((b) => { const on = b.dataset.type === type; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    fillSelect($('fCat'), catsFor(type), keepCat ?? (catsFor(type).includes($('fCat').value) ? $('fCat').value : catsFor(type)[0]));
  }
  function updateAmtPreview() {
    const v = $('fAmount').value.trim();
    const el = $('amtPreview');
    el.className = 'hint';
    if (!v || (!v.startsWith('=') && !/[만천]/.test(v))) { el.textContent = ''; return; }
    const r = parseAmount(v);
    if (r.error) { el.textContent = '· ' + r.error; el.classList.add('err'); }
    else el.textContent = '= ' + won(r.amount);
  }
  function resetForm(keepDate) {
    view.editId = null;
    $('fDesc').value = ''; $('fAmount').value = ''; $('fMemo').value = '';
    if (!keepDate) $('fDate').value = todayIso();
    $('btnSubmit').textContent = '추가';
    $('btnCancelEdit').hidden = true;
    document.querySelector('.entry').classList.remove('editing');
    updateAmtPreview();
  }
  function startEdit(id) {
    const t = state.tx.find((x) => x.id === id);
    if (!t) return;
    view.editId = id;
    setType(t.type, t.cat);
    $('fDate').value = t.date;
    $('fDesc').value = t.desc || '';
    $('fAmount').value = t.formula || String(t.amount);
    fillSelect($('fMethod'), state.settings.methods, t.method || state.settings.methods[0]);
    $('fMemo').value = t.memo || '';
    $('btnSubmit').textContent = '수정 저장';
    $('btnCancelEdit').hidden = false;
    document.querySelector('.entry').classList.add('editing');
    updateAmtPreview();
    renderTable();
    document.querySelector('.entry').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('fAmount').focus();
  }
  function submitEntry(e) {
    e.preventDefault();
    if (!ensureReady()) return;
    const date = $('fDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('날짜를 입력하세요'); $('fDate').focus(); return; }
    const a = parseAmount($('fAmount').value);
    if (a.error) { toast(a.error); $('fAmount').focus(); return; }
    const rec = {
      date, type: view.type, cat: $('fCat').value, desc: $('fDesc').value.trim(),
      amount: a.amount, formula: a.formula, method: $('fMethod').value, memo: $('fMemo').value.trim(),
    };
    if (view.editId) {
      Object.assign(state.tx.find((t) => t.id === view.editId), rec);
      toast('수정했어요');
    } else {
      state.tx.push({ id: nextId(), ...rec });
      toast(`${rec.type} ${won(rec.amount)} 추가했어요`);
    }
    if (!view.all && ymOf(date) !== view.ym) view.ym = ymOf(date);
    resetForm(true);
    commit();
    $('fDesc').focus();
  }
  function autofillFromDesc() {
    if (view.editId) return;
    const d = $('fDesc').value.trim();
    if (!d) return;
    for (let i = state.tx.length - 1; i >= 0; i--) {
      const t = state.tx[i];
      if (t.desc === d) {
        if (t.type !== view.type) setType(t.type, t.cat); else if (catsFor(t.type).includes(t.cat)) $('fCat').value = t.cat;
        if (t.method && state.settings.methods.includes(t.method)) $('fMethod').value = t.method;
        return;
      }
    }
  }

  /* ---------- 대화상자 ---------- */
  function choose(title, text, options) {
    return new Promise((resolve) => {
      const d = $('choiceDlg');
      $('choiceTitle').textContent = title;
      $('choiceText').textContent = text;
      $('choiceActions').innerHTML = options.map((o) => `<button value="${escHtml(o.value)}" class="btn ${o.cls || ''}">${escHtml(o.label)}</button>`).join('');
      d.returnValue = '';
      d.addEventListener('close', () => resolve(d.returnValue || null), { once: true });
      d.showModal();
    });
  }
  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ---------- 설정 ---------- */
  const lines = (s) => [...new Set(s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
  function openSettings() {
    const s = state.settings;
    $('sBudget').value = s.budget ? fmtNum(s.budget) : '';
    $('sExpense').value = s.expenseCats.join('\n');
    $('sIncome').value = s.incomeCats.join('\n');
    $('sMethods').value = s.methods.join('\n');
    $('settingsDlg').returnValue = '';
    $('settingsDlg').showModal();
  }
  function closeSettings() {
    if ($('settingsDlg').returnValue !== 'save' || !ensureReady()) return;
    const b = parseAmount($('sBudget').value || '0');
    state.settings = {
      budget: b.error ? 0 : Math.max(0, b.amount),
      expenseCats: lines($('sExpense').value).length ? lines($('sExpense').value) : DEFAULTS.expenseCats,
      incomeCats: lines($('sIncome').value).length ? lines($('sIncome').value) : DEFAULTS.incomeCats,
      methods: lines($('sMethods').value).length ? lines($('sMethods').value) : DEFAULTS.methods,
    };
    setType(view.type);
    fillSelect($('fMethod'), state.settings.methods);
    commit();
    toast('설정을 저장했어요');
  }
  async function resetAll() {
    if (!ensureReady()) return;
    $('settingsDlg').close('');
    const ok = await choose('모든 데이터 삭제', `거래내역 ${state.tx.length}건과 저장한 수식, 설정이 모두 지워집니다. 먼저 엑셀로 내보내 두는 것을 권장해요.`,
      [{ value: '', label: '취소', cls: 'ghost' }, { value: 'yes', label: '모두 삭제', cls: 'danger' }]);
    if (ok !== 'yes') return;
    state = { tx: [], formulas: [], settings: { ...DEFAULTS }, seq: 1 };
    resetForm();
    setType('지출');
    fillSelect($('fMethod'), state.settings.methods);
    commit();
    toast('모든 데이터를 삭제했어요');
  }

  /* ---------- 내보내기 ---------- */
  async function download(blob, name) {
    const dl = hasClaude ? await window.claude.use('downloads').catch(() => null) : null;
    if (dl) {
      try { await dl.save({ filename: name, data: blob }); return true; }
      catch (e) {
        if (e && e.code === 'declined') return false;
        if (e && e.code === 'rate_limited') { toast('저장 창이 이미 열려 있어요. 잠시 후 다시 눌러 주세요.'); return false; }
        toast('이 화면에서는 파일을 저장할 수 없어요.');
        return false;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  }
  const stamp = () => todayIso().replace(/-/g, '');

  function buildWorkbook() {
    const { rows } = sheet();
    const Q = `'${SHEET}'!`;
    const sheets = [];

    // 1) 거래내역
    const txRows = [HEAD.map((h) => ({ v: h, s: 'head' }))];
    rows.forEach((t) => {
      let amt = { v: t.amount, s: 'money' };
      if (t.formula) { try { amt.f = F.toExcel(t.formula, null); } catch (e) { /* 숫자만 저장 */ } }
      txRows.push([{ v: F.isoToSerial(t.date), s: 'date' }, t.type, t.cat || null, t.desc || null, amt, t.method || null, t.memo || null]);
    });
    sheets.push({ name: SHEET, rows: txRows, cols: [12, 7, 13, 28, 13, 11, 26], autoFilter: true, freeze: true });

    // 2) 월별요약
    const months = [...new Set(rows.map((t) => ymOf(t.date)))].sort();
    const sumOf = (ym, type, cat) => rows.reduce((s, t) => s + (t.type === type && t.date.startsWith(ym) && (cat === undefined || (t.cat || '') === cat) ? t.amount : 0), 0);
    const cond = (r) => `${Q}$A:$A,">="&$A${r},${Q}$A:$A,"<"&EDATE($A${r},1)`;
    const mRows = [['월', '수입', '지출', '잔액', '저축률'].map((h) => ({ v: h, s: 'head' }))];
    let ti = 0, te = 0;
    months.forEach((ym, i) => {
      const r = i + 2, [y, m] = ymParts(ym), inc = sumOf(ym, '수입'), exp = sumOf(ym, '지출');
      ti += inc; te += exp;
      mRows.push([
        { v: F.dateToSerial(y, m, 1), s: 'month' },
        { v: inc, f: `SUMIFS(${Q}$E:$E,${Q}$B:$B,"수입",${cond(r)})`, s: 'money' },
        { v: exp, f: `SUMIFS(${Q}$E:$E,${Q}$B:$B,"지출",${cond(r)})`, s: 'money' },
        { v: inc - exp, f: `B${r}-C${r}`, s: 'money' },
        { v: inc ? (inc - exp) / inc : 0, f: `IF(B${r}=0,0,D${r}/B${r})`, s: 'pct' },
      ]);
    });
    if (months.length) {
      const r = months.length + 2, last = months.length + 1;
      mRows.push([{ v: '합계', s: 'bold' },
        { v: ti, f: `SUM(B2:B${last})`, s: 'moneyBold' }, { v: te, f: `SUM(C2:C${last})`, s: 'moneyBold' },
        { v: ti - te, f: `B${r}-C${r}`, s: 'moneyBold' }, { v: ti ? (ti - te) / ti : 0, f: `IF(B${r}=0,0,D${r}/B${r})`, s: 'pct' }]);
    }
    sheets.push({ name: '월별요약', rows: mRows, cols: [10, 14, 14, 14, 9], freeze: true });

    // 3) 분류별지출 (분류 × 월)
    const used = new Set(rows.filter((t) => t.type === '지출').map((t) => t.cat || ''));
    const cats = [...state.settings.expenseCats.filter((c) => used.has(c)), ...[...used].filter((c) => c && !state.settings.expenseCats.includes(c))];
    const cRows = [[{ v: '분류', s: 'head' }, ...months.map((ym) => { const [y, m] = ymParts(ym); return { v: F.dateToSerial(y, m, 1), s: 'monthHead' }; }), { v: '합계', s: 'head' }]];
    const lastCol = F.numToCol(months.length + 1);
    cats.forEach((cat, i) => {
      const r = i + 2;
      const row = [cat];
      let rowSum = 0;
      months.forEach((ym, j) => {
        const col = F.numToCol(j + 2), v = sumOf(ym, '지출', cat);
        rowSum += v;
        row.push({ v, s: 'money', f: `SUMIFS(${Q}$E:$E,${Q}$B:$B,"지출",${Q}$C:$C,$A${r},${Q}$A:$A,">="&${col}$1,${Q}$A:$A,"<"&EDATE(${col}$1,1))` });
      });
      row.push({ v: rowSum, s: 'moneyBold', f: months.length ? `SUM(B${r}:${lastCol}${r})` : '0' });
      cRows.push(row);
    });
    if (cats.length) {
      const r = cats.length + 2;
      const tr = [{ v: '합계', s: 'bold' }];
      for (let j = 0; j <= months.length; j++) {
        const col = F.numToCol(j + 2);
        const v = cRows.slice(1).reduce((s, row) => s + row[j + 1].v, 0);
        tr.push({ v, s: 'moneyBold', f: `SUM(${col}2:${col}${r - 1})` });
      }
      cRows.push(tr);
    }
    sheets.push({ name: '분류별지출', rows: cRows, cols: [14, ...months.map(() => 12), 14], freeze: true });

    // 4) 수식 (앱에서 저장한 수식)
    if (state.formulas.length) {
      const fRows = [['이름', '수식', '결과'].map((h) => ({ v: h, s: 'head' }))];
      state.formulas.forEach((x) => {
        const r = evalFx(x.f);
        const cell = { v: r.error ? null : r.value, s: typeof r.value === 'number' ? 'money' : undefined };
        if (r.error && r.error !== '#ERROR!') cell.error = r.error;
        try { cell.f = F.toExcel(x.f, SHEET); } catch (e) { cell.v = r.error || ''; }
        fRows.push([x.name, x.f, cell]);
      });
      sheets.push({ name: FX_SHEET, rows: fRows, cols: [22, 60, 16] });
    }
    return sheets;
  }

  async function exportXlsx() {
    try {
      const blob = await X.writeXlsx(buildWorkbook());
      if (await download(blob, `가계부_${stamp()}.xlsx`)) toast('엑셀 파일을 저장했어요');
    } catch (e) {
      console.error(e);
      toast('내보내기 실패: ' + e.message);
    }
  }
  async function exportCsv() {
    const { rows } = sheet();
    const data = [HEAD, ...rows.map((t) => [t.date, t.type, t.cat, t.desc, t.amount, t.method, t.memo])];
    if (await download(new Blob([X.toCsv(data)], { type: 'text/csv;charset=utf-8' }), `가계부_거래내역_${stamp()}.csv`)) toast('CSV 파일을 저장했어요');
  }

  /* ---------- 가져오기 ---------- */
  const ALIASES = {
    date: ['날짜', '일자', '거래일', '거래일자', '거래일시', '사용일', '사용일자', '이용일', '이용일자', 'date'],
    type: ['구분', '유형', '수입/지출', '수입지출', '종류', 'type'],
    cat: ['분류', '카테고리', '항목분류', '대분류', 'category'],
    desc: ['내용', '항목', '적요', '사용처', '내역', '가맹점', '가맹점명', '이용가맹점', '사용내역', 'description', '설명'],
    amount: ['금액', '사용금액', '거래금액', '이용금액', 'amount'],
    income: ['수입', '수입금액', '입금', '입금액'],
    expense: ['지출', '지출금액', '출금', '출금액'],
    method: ['결제수단', '결제방법', '수단', '결제', '카드', 'payment'],
    memo: ['메모', '비고', 'memo', 'note'],
  };
  const norm = (s) => String(s ?? '').replace(/\s/g, '').toLowerCase();
  function findHeader(rows) {
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const map = {};
      (rows[r] || []).forEach((c, i) => {
        if (!c || typeof c.v !== 'string') return;
        const h = norm(c.v);
        for (const [k, names] of Object.entries(ALIASES)) if (map[k] === undefined && names.includes(h)) { map[k] = i; break; }
      });
      if (map.date !== undefined && (map.amount !== undefined || map.income !== undefined || map.expense !== undefined)) return { r, map };
    }
    return null;
  }
  function toIso(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') {
      if (v >= 19000101 && v <= 21001231 && Number.isInteger(v)) { const s = String(v); return check(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8)); }
      if (v > 1 && v < 110000) return F.serialToIso(v);
      return null;
    }
    const s = String(v).trim();
    let m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/.exec(s);
    if (m) return check(+m[1], +m[2], +m[3]);
    m = /^(\d{2})[-./](\d{1,2})[-./](\d{1,2})$/.exec(s);
    if (m) return check(2000 + +m[1], +m[2], +m[3]);
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) return check(+m[1], +m[2], +m[3]);
    return null;
    function check(y, mo, d) {
      const dt = new Date(y, mo - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
    }
  }
  function numOf(c) {
    if (!c) return null;
    if (typeof c.v === 'number') return c.v;
    if (typeof c.v === 'string') { const r = parseAmount(c.v.replace(/^\((.*)\)$/, '-$1')); return r.error ? null : r.amount; }
    return null;
  }
  function amountFormula(c) {
    if (!c || !c.f) return null;
    try { return F.hasRefs(c.f) ? null : F.fromExcel(c.f, null); } catch (e) { return null; }
  }
  function parseTxRows(rows) {
    const h = findHeader(rows);
    if (!h) return { items: [], skipped: 0, found: false };
    const { map } = h;
    const items = [];
    let skipped = 0;
    const str = (row, k) => { if (map[k] === undefined) return ''; const c = row[map[k]]; return c && c.v !== null && c.v !== undefined ? String(c.v).trim() : ''; };
    for (let r = h.r + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (!row.some((c) => c && c.v !== null && c.v !== '')) continue;
      const date = toIso(row[map.date] && row[map.date].v);
      if (!date) { skipped++; continue; }
      const base = { date, cat: str(row, 'cat'), desc: str(row, 'desc'), method: str(row, 'method'), memo: str(row, 'memo') };
      if (map.amount !== undefined) {
        let amount = numOf(row[map.amount]);
        if (amount === null) { skipped++; continue; }
        const tv = str(row, 'type');
        let type = /수입|입금|income/i.test(tv) ? '수입' : /지출|출금|expense/i.test(tv) ? '지출' : null;
        if (!type) { type = '지출'; if (amount < 0 && map.type === undefined) amount = -amount; }
        items.push({ ...base, type, amount, formula: amountFormula(row[map.amount]) });
      } else {
        const inc = numOf(row[map.income]), exp = numOf(row[map.expense]);
        let any = false;
        if (inc) { items.push({ ...base, type: '수입', amount: inc, formula: amountFormula(row[map.income]) }); any = true; }
        if (exp) { items.push({ ...base, type: '지출', amount: exp, formula: amountFormula(row[map.expense]) }); any = true; }
        if (!any) skipped++;
      }
    }
    items.forEach((t) => { if (!t.cat) t.cat = '기타'; });
    return { items, skipped, found: true };
  }
  function parseFormulaSheet(rows) {
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const name = row[0] && row[0].v != null ? String(row[0].v) : '';
      let f = null;
      if (row[2] && row[2].f) { try { f = F.fromExcel(row[2].f, SHEET); } catch (e) { f = null; } }
      if (!f && row[1] && typeof row[1].v === 'string' && row[1].v.trim().startsWith('=')) f = row[1].v.trim();
      if (f) out.push({ name: name || f.slice(1, 30), f });
    }
    return out;
  }
  const txKey = (t) => [t.date, t.type, t.cat, t.desc, t.amount, t.method, t.memo].join('\u0001');

  async function importFile(file) {
    if (!ensureReady()) return;
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const name = file.name.toLowerCase();
    let sheets;
    if (u8[0] === 0x50 && u8[1] === 0x4b) sheets = await X.readXlsx(buf);
    else if (name.endsWith('.xls') || (u8[0] === 0xd0 && u8[1] === 0xcf)) throw new Error('구형 엑셀(.xls)은 지원하지 않아요. 엑셀에서 "다른 이름으로 저장 → Excel 통합 문서(.xlsx)"로 바꿔 주세요.');
    else sheets = [{ name: SHEET, rows: X.parseCsv(X.decodeText(buf)) }];

    const ordered = [...sheets.filter((s) => s.name === SHEET), ...sheets.filter((s) => s.name !== SHEET && s.name !== FX_SHEET)];
    let parsed = { items: [], skipped: 0, found: false };
    for (const s of ordered) { const p = parseTxRows(s.rows); if (p.found) { parsed = p; break; } }
    const fxSheet = sheets.find((s) => s.name === FX_SHEET);
    const formulas = fxSheet ? parseFormulaSheet(fxSheet.rows) : [];
    if (!parsed.items.length && !formulas.length) {
      throw new Error(parsed.found ? '가져올 수 있는 행이 없어요. 날짜·금액 형식을 확인해 주세요.' : '머리글을 찾지 못했어요. 첫 행에 「날짜」와 「금액」(또는 「수입」/「지출」) 열이 있어야 해요.');
    }

    let mode = 'replace';
    if (state.tx.length || state.formulas.length) {
      mode = await choose('엑셀 가져오기', `파일에서 내역 ${parsed.items.length}건${formulas.length ? `, 수식 ${formulas.length}개` : ''}를 찾았어요. 지금 있는 내역 ${state.tx.length}건은 어떻게 할까요?`, [
        { value: '', label: '취소', cls: 'ghost' },
        { value: 'replace', label: '파일 내용으로 바꾸기' },
        { value: 'add', label: '기존 내역에 추가', cls: 'primary' },
      ]);
      if (!mode) return;
    }
    let added = 0, dup = 0;
    if (mode === 'replace') {
      state.tx = parsed.items.map((t) => ({ id: nextId(), ...t }));
      added = parsed.items.length;
      if (formulas.length) state.formulas = formulas.map((x) => ({ id: nextId(), ...x }));
    } else {
      const keys = new Set(state.tx.map(txKey));
      for (const t of parsed.items) {
        if (keys.has(txKey(t))) { dup++; continue; }
        state.tx.push({ id: nextId(), ...t }); keys.add(txKey(t)); added++;
      }
      const have = new Set(state.formulas.map((x) => x.f));
      formulas.forEach((x) => { if (!have.has(x.f)) state.formulas.push({ id: nextId(), ...x }); });
    }
    // 처음 보는 분류·결제수단은 설정에 추가
    const s = state.settings;
    state.tx.forEach((t) => {
      const list = t.type === '수입' ? s.incomeCats : s.expenseCats;
      if (t.cat && !list.includes(t.cat)) list.push(t.cat);
      if (t.method && !s.methods.includes(t.method)) s.methods.push(t.method);
    });
    if (added) { const last = [...parsed.items].sort((a, b) => (a.date < b.date ? 1 : -1))[0]; if (last) view.ym = ymOf(last.date); }
    setType(view.type);
    fillSelect($('fMethod'), s.methods);
    commit();
    toast(`${added}건 가져왔어요` + (dup ? ` · 중복 ${dup}건 제외` : '') + (parsed.skipped ? ` · 읽지 못한 행 ${parsed.skipped}건` : ''));
  }

  /* ---------- 예시 데이터 ---------- */
  function loadSample() {
    if (!ensureReady()) return;
    const cur = ymOf(todayIso()), prev = shiftYm(cur, -1);
    const today = new Date().getDate();
    const mk = (ym, d, type, cat, desc, amount, method, memo = '', formula = null) => ({ id: nextId(), date: `${ym}-${pad(d)}`, type, cat, desc, amount, method, memo, formula });
    const month = (ym, maxDay) => [
      [1, '수입', '급여', '월급', 3200000, '계좌이체'],
      [2, '지출', '주거/관리비', '관리비', 185000, '계좌이체'],
      [3, '지출', '식비', '마트 장보기', 87400, '신용카드'],
      [5, '지출', '카페/간식', '커피', 13500, '체크카드', '3잔', '=4500*3'],
      [6, '지출', '통신', '휴대폰 요금', 62000, '신용카드'],
      [8, '지출', '교통', '교통카드 충전', 50000, '체크카드'],
      [10, '지출', '식비', '외식 (가족)', 64000, '신용카드'],
      [12, '지출', '생활용품', '세제·휴지', 23800, '신용카드'],
      [14, '지출', '의료/건강', '약국', 8500, '현금'],
      [15, '수입', '부수입', '중고거래', 35000, '계좌이체'],
      [17, '지출', '식비', '마트 장보기', 92300, '신용카드'],
      [20, '지출', '문화/여가', '영화', 28000, '신용카드'],
      [22, '지출', '교육', '아이 학원비', 250000, '계좌이체'],
      [25, '지출', '보험', '실손보험', 45000, '계좌이체'],
      [27, '지출', '식비', '배달 치킨', 23000, '신용카드'],
    ].filter((x) => x[0] <= maxDay).map((x) => mk(ym, x[0], x[1], x[2], x[3], x[4], x[5], x[6] || '', x[7] || null));
    state.tx.push(...month(prev, 31), ...month(cur, Math.max(today, 1)));
    if (!state.formulas.length) {
      state.formulas.push(
        { id: nextId(), name: '전체 식비', f: '=SUMIFS(E:E,B:B,"지출",C:C,"식비")' },
        { id: nextId(), name: '지출 평균 (1건당)', f: '=ROUND(AVERAGEIF(B:B,"지출",E:E),0)' },
      );
    }
    view.ym = cur;
    commit();
    toast('예시 데이터를 넣었어요. 설정 → 모든 데이터 삭제로 지울 수 있어요.');
  }

  /* ---------- 이벤트 ---------- */
  function bind() {
    $('prevMonth').onclick = () => { view.ym = shiftYm(view.ym, -1); render(); };
    $('nextMonth').onclick = () => { view.ym = shiftYm(view.ym, 1); render(); };
    $('thisMonth').onclick = () => { view.ym = ymOf(todayIso()); render(); };
    $('monthPicker').onchange = (e) => { if (e.target.value) { view.ym = e.target.value; render(); } };

    document.querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => setType(b.dataset.type)));
    $('entryForm').onsubmit = submitEntry;
    $('btnCancelEdit').onclick = () => { resetForm(); renderTable(); };
    $('entryForm').addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.editId) { resetForm(); renderTable(); } });
    $('fAmount').oninput = updateAmtPreview;
    $('fDesc').addEventListener('change', autofillFromDesc);

    $('txBody').onclick = async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        if (!ensureReady()) return;
        const id = +del.dataset.del;
        const t = state.tx.find((x) => x.id === id);
        const ok = await choose('내역 삭제', `${t.date} ${t.desc || t.cat} ${won(t.amount)} 내역을 삭제할까요?`, [{ value: '', label: '취소', cls: 'ghost' }, { value: 'yes', label: '삭제', cls: 'danger' }]);
        if (ok === 'yes') { state.tx = state.tx.filter((x) => x.id !== id); if (view.editId === id) resetForm(); commit(); toast('삭제했어요'); }
        return;
      }
      const tr = e.target.closest('tr[data-id]');
      if (tr) startEdit(+tr.dataset.id);
    };
    $('search').oninput = (e) => { view.q = e.target.value; renderTable(); };
    $('showAll').onchange = (e) => { view.all = e.target.checked; renderTable(); renderCats(); };
    $('btnSample').onclick = loadSample;

    $('fxInput').oninput = showFxResult;
    $('fxInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if ($('fxName').value.trim() || view.fxEditId) saveFormula(); else $('fxName').focus(); } };
    $('fxName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveFormula(); } };
    $('fxSave').onclick = saveFormula;
    $('fxExamples').onclick = (e) => {
      const b = e.target.closest('[data-ex]');
      if (!b) return;
      const [n, f] = examples()[+b.dataset.ex];
      $('fxInput').value = f; $('fxName').value = n;
      showFxResult();
    };
    $('fxSaved').onclick = (e) => {
      const li = e.target.closest('[data-fx]');
      if (!li) return;
      const x = state.formulas.find((f) => f.id === +li.dataset.fx);
      if (e.target.closest('[data-fxdel]')) {
        if (!ensureReady()) return;
        state.formulas = state.formulas.filter((f) => f !== x);
        if (view.fxEditId === x.id) { view.fxEditId = null; $('fxSave').textContent = '저장'; }
        commit();
        return;
      }
      $('fxInput').value = x.f;
      if (e.target.closest('[data-fxedit]')) { view.fxEditId = x.id; $('fxName').value = x.name; $('fxSave').textContent = '수정'; $('fxInput').focus(); }
      showFxResult();
    };
    $('fnList').innerHTML = F.DOCS.map(([n, sig, d]) => `<dt data-fn="${n}" title="${escHtml(sig)}">${n}</dt><dd>${escHtml(d)} <code>${escHtml(sig)}</code></dd>`).join('');
    $('fnList').onclick = (e) => { const dt = e.target.closest('[data-fn]'); if (dt) insertAtCursor($('fxInput'), dt.dataset.fn + '('); };

    $('btnExport').onclick = exportXlsx;
    $('btnCsv').onclick = exportCsv;
    $('btnImport').onclick = () => $('fileInput').click();
    $('fileInput').onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try { await importFile(file); } catch (err) { console.error(err); toast(err.message || '가져오기에 실패했어요'); }
    };
    $('btnSettings').onclick = openSettings;
    $('settingsDlg').addEventListener('close', closeSettings);
    $('btnReset').onclick = resetAll;
  }

  // 시작
  let booted = false;
  bind();
  setType('지출');
  fillSelect($('fMethod'), state.settings.methods, state.settings.methods[0]);
  resetForm();
  render();
  booted = true;
  if (hasClaude) connectCloud(); else setStatus('이 브라우저에 저장', '');
  window.__gagyebu = { get state() { return state; }, buildWorkbook, importFile };
})();
