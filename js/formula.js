/*
 * 가계부 수식 엔진 — 엑셀 호환 수식 계산기 (외부 라이브러리 없음)
 *
 * 지원: 사칙연산(+ - * / ^ %), 문자열 연결(&), 비교(= <> < > <= >=),
 *       셀/범위 참조(A1, A2:E10, E:E, '거래내역'!E:E), 엑셀 스타일 조건("식비", ">=10000", "카*")
 */
(function (global) {
  'use strict';

  class XlError {
    constructor(code) { this.code = code; }
    toString() { return this.code; }
  }
  class FormulaSyntaxError extends Error {}

  const E = { VALUE: '#VALUE!', DIV0: '#DIV/0!', NAME: '#NAME?', REF: '#REF!', NUM: '#NUM!', NA: '#N/A' };
  const fail = (code) => { throw new XlError(code); };
  const syntax = (msg) => new FormulaSyntaxError(msg);

  /* ---------- 날짜 (엑셀 일련번호: 1899-12-30 = 0) ---------- */
  const DAY = 86400000;
  const EPOCH = Date.UTC(1899, 11, 30);
  const pad = (n) => String(n).padStart(2, '0');
  function dateToSerial(y, m, d) { return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY); }
  function serialToParts(n) {
    const d = new Date(EPOCH + Math.floor(n) * DAY);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
  }
  function isoToSerial(s) {
    const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/.exec(String(s).trim());
    return m ? dateToSerial(+m[1], +m[2], +m[3]) : null;
  }
  function serialToIso(n) { const p = serialToParts(n); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }

  /* ---------- 열 문자 <-> 번호 ---------- */
  function colToNum(s) { let n = 0; for (const c of s.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64); return n; }
  function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

  /* ---------- 토크나이저 ---------- */
  const SHEET_RE = /^(?:'((?:[^']|'')+)'|([^\s'!(),:;&=<>+\-*/^%"{}]+))!/;
  const FUNC_RE = /^(_xlfn\.)?([A-Za-z][A-Za-z0-9._]*)\s*\(/;
  const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?(?![A-Za-z0-9_(])/;
  const COLS_RE = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})(?![A-Za-z0-9_(])/;
  const NUM_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
  const BOOL_RE = /^(TRUE|FALSE)(?![A-Za-z0-9_(])/i;
  const OPS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%'];

  function tokenize(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const start = i;
      const rest = s.slice(i);
      let m;
      if (c === '"') {
        let j = i + 1, str = '';
        for (;;) {
          if (j >= s.length) throw syntax('따옴표(")가 닫히지 않았습니다');
          if (s[j] === '"') { if (s[j + 1] === '"') { str += '"'; j += 2; continue; } break; }
          str += s[j++];
        }
        toks.push({ t: 'str', v: str, s: start, e: j + 1 });
        i = j + 1;
        continue;
      }
      // 시트 이름이 붙은 참조
      let sheet = null, refStart = i;
      if ((m = SHEET_RE.exec(rest))) {
        const after = rest.slice(m[0].length);
        if (CELL_RE.test(after) || COLS_RE.test(after)) {
          sheet = m[1] != null ? m[1].replace(/''/g, "'") : m[2];
          refStart = i + m[0].length;
        }
      }
      const refSrc = s.slice(refStart);
      if (sheet !== null || !FUNC_RE.test(rest)) {
        if ((m = CELL_RE.exec(refSrc)) && (sheet !== null || !BOOL_RE.test(refSrc))) {
          const tok = { t: 'ref', sheet, c1: colToNum(m[1]), r1: +m[2], s: start, refStart, e: refStart + m[0].length };
          tok.c2 = m[3] ? colToNum(m[3]) : tok.c1;
          tok.r2 = m[4] ? +m[4] : tok.r1;
          toks.push(tok); i = tok.e; continue;
        }
        if ((m = COLS_RE.exec(refSrc))) {
          toks.push({ t: 'ref', sheet, c1: colToNum(m[1]), c2: colToNum(m[2]), r1: null, r2: null, s: start, refStart, e: refStart + m[0].length });
          i = refStart + m[0].length; continue;
        }
      }
      if ((m = FUNC_RE.exec(rest))) {
        toks.push({ t: 'func', v: m[2].toUpperCase(), xlfn: !!m[1], s: start, e: i + m[0].length });
        i += m[0].length; continue;
      }
      if ((m = BOOL_RE.exec(rest))) {
        toks.push({ t: 'bool', v: m[1].toUpperCase() === 'TRUE', s: start, e: i + m[0].length });
        i += m[0].length; continue;
      }
      if ((m = NUM_RE.exec(rest))) {
        toks.push({ t: 'num', v: parseFloat(m[0]), s: start, e: i + m[0].length });
        i += m[0].length; continue;
      }
      if (c === '(') { toks.push({ t: 'lp', s: i, e: ++i }); continue; }
      if (c === ')') { toks.push({ t: 'rp', s: i, e: ++i }); continue; }
      if (c === ',' || c === ';') { toks.push({ t: 'sep', s: i, e: ++i }); continue; }
      const op = OPS.find((o) => s.startsWith(o, i));
      if (op) { toks.push({ t: 'op', v: op, s: i, e: i + op.length }); i += op.length; continue; }
      const word = /^[^\s(),;"]+/.exec(rest);
      throw syntax(`알 수 없는 이름: ${word ? word[0] : c}`);
    }
    return toks;
  }

  /* ---------- 파서 (엑셀 연산자 우선순위) ---------- */
  function body(src) { const s = String(src == null ? '' : src).trim(); return s.startsWith('=') ? s.slice(1) : s; }

  function parse(src) {
    const s = body(src);
    if (!s.trim()) throw syntax('수식이 비어 있습니다');
    const toks = tokenize(s);
    let p = 0;
    const peek = () => toks[p];
    const isOp = (t, ...ops) => t && t.t === 'op' && ops.includes(t.v);
    const raw = (t) => s.slice(t.s, t.e);

    function cmp() { let a = concat(); while (isOp(peek(), '=', '<>', '<', '>', '<=', '>=')) { const op = toks[p++].v; a = { k: 'bin', op, a, b: concat() }; } return a; }
    function concat() { let a = add(); while (isOp(peek(), '&')) { p++; a = { k: 'bin', op: '&', a, b: add() }; } return a; }
    function add() { let a = mul(); while (isOp(peek(), '+', '-')) { const op = toks[p++].v; a = { k: 'bin', op, a, b: mul() }; } return a; }
    function mul() { let a = pow(); while (isOp(peek(), '*', '/')) { const op = toks[p++].v; a = { k: 'bin', op, a, b: pow() }; } return a; }
    function pow() { let a = unary(); while (isOp(peek(), '^')) { p++; a = { k: 'bin', op: '^', a, b: unary() }; } return a; }
    function unary() { if (isOp(peek(), '+', '-')) { const op = toks[p++].v; return { k: 'un', op, x: unary() }; } return postfix(); }
    function postfix() { let x = primary(); while (isOp(peek(), '%')) { p++; x = { k: 'pct', x }; } return x; }
    function primary() {
      const t = toks[p++];
      if (!t) throw syntax('수식이 중간에 끝났습니다');
      switch (t.t) {
        case 'num': return { k: 'num', v: t.v };
        case 'str': return { k: 'str', v: t.v };
        case 'bool': return { k: 'bool', v: t.v };
        case 'ref': return { k: 'ref', sheet: t.sheet, c1: t.c1, c2: t.c2, r1: t.r1, r2: t.r2 };
        case 'lp': {
          const x = cmp();
          const t2 = toks[p++];
          if (!t2 || t2.t !== 'rp') throw syntax('괄호가 닫히지 않았습니다');
          return x;
        }
        case 'func': {
          const args = [];
          if (peek() && peek().t === 'rp') { p++; return { k: 'fn', name: t.v, args }; }
          for (;;) {
            const n = peek();
            args.push(n && (n.t === 'sep' || n.t === 'rp') ? { k: 'blank' } : cmp());
            const t2 = toks[p++];
            if (!t2) throw syntax(`${t.v}( 의 괄호가 닫히지 않았습니다`);
            if (t2.t === 'rp') break;
            if (t2.t !== 'sep') throw syntax(`예상하지 못한 '${raw(t2)}'`);
          }
          return { k: 'fn', name: t.v, args };
        }
      }
      throw syntax(`예상하지 못한 '${raw(t)}'`);
    }
    const ast = cmp();
    if (p < toks.length) throw syntax(`예상하지 못한 '${raw(toks[p])}'`);
    return ast;
  }

  /* ---------- 값 변환 ---------- */
  const isRange = (v) => v !== null && typeof v === 'object' && v.range === true;

  function parseNumStr(str) {
    const t = String(str).trim();
    if (t === '') return null;
    const d = isoToSerial(t);
    if (d !== null) return d;
    let m = /^([+-]?)₩?((?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(%?)$/.exec(t);
    if (!m || m[2] === '' || m[2] === '.') return null;
    let n = parseFloat(m[2].replace(/,/g, ''));
    if (isNaN(n)) return null;
    if (m[1] === '-') n = -n;
    if (m[3]) n /= 100;
    return n;
  }
  function scalar(v) {
    if (!isRange(v)) return v;
    if (v.rows.length === 1 && v.rows[0].length === 1) return v.rows[0][0];
    return fail(E.VALUE);
  }
  function toNum(v) {
    v = scalar(v);
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = parseNumStr(v);
    return n === null ? fail(E.VALUE) : n;
  }
  function numToStr(n) {
    if (Number.isInteger(n)) return String(n);
    return String(parseFloat(n.toPrecision(15)));
  }
  function toStr(v) {
    v = scalar(v);
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return numToStr(v);
    return String(v);
  }
  function toBool(v) {
    v = scalar(v);
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const u = String(v).toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    return fail(E.VALUE);
  }
  function compare(a, b) {
    if (a === null || a === undefined) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    if (b === null || b === undefined) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) { a = a.toLowerCase(); b = b.toLowerCase(); }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const flat = (r) => (isRange(r) ? r.rows.flat() : [scalar(r)]);

  /* ---------- 조건 (SUMIF/COUNTIF 등) ---------- */
  function wildcard(s) {
    let r = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '~' && i + 1 < s.length) r += s[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else if (c === '*') r += '[\\s\\S]*';
      else if (c === '?') r += '[\\s\\S]';
      else r += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + r + '$', 'i');
  }
  function criteria(c) {
    c = scalar(c);
    if (typeof c === 'number') return (v) => (typeof v === 'number' ? v === c : typeof v === 'string' && parseNumStr(v) === c);
    if (typeof c === 'boolean') return (v) => v === c;
    let s = c === null || c === undefined ? '' : String(c);
    let op = '=';
    const m = /^(<=|>=|<>|<|>|=)/.exec(s);
    if (m) { op = m[1]; s = s.slice(op.length); }
    const num = parseNumStr(s);
    const u = s.toUpperCase();
    const bool = u === 'TRUE' ? true : u === 'FALSE' ? false : null;
    if (op === '=' || op === '<>') {
      let pred;
      if (num !== null) pred = (v) => (typeof v === 'number' ? v === num : typeof v === 'string' && parseNumStr(v) === num);
      else if (bool !== null) pred = (v) => v === bool;
      else if (s === '') pred = (v) => v === null || v === undefined || v === '';
      else { const re = wildcard(s); pred = (v) => typeof v === 'string' && re.test(v); }
      return op === '=' ? pred : (v) => !pred(v);
    }
    const test = (d) => (op === '<' ? d < 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : d >= 0);
    if (num !== null) return (v) => typeof v === 'number' && test(v - num);
    return (v) => typeof v === 'string' && test(compare(v, s));
  }
  function ifsMask(pairs, len) {
    if (pairs.length === 0 || pairs.length % 2) fail(E.VALUE);
    const mask = new Array(len).fill(true);
    for (let i = 0; i < pairs.length; i += 2) {
      const cells = flat(pairs[i]);
      if (cells.length !== len) fail(E.VALUE);
      const pred = criteria(pairs[i + 1]);
      for (let k = 0; k < len; k++) if (mask[k] && !pred(cells[k])) mask[k] = false;
    }
    return mask;
  }
  function pickIfs(target, pairs) {
    const cells = flat(target);
    const mask = ifsMask(pairs, cells.length);
    return cells.filter((v, k) => mask[k] && typeof v === 'number');
  }

  /* ---------- 숫자 모으기 ---------- */
  function nums(args) {
    const out = [];
    for (const a of args) {
      if (a === undefined) continue;
      if (isRange(a)) { for (const v of a.rows.flat()) if (typeof v === 'number') out.push(v); }
      else out.push(toNum(a));
    }
    return out;
  }
  const sum = (arr) => arr.reduce((x, y) => x + y, 0);

  /* ---------- 반올림 (엑셀 방식: 0.5는 0에서 먼 쪽으로) ---------- */
  function roundWith(fn, x, n) {
    n = Math.trunc(n || 0);
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    if (n >= 0) { const f = Math.pow(10, n); return sign * fn(+(ax * f).toPrecision(15)) / f; }
    const f = Math.pow(10, -n);
    return sign * fn(+(ax / f).toPrecision(15)) * f;
  }

  /* ---------- TEXT 서식 (자주 쓰는 형식만) ---------- */
  function formatNumber(n, fmt) {
    const unq = fmt.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1');
    const m = /[#0,]*[#0](?:\.[#0]+)?/.exec(unq);
    if (!m) return unq;
    const pat = m[0];
    const pct = unq.includes('%');
    const dec = pat.includes('.') ? pat.split('.')[1].replace(/[^0#]/g, '').length : 0;
    const v = pct ? n * 100 : n;
    let out = roundWith(Math.round, Math.abs(v), dec).toFixed(dec);
    if (pat.includes(',')) { const [i, d] = out.split('.'); out = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : ''); }
    return (v < 0 ? '-' : '') + unq.slice(0, m.index) + out + unq.slice(m.index + pat.length);
  }
  function formatDate(n, fmt) {
    const p = serialToParts(n);
    const WD = ['일', '월', '화', '수', '목', '금', '토'];
    return fmt.replace(/"([^"]*)"|yyyy|yy|mm|m|dd|d{3,4}|d|aaaa|aaa/gi, (t, lit) => {
      if (lit !== undefined) return lit;
      switch (t.toLowerCase()) {
        case 'yyyy': return String(p.y);
        case 'yy': return pad(p.y % 100);
        case 'mm': return pad(p.m);
        case 'm': return String(p.m);
        case 'dd': return pad(p.d);
        case 'd': return String(p.d);
        case 'ddd': case 'aaa': return WD[p.wd];
        case 'dddd': case 'aaaa': return WD[p.wd] + '요일';
      }
      return t;
    });
  }

  /* ---------- 함수 ---------- */
  const FN = {
    SUM: (a) => sum(nums(a)),
    AVERAGE: (a) => { const n = nums(a); return n.length ? sum(n) / n.length : fail(E.DIV0); },
    MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
    MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
    MEDIAN: (a) => {
      const n = nums(a).sort((x, y) => x - y);
      if (!n.length) return fail(E.NUM);
      const h = n.length >> 1;
      return n.length % 2 ? n[h] : (n[h - 1] + n[h]) / 2;
    },
    LARGE: ([r, k]) => { const n = nums([r]).sort((x, y) => y - x); const i = Math.trunc(toNum(k)); return i >= 1 && i <= n.length ? n[i - 1] : fail(E.NUM); },
    SMALL: ([r, k]) => { const n = nums([r]).sort((x, y) => x - y); const i = Math.trunc(toNum(k)); return i >= 1 && i <= n.length ? n[i - 1] : fail(E.NUM); },
    COUNT: (a) => {
      let c = 0;
      for (const x of a) {
        if (isRange(x)) c += x.rows.flat().filter((v) => typeof v === 'number').length;
        else if (typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && parseNumStr(x) !== null)) c++;
      }
      return c;
    },
    COUNTA: (a) => a.reduce((c, x) => c + (isRange(x) ? x.rows.flat().filter((v) => v !== null && v !== undefined && v !== '').length : x === undefined ? 0 : 1), 0),
    COUNTBLANK: ([r]) => flat(r).filter((v) => v === null || v === undefined || v === '').length,
    SUMIF: ([r, c, s]) => {
      const cells = flat(r), target = s === undefined ? cells : flat(s), pred = criteria(c);
      let t = 0;
      cells.forEach((v, k) => { if (pred(v) && typeof target[k] === 'number') t += target[k]; });
      return t;
    },
    SUMIFS: ([s, ...pairs]) => sum(pickIfs(s, pairs)),
    COUNTIF: ([r, c]) => { const pred = criteria(c); return flat(r).filter(pred).length; },
    COUNTIFS: (pairs) => { if (!pairs.length) fail(E.VALUE); return ifsMask(pairs, flat(pairs[0]).length).filter(Boolean).length; },
    AVERAGEIF: ([r, c, s]) => {
      const cells = flat(r), target = s === undefined ? cells : flat(s), pred = criteria(c);
      const n = []; cells.forEach((v, k) => { if (pred(v) && typeof target[k] === 'number') n.push(target[k]); });
      return n.length ? sum(n) / n.length : fail(E.DIV0);
    },
    AVERAGEIFS: ([s, ...pairs]) => { const n = pickIfs(s, pairs); return n.length ? sum(n) / n.length : fail(E.DIV0); },
    MAXIFS: ([s, ...pairs]) => { const n = pickIfs(s, pairs); return n.length ? Math.max(...n) : 0; },
    MINIFS: ([s, ...pairs]) => { const n = pickIfs(s, pairs); return n.length ? Math.min(...n) : 0; },
    SUMPRODUCT: (a) => {
      const arrs = a.map(flat);
      const len = arrs[0].length;
      if (arrs.some((x) => x.length !== len)) fail(E.VALUE);
      let t = 0;
      for (let k = 0; k < len; k++) t += arrs.reduce((p, x) => p * (typeof x[k] === 'number' ? x[k] : 0), 1);
      return t;
    },
    ROUND: ([x, n]) => roundWith(Math.round, toNum(x), toNum(n)),
    ROUNDUP: ([x, n]) => roundWith(Math.ceil, toNum(x), toNum(n)),
    ROUNDDOWN: ([x, n]) => roundWith(Math.floor, toNum(x), toNum(n)),
    INT: ([x]) => Math.floor(toNum(x)),
    ABS: ([x]) => Math.abs(toNum(x)),
    MOD: ([x, y]) => { const a = toNum(x), b = toNum(y); if (b === 0) fail(E.DIV0); return a - b * Math.floor(a / b); },
    POWER: ([x, y]) => Math.pow(toNum(x), toNum(y)),
    SQRT: ([x]) => { const n = toNum(x); return n < 0 ? fail(E.NUM) : Math.sqrt(n); },
    AND: (a) => { const v = a.flatMap(flat).filter((x) => x !== null && x !== undefined && typeof x !== 'string'); return v.length ? v.every(toBool) : fail(E.VALUE); },
    OR: (a) => { const v = a.flatMap(flat).filter((x) => x !== null && x !== undefined && typeof x !== 'string'); return v.length ? v.some(toBool) : fail(E.VALUE); },
    NOT: ([x]) => !toBool(x),
    TODAY: () => { const d = new Date(); return dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()); },
    DATE: ([y, m, d]) => {
      let yy = Math.trunc(toNum(y));
      if (yy < 1900) yy += 1900;
      return Math.round((Date.UTC(yy, Math.trunc(toNum(m)) - 1, Math.trunc(toNum(d))) - EPOCH) / DAY);
    },
    YEAR: ([x]) => serialToParts(toNum(x)).y,
    MONTH: ([x]) => serialToParts(toNum(x)).m,
    DAY: ([x]) => serialToParts(toNum(x)).d,
    WEEKDAY: ([x, t]) => {
      const wd = serialToParts(toNum(x)).wd;
      const type = t === undefined ? 1 : toNum(t);
      if (type === 2) return wd === 0 ? 7 : wd;
      if (type === 3) return wd === 0 ? 6 : wd - 1;
      return wd + 1;
    },
    EDATE: ([s, n]) => {
      const p = serialToParts(toNum(s)), k = Math.trunc(toNum(n));
      const last = new Date(Date.UTC(p.y, p.m - 1 + k + 1, 0)).getUTCDate();
      return dateToSerial(p.y, p.m + k, Math.min(p.d, last));
    },
    EOMONTH: ([s, n]) => { const p = serialToParts(toNum(s)); return Math.round((Date.UTC(p.y, p.m + Math.trunc(toNum(n)), 0) - EPOCH) / DAY); },
    TEXT: ([v, f]) => {
      const fmt = toStr(f), x = scalar(v);
      const n = typeof x === 'number' ? x : typeof x === 'string' ? parseNumStr(x) : null;
      if (n === null) return toStr(x);
      if (/[ymd]/i.test(fmt.replace(/"[^"]*"/g, '')) && !/[#0]/.test(fmt)) return formatDate(n, fmt);
      return formatNumber(n, fmt);
    },
    VALUE: ([x]) => toNum(x),
    LEN: ([x]) => toStr(x).length,
    LEFT: ([x, n]) => toStr(x).slice(0, n === undefined ? 1 : Math.max(0, toNum(n))),
    RIGHT: ([x, n]) => { const s = toStr(x), k = n === undefined ? 1 : Math.max(0, toNum(n)); return k ? s.slice(-k) : ''; },
    MID: ([x, st, n]) => { const s = toStr(x), a = Math.trunc(toNum(st)); if (a < 1) fail(E.VALUE); return s.substr(a - 1, Math.max(0, toNum(n))); },
    TRIM: ([x]) => toStr(x).trim().replace(/ +/g, ' '),
    CONCAT: (a) => a.flatMap(flat).map(toStr).join(''),
    CONCATENATE: (a) => a.map(toStr).join(''),
  };

  // IF/IFERROR 등은 필요한 인수만 계산
  const LAZY = {
    IF: (args, ctx) => {
      if (args.length < 2 || args.length > 3) fail(E.VALUE);
      const cond = toBool(ev(args[0], ctx));
      if (cond) return ev(args[1], ctx);
      return args.length > 2 ? ev(args[2], ctx) : false;
    },
    IFERROR: (args, ctx) => {
      try { const v = scalar(ev(args[0], ctx)); return v === null ? 0 : v; } catch (e) { if (e instanceof XlError) return ev(args[1], ctx); throw e; }
    },
    IFS: (args, ctx) => {
      for (let i = 0; i + 1 < args.length; i += 2) if (toBool(ev(args[i], ctx))) return ev(args[i + 1], ctx);
      return fail(E.NA);
    },
  };

  /* ---------- 계산기 ---------- */
  function makeRange(n, ctx) {
    if (!ctx.getCell) fail(E.REF);
    let { c1, c2, r1, r2 } = n;
    if (r1 === null) { r1 = 1; r2 = ctx.maxRow ? ctx.maxRow(n.sheet) : 1; }
    if (c1 > c2) [c1, c2] = [c2, c1];
    if (r1 > r2) [r1, r2] = [r2, r1];
    if ((c2 - c1 + 1) * (r2 - r1 + 1) > 500000) fail(E.REF);
    const rows = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) { const v = ctx.getCell(n.sheet, c, r); row.push(v === undefined || v === '' ? null : v); }
      rows.push(row);
    }
    return { range: true, rows };
  }

  function ev(n, ctx) {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'blank': return null;
      case 'ref': return makeRange(n, ctx);
      case 'un': { const x = toNum(ev(n.x, ctx)); return n.op === '-' ? -x : x; }
      case 'pct': return toNum(ev(n.x, ctx)) / 100;
      case 'bin': {
        const a = scalar(ev(n.a, ctx)), b = scalar(ev(n.b, ctx));
        switch (n.op) {
          case '&': return toStr(a) + toStr(b);
          case '=': return compare(a, b) === 0;
          case '<>': return compare(a, b) !== 0;
          case '<': return compare(a, b) < 0;
          case '>': return compare(a, b) > 0;
          case '<=': return compare(a, b) <= 0;
          case '>=': return compare(a, b) >= 0;
          case '+': return toNum(a) + toNum(b);
          case '-': return toNum(a) - toNum(b);
          case '*': return toNum(a) * toNum(b);
          case '/': { const d = toNum(b); return d === 0 ? fail(E.DIV0) : toNum(a) / d; }
          case '^': { const r = Math.pow(toNum(a), toNum(b)); return isFinite(r) ? r : fail(E.NUM); }
        }
        break;
      }
      case 'fn': {
        if (LAZY[n.name]) return LAZY[n.name](n.args, ctx);
        const f = FN[n.name];
        if (!f) return fail(E.NAME);
        const args = n.args.map((a) => (a.k === 'blank' ? null : ev(a, ctx)));
        return f(args, ctx);
      }
    }
    return fail(E.VALUE);
  }

  function evaluate(src, ctx) {
    try {
      const ast = parse(src);
      let v = scalar(ev(ast, ctx || {}));
      if (v === null || v === undefined) v = 0;
      if (typeof v === 'number' && !isFinite(v)) return { error: E.NUM };
      return { value: v };
    } catch (e) {
      if (e instanceof XlError) return { error: e.code };
      if (e instanceof FormulaSyntaxError) return { error: '#ERROR!', message: e.message };
      throw e;
    }
  }

  /* ---------- 내보내기/가져오기용 수식 변환 ---------- */
  const XLFN = new Set(['MAXIFS', 'MINIFS', 'IFS', 'CONCAT']);
  function quoteSheet(name) { return `'${name.replace(/'/g, "''")}'`; }
  function splice(src, edits) {
    let s = body(src);
    edits.sort((a, b) => b.at - a.at).forEach((e) => { s = s.slice(0, e.at) + e.ins + s.slice(e.at + (e.del || 0)); });
    return s;
  }
  /** 엑셀 파일에 쓸 수식: 시트 이름을 붙이고 최신 함수에 _xlfn. 접두사 추가 (앞의 = 제외) */
  function toExcel(src, sheet) {
    const toks = tokenize(body(src));
    const edits = [];
    for (const t of toks) {
      if (t.t === 'ref' && sheet && t.sheet === null) edits.push({ at: t.s, ins: quoteSheet(sheet) + '!' });
      if (t.t === 'func' && !t.xlfn && XLFN.has(t.v)) edits.push({ at: t.s, ins: '_xlfn.' });
    }
    return splice(src, edits);
  }
  /** 엑셀에서 읽은 수식: 해당 시트 이름과 _xlfn. 접두사 제거 (앞에 = 붙여 반환) */
  function fromExcel(src, sheet) {
    const toks = tokenize(body(src));
    const edits = [];
    for (const t of toks) {
      if (t.t === 'ref' && t.sheet !== null && sheet && t.sheet.toLowerCase() === sheet.toLowerCase()) edits.push({ at: t.s, ins: '', del: t.refStart - t.s });
      if (t.t === 'func' && t.xlfn) edits.push({ at: t.s, ins: '', del: 6 });
    }
    return '=' + splice(src, edits);
  }
  function hasRefs(src) {
    try { return tokenize(body(src)).some((t) => t.t === 'ref'); } catch (e) { return true; }
  }

  /* ---------- 함수 도움말 ---------- */
  const DOCS = [
    ['SUM', 'SUM(범위, ...)', '합계'],
    ['SUMIF', 'SUMIF(조건범위, 조건, [합계범위])', '조건에 맞는 값의 합계'],
    ['SUMIFS', 'SUMIFS(합계범위, 조건범위1, 조건1, ...)', '여러 조건을 모두 만족하는 값의 합계'],
    ['COUNTIF', 'COUNTIF(범위, 조건)', '조건에 맞는 셀 개수'],
    ['COUNTIFS', 'COUNTIFS(범위1, 조건1, ...)', '여러 조건을 만족하는 개수'],
    ['AVERAGEIF', 'AVERAGEIF(조건범위, 조건, [평균범위])', '조건에 맞는 값의 평균'],
    ['AVERAGEIFS', 'AVERAGEIFS(평균범위, 조건범위1, 조건1, ...)', '여러 조건 평균'],
    ['MAXIFS', 'MAXIFS(최대범위, 조건범위1, 조건1, ...)', '조건에 맞는 최댓값'],
    ['MINIFS', 'MINIFS(최소범위, 조건범위1, 조건1, ...)', '조건에 맞는 최솟값'],
    ['SUMPRODUCT', 'SUMPRODUCT(범위1, 범위2, ...)', '곱의 합계'],
    ['AVERAGE', 'AVERAGE(범위, ...)', '평균'],
    ['MAX', 'MAX(범위, ...)', '최댓값'],
    ['MIN', 'MIN(범위, ...)', '최솟값'],
    ['MEDIAN', 'MEDIAN(범위, ...)', '중앙값'],
    ['LARGE', 'LARGE(범위, k)', 'k번째로 큰 값'],
    ['SMALL', 'SMALL(범위, k)', 'k번째로 작은 값'],
    ['COUNT', 'COUNT(범위, ...)', '숫자 셀 개수'],
    ['COUNTA', 'COUNTA(범위, ...)', '비어 있지 않은 셀 개수'],
    ['COUNTBLANK', 'COUNTBLANK(범위)', '빈 셀 개수'],
    ['ROUND', 'ROUND(숫자, 자릿수)', '반올림 (자릿수 -3 → 천 원 단위)'],
    ['ROUNDUP', 'ROUNDUP(숫자, 자릿수)', '올림'],
    ['ROUNDDOWN', 'ROUNDDOWN(숫자, 자릿수)', '내림'],
    ['INT', 'INT(숫자)', '정수로 내림'],
    ['ABS', 'ABS(숫자)', '절댓값'],
    ['MOD', 'MOD(숫자, 나눌수)', '나머지'],
    ['IF', 'IF(조건, 참일때, [거짓일때])', '조건 분기'],
    ['IFS', 'IFS(조건1, 값1, ...)', '여러 조건 분기'],
    ['IFERROR', 'IFERROR(값, 오류일때)', '오류 대체'],
    ['AND', 'AND(조건1, ...)', '모두 참'],
    ['OR', 'OR(조건1, ...)', '하나라도 참'],
    ['NOT', 'NOT(조건)', '반대'],
    ['TODAY', 'TODAY()', '오늘 날짜'],
    ['DATE', 'DATE(연, 월, 일)', '날짜 만들기'],
    ['YEAR', 'YEAR(날짜)', '연도'],
    ['MONTH', 'MONTH(날짜)', '월'],
    ['DAY', 'DAY(날짜)', '일'],
    ['WEEKDAY', 'WEEKDAY(날짜, [유형])', '요일 번호 (1=일요일)'],
    ['EDATE', 'EDATE(날짜, 개월)', '몇 개월 뒤 같은 날'],
    ['EOMONTH', 'EOMONTH(날짜, 개월)', '몇 개월 뒤 말일'],
    ['TEXT', 'TEXT(값, "서식")', '서식 적용 (#,##0 / yyyy-mm-dd / 0.0%)'],
    ['VALUE', 'VALUE(텍스트)', '숫자로 변환'],
    ['LEN', 'LEN(텍스트)', '글자 수'],
    ['LEFT', 'LEFT(텍스트, 개수)', '왼쪽 글자'],
    ['RIGHT', 'RIGHT(텍스트, 개수)', '오른쪽 글자'],
    ['MID', 'MID(텍스트, 시작, 개수)', '중간 글자'],
    ['TRIM', 'TRIM(텍스트)', '공백 정리'],
    ['CONCAT', 'CONCAT(값1, ...)', '이어 붙이기'],
  ];

  global.Formula = {
    evaluate, parse, tokenize, toExcel, fromExcel, hasRefs,
    XlError, E, DOCS, FUNCTIONS: Object.keys(FN).concat(Object.keys(LAZY)),
    dateToSerial, serialToIso, isoToSerial, serialToParts, colToNum, numToCol, parseNumStr,
  };
})(typeof window !== 'undefined' ? window : globalThis);
