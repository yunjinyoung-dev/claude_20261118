/*
 * 초경량 xlsx/csv 읽기·쓰기 (외부 라이브러리 없음)
 * - 쓰기: 표준 OOXML(.xlsx) 생성, 수식·날짜·숫자 서식 포함
 * - 읽기: .xlsx 의 셀 값과 수식, .csv (UTF-8 / EUC-KR)
 * 압축은 브라우저 내장 CompressionStream 을 사용합니다.
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  /* ---------- ZIP ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  async function pipe(bytes, stream) {
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(out);
  }
  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try { return await pipe(bytes, new CompressionStream('deflate-raw')); } catch (e) { return null; }
  }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 xlsx 압축 해제를 지원하지 않습니다. 최신 브라우저를 사용해 주세요.');
    return pipe(bytes, new DecompressionStream('deflate-raw'));
  }

  async function zip(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      let comp = await deflateRaw(data), method = 8;
      if (!comp || comp.length >= data.length) { comp = data; method = 0; }
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, method, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, comp);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, method, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + comp.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(eo.buffer)], { type: MIME });
  }

  function unzip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('xlsx 파일이 아니거나 손상된 파일입니다.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lo = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      entries.set(name.replace(/^\//, ''), { method, data: u8.subarray(start, start + csize) });
      p += 46 + nlen + xlen + clen;
    }
    return {
      has: (n) => entries.has(n),
      async text(n) {
        const e = entries.get(n);
        if (!e) return null;
        const raw = e.method === 8 ? await inflateRaw(e.data) : e.data;
        return dec.decode(raw);
      },
    };
  }

  /* ---------- XML 도우미 ---------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const unesc = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'amp') return '&'; if (l === 'quot') return '"'; if (l === 'apos') return "'";
    return String.fromCodePoint(l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
  }).replace(/_x([0-9A-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  const attr = (s, n) => { const m = new RegExp('(?:^|\\s)' + n + '="([^"]*)"').exec(s); return m ? unesc(m[1]) : null; };
  const stripNs = (x) => x.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
  const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const colNum = (s) => { let n = 0; for (const c of s) n = n * 26 + c.charCodeAt(0) - 64; return n; };

  /* ---------- xlsx 쓰기 ---------- */
  // 셀 서식 번호
  const STYLE = { head: 1, date: 2, month: 3, money: 4, pct: 5, moneyBold: 6, monthHead: 7, bold: 8 };
  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="165" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="표준" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  /**
   * sheets: [{ name, rows: [[cell...]...], cols: [너비...], autoFilter: true, freeze: true }]
   * cell: null | 문자열 | 숫자 | 불리언 | { v, f, s: 'money'|'date'|... }
   */
  async function writeXlsx(sheets) {
    const sst = [], sstIdx = new Map();
    const si = (s) => { if (!sstIdx.has(s)) { sstIdx.set(s, sst.length); sst.push(s); } return sstIdx.get(s); };
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const files = [];
    const defined = [];

    sheets.forEach((sh, idx) => {
      const maxCol = Math.max(1, ...sh.rows.map((r) => r.length));
      const lastRef = colName(maxCol) + Math.max(1, sh.rows.length);
      let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}>`;
      x += `<dimension ref="A1:${lastRef}"/>`;
      x += `<sheetViews><sheetView workbookViewId="0"${idx === 0 ? ' tabSelected="1"' : ''}>`;
      if (sh.freeze) x += '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
      x += '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="16.5"/>';
      if (sh.cols && sh.cols.length) x += '<cols>' + sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
      x += '<sheetData>';
      sh.rows.forEach((row, r) => {
        x += `<row r="${r + 1}">`;
        row.forEach((cell, c) => {
          if (cell === null || cell === undefined || cell === '') return;
          const o = typeof cell === 'object' ? cell : { v: cell };
          const ref = colName(c + 1) + (r + 1);
          const s = o.s ? ` s="${STYLE[o.s] || 0}"` : '';
          const v = o.v;
          if (o.f) {
            const f = `<f>${esc(String(o.f).replace(/^=/, ''))}</f>`;
            if (o.error) x += `<c r="${ref}"${s} t="e">${f}<v>${esc(o.error)}</v></c>`;
            else if (typeof v === 'string') x += `<c r="${ref}"${s} t="str">${f}<v>${esc(v)}</v></c>`;
            else if (typeof v === 'boolean') x += `<c r="${ref}"${s} t="b">${f}<v>${v ? 1 : 0}</v></c>`;
            else if (typeof v === 'number' && isFinite(v)) x += `<c r="${ref}"${s}>${f}<v>${v}</v></c>`;
            else x += `<c r="${ref}"${s}>${f}</c>`;
          } else if (typeof v === 'number') {
            if (isFinite(v)) x += `<c r="${ref}"${s}><v>${v}</v></c>`;
          } else if (typeof v === 'boolean') {
            x += `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
          } else if (v !== null && v !== undefined && v !== '') {
            x += `<c r="${ref}"${s} t="s"><v>${si(String(v))}</v></c>`;
          }
        });
        x += '</row>';
      });
      x += '</sheetData>';
      if (sh.autoFilter && sh.rows.length) {
        x += `<autoFilter ref="A1:${lastRef}"/>`;
        defined.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${idx}" hidden="1">'${esc(sh.name.replace(/'/g, "''"))}'!$A$1:$${colName(maxCol)}$${Math.max(1, sh.rows.length)}</definedName>`);
      }
      x += '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
      files.push({ name: `xl/worksheets/sheet${idx + 1}.xml`, data: x });
    });

    const n = sheets.length;
    files.push({ name: 'xl/sharedStrings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">` + sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') + '</sst>' });
    files.push({ name: 'xl/styles.xml', data: STYLES_XML });
    files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${NS}><bookViews><workbookView/></bookViews><sheets>` +
      sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' +
      (defined.length ? `<definedNames>${defined.join('')}</definedNames>` : '') + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((sh, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` });
    files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
    files.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((sh, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>' });
    // [Content_Types].xml 을 맨 앞으로
    files.unshift(files.pop());
    return zip(files);
  }

  /* ---------- xlsx 읽기 ---------- */
  function richText(x) {
    x = x.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let out = '', m;
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    while ((m = re.exec(x))) out += unesc(m[1]);
    return out;
  }

  /** 반환: [{ name, rows: [[{ v, f } | null ...] ...] }] — 날짜는 엑셀 일련번호(숫자)로 옵니다 */
  async function readXlsx(buf) {
    const z = unzip(buf);
    const wbXml = await z.text('xl/workbook.xml');
    if (!wbXml) throw new Error('엑셀 통합문서(xlsx)를 찾을 수 없습니다.');
    const relsXml = (await z.text('xl/_rels/workbook.xml.rels')) || '';
    const rels = {};
    for (const m of relsXml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)>/g)) rels[attr(m[1], 'Id')] = attr(m[1], 'Target');
    const sstXml = await z.text('xl/sharedStrings.xml');
    const sst = sstXml ? [...stripNs(sstXml).matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => richText(m[1] || '')) : [];

    const out = [];
    for (const m of stripNs(wbXml).matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const name = attr(m[1], 'name');
      const rid = (/\b[\w]+:id="([^"]*)"/.exec(m[1]) || /\bid="([^"]*)"/.exec(m[1]) || [])[1];
      let target = rels[rid];
      if (!target) continue;
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      const xml = await z.text(target);
      if (!xml) continue;
      const rows = [];
      let rIdx = 0;
      for (const rm of stripNs(xml).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const rr = attr(rm[1], 'r');
        rIdx = rr ? +rr : rIdx + 1;
        const row = [];
        let cIdx = 0;
        for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = attr(cm[1], 'r');
          const mm = ref && /^([A-Z]+)(\d+)$/.exec(ref);
          cIdx = mm ? colNum(mm[1]) : cIdx + 1;
          const t = attr(cm[1], 't') || 'n';
          const inner = cm[2] || '';
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          const fm = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
          let v = vm ? unesc(vm[1]) : null;
          if (t === 's') v = v === null ? null : sst[+v] ?? null;
          else if (t === 'inlineStr') v = richText(inner);
          else if (t === 'b') v = v === '1';
          else if (t === 'e') v = null;
          else if (t === 'str') v = v ?? '';
          else if (v !== null) v = Number(v);
          const f = fm ? unesc(fm[1]) : null;
          if (v === null && !f) continue;
          row[cIdx - 1] = { v, f };
        }
        rows[rIdx - 1] = row;
      }
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      out.push({ name, rows });
    }
    return out;
  }

  /* ---------- CSV ---------- */
  function decodeText(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { /* 엑셀 한글 CSV 는 대부분 EUC-KR */ }
    try { return new TextDecoder('euc-kr').decode(u8); } catch (e) { return new TextDecoder('utf-8').decode(u8); }
  }
  function parseCsv(text) {
    const first = text.split(/\r?\n/, 1)[0] || '';
    const counts = [',', '\t', ';'].map((d) => [d, first.split(d).length]);
    const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.map((r) => r.map((v) => (v === '' ? null : { v, f: null })));
  }
  function toCsv(rows) {
    const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  }

  global.MiniXlsx = { writeXlsx, readXlsx, parseCsv, toCsv, decodeText, MIME };
})(typeof window !== 'undefined' ? window : globalThis);
