/*
 * 밸류 체커 통계 계산 (순수 함수, 외부 라이브러리 없음)
 *
 * 1) 가격 밴드(평균회귀): 최근 N거래일 종가의 이동평균(SMA)과 표준편차(σ)
 *    z = (현재가 − SMA) / σ  → 현재가가 평균에서 표준편차 몇 개만큼 떨어져 있는지
 * 2) 변동성 시나리오: 일간 로그수익률의 표준편차 σd 로 기간별 1σ·2σ 하락 가격
 */
(function (global) {
  'use strict';

  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  function std(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  }

  const ZONES = [
    { max: -2, key: 'deep-under', label: '강한 저평가', short: '강한 저평가' },
    { max: -1, key: 'under', label: '저평가', short: '저평가' },
    { max: 1, key: 'fair', label: '적정', short: '적정' },
    { max: 2, key: 'over', label: '고평가', short: '고평가' },
    { max: Infinity, key: 'deep-over', label: '강한 고평가', short: '강한 고평가' },
  ];
  function zone(z) {
    if (z <= -2) return ZONES[0];
    if (z <= -1) return ZONES[1];
    if (z < 1) return ZONES[2];
    if (z < 2) return ZONES[3];
    return ZONES[4];
  }

  /** 각 날짜의 이동평균·σ·z (창 크기 n). 앞쪽 n-1 개는 null */
  function rolling(closes, n) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < n) return out;
    let s = 0, s2 = 0;
    for (let i = 0; i < closes.length; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= n) { s -= closes[i - n]; s2 -= closes[i - n] * closes[i - n]; }
      if (i >= n - 1) {
        const m = s / n;
        const v = Math.max(0, (s2 - n * m * m) / (n - 1));
        const sd = Math.sqrt(v);
        out[i] = { sma: m, sd, z: sd > 0 ? (closes[i] - m) / sd : 0 };
      }
    }
    return out;
  }

  /**
   * history: [[YYYY-MM-DD, 종가], ...] (마지막 = 현재가 반영)
   * n: 비교 기간(거래일)
   */
  function analyze(history, n) {
    const dates = history.map((r) => r[0]);
    const closes = history.map((r) => r[1]);
    if (closes.length < Math.min(n, 40)) return { error: `가격 이력이 부족해요 (${closes.length}일). 상장한 지 얼마 안 된 종목일 수 있어요.` };
    const N = Math.min(n, closes.length);
    const price = closes[closes.length - 1];
    const win = closes.slice(-N);
    const sma = mean(win);
    const sd = std(win);
    const z = sd > 0 ? (price - sma) / sd : 0;

    // 기간 내 가격 위치(백분위)
    const below = win.filter((x) => x < price).length;
    const percentile = (below / (win.length - 1 || 1)) * 100;
    const hi = Math.max(...win), lo = Math.min(...win);

    // 과거 z 분포 (N일 창을 굴려 가며 계산한 날짜별 z)
    const roll = rolling(closes, N);
    const zHist = roll.filter(Boolean).map((r) => r.z);
    const freqBelow = (k) => (zHist.length ? zHist.filter((x) => x <= k).length / zHist.length : null);
    const freqAbove = (k) => (zHist.length ? zHist.filter((x) => x >= k).length / zHist.length : null);

    const levels = [2, 1, 0, -1, -1.5, -2, -2.5].map((k) => ({
      k,
      price: sma + k * sd,
      diff: (sma + k * sd) / price - 1,
      freq: k < 0 ? freqBelow(k) : k > 0 ? freqAbove(k) : null,
      reached: k < 0 ? price <= sma + k * sd : k > 0 ? price >= sma + k * sd : null,
    }));

    // 변동성(일간 로그수익률)
    const rets = [];
    for (let i = Math.max(1, closes.length - N); i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    const sdDaily = std(rets);
    const annualVol = sdDaily * Math.sqrt(252);
    const scenarios = [
      { label: '1주', days: 5 }, { label: '1개월', days: 21 }, { label: '3개월', days: 63 }, { label: '6개월', days: 126 },
    ].map((h) => {
      const s = sdDaily * Math.sqrt(h.days);
      return { ...h, sigma: s, down1: price * Math.exp(-s), down2: price * Math.exp(-2 * s), up1: price * Math.exp(s) };
    });

    // 차트용 시계열 (밴드가 계산되는 구간만, 최대 750일)
    const series = [];
    const start = Math.max(N - 1, closes.length - 750);
    for (let i = start; i < closes.length; i++) if (roll[i]) series.push({ date: dates[i], close: closes[i], sma: roll[i].sma, sd: roll[i].sd, z: roll[i].z });

    return {
      n: N, price, sma, sd, z, zone: zone(z),
      percentile, hi, lo,
      levels, zHistCount: zHist.length,
      sdDaily, annualVol, scenarios, series,
      from: dates[closes.length - N], to: dates[dates.length - 1],
    };
  }

  /** 호가 단위로 내림 (매수 가격 제안용) */
  function tickFloor(price, currency, isEtf) {
    if (currency !== 'KRW') return Math.floor(price * 100) / 100;
    let t;
    if (isEtf) t = 5;
    else if (price < 2000) t = 1;
    else if (price < 5000) t = 5;
    else if (price < 20000) t = 10;
    else if (price < 50000) t = 50;
    else if (price < 200000) t = 100;
    else if (price < 500000) t = 500;
    else t = 1000;
    return Math.floor(price / t) * t;
  }

  global.ValueStats = { analyze, rolling, zone, tickFloor, mean, std, ZONES };
})(typeof window !== 'undefined' ? window : globalThis);
