#!/usr/bin/env python3
"""
밸류 체커 — 주식·ETF 저평가/고평가 판단 웹앱 (로컬 서버)

파이썬 표준 라이브러리만 사용합니다. 설치할 패키지가 없습니다.
  python3 server.py          → http://127.0.0.1:8777 (브라우저가 자동으로 열림)
  python3 server.py --lan    → 같은 와이파이의 아이패드·휴대폰에서도 접속 가능

시세 출처
  한국: 네이버 금융 (현재가, 일봉, ETF 기준가(NAV), PER/PBR, 컨센서스)
  미국: 야후 파이낸스 (일봉), 네이버 금융 (현재가, PER/PBR, 컨센서스)
"""
import argparse
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


class NotFound(Exception):
    pass


class Upstream(Exception):
    pass


# ---------------------------------------------------------------- 네트워크·캐시
def fetch_text(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Referer": "https://m.stock.naver.com/"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            m = re.search(r"charset=([\w-]+)", r.headers.get("Content-Type", ""), re.I)
            enc = m.group(1) if m else None
    except urllib.error.HTTPError as e:
        raise Upstream(f"{urllib.parse.urlsplit(url).netloc} 응답 오류 {e.code}") from e
    except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
        raise Upstream(f"{urllib.parse.urlsplit(url).netloc} 에 연결하지 못했습니다") from e
    if not enc:
        m = re.search(rb'encoding="([\w-]+)"', raw[:200])
        enc = m.group(1).decode() if m else "utf-8"
    try:
        return raw.decode(enc)
    except (LookupError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")


def fetch_json(url, timeout=12):
    try:
        return json.loads(fetch_text(url, timeout))
    except json.JSONDecodeError as e:
        raise Upstream("시세 서버가 예상과 다른 응답을 보냈습니다") from e


_cache = {}
_cache_lock = threading.Lock()


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    val = fn()
    with _cache_lock:
        _cache[key] = (now + ttl, val)
        if len(_cache) > 500:
            for k in [k for k, v in _cache.items() if v[0] <= now]:
                _cache.pop(k, None)
    return val


def num(v):
    """'73,140' / '5.37배' / '-7.02' / '1.07%' / 'N/A' → float 또는 None"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").strip()
    m = re.match(r"^[+-]?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


# ---------------------------------------------------------------- 종목 검색
CODE_RE = re.compile(r"^[0-9][0-9A-Z]{5}$")


def search(q):
    q = q.strip()
    if not q:
        return []

    def run():
        url = "https://m.stock.naver.com/front-api/search/autoComplete?" + urllib.parse.urlencode({"query": q, "target": "stock"})
        data = fetch_json(url)
        out = []
        for it in (data.get("result") or {}).get("items") or []:
            nation = it.get("nationCode")
            if nation not in ("KOR", "USA"):
                continue
            out.append({
                "code": it.get("code"),
                "name": it.get("name"),
                "nation": nation,
                "reuters": it.get("reutersCode") or it.get("code"),
                "isEtf": bool(it.get("isEtf")),
                "market": it.get("typeName") or it.get("typeCode") or "",
            })
        qu = q.upper()
        out.sort(key=lambda x: 0 if (x["code"] or "").upper() == qu else 1)
        return out

    return cached(("search", q.upper()), 600, run)


def resolve(q, nation=None):
    items = search(q)
    if nation:
        exact = [i for i in items if i["nation"] == nation and (i["code"] or "").upper() == q.upper()]
        if exact:
            return exact[0]
    if items:
        return items[0]
    raise NotFound(f"'{q}' 종목을 찾지 못했습니다. 종목코드(예: 005930, 069500)나 미국 티커(예: SPY, AAPL)를 입력해 보세요.")


# ---------------------------------------------------------------- 한국
def kr_quote(code):
    def run():
        d = fetch_json(f"https://polling.finance.naver.com/api/realtime/domestic/stock/{code}")
        x = (d.get("datas") or [None])[0]
        if not x:
            raise NotFound(f"{code} 시세가 없습니다")
        ex = x.get("stockExchangeType") or {}
        return {
            "price": num(x.get("closePrice")),
            "change": num(x.get("compareToPreviousClosePrice")),
            "changeRate": num(x.get("fluctuationsRatio")),
            "open": num(x.get("openPrice")),
            "high": num(x.get("highPrice")),
            "low": num(x.get("lowPrice")),
            "volume": num(x.get("accumulatedTradingVolume")),
            "marketStatus": x.get("marketStatus"),
            "tradedAt": x.get("localTradedAt"),
            "currency": "KRW",
            "exchange": ex.get("nameKor") or ex.get("name"),
            "name": x.get("stockName"),
        }
    return cached(("krq", code), 8, run)


def kr_integration(code):
    return cached(("kri", code), 60, lambda: fetch_json(f"https://m.stock.naver.com/api/stock/{code}/integration"))


def kr_history(code):
    def run():
        t = fetch_text(f"https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count=1300&requestType=0")
        rows = []
        for data in re.findall(r'data="([^"]+)"', t):
            p = data.split("|")
            if len(p) >= 5 and num(p[4]):
                d = p[0]
                rows.append([f"{d[:4]}-{d[4:6]}-{d[6:8]}", num(p[4])])
        if not rows:
            raise NotFound(f"{code} 가격 이력을 받지 못했습니다")
        return rows
    return cached(("krh", code), 600, run)


def kr_fundamentals(code):
    d = kr_integration(code)
    info = {t.get("code"): t.get("value") for t in d.get("totalInfos") or []}
    f = {
        "per": num(info.get("per")), "eps": num(info.get("eps")),
        "cnsPer": num(info.get("cnsPer")), "cnsEps": num(info.get("cnsEps")),
        "pbr": num(info.get("pbr")), "bps": num(info.get("bps")),
        "dividendYield": num(info.get("dividendYieldRatio")), "dividend": num(info.get("dividend")),
        "high52": num(info.get("highPriceOf52WeeksAdjusted") or info.get("highPriceOf52Weeks")),
        "low52": num(info.get("lowPriceOf52WeeksAdjusted") or info.get("lowPriceOf52Weeks")),
        "marketValue": info.get("marketValue"),
    }
    c = d.get("consensusInfo") or {}
    f["targetPrice"] = num(c.get("priceTargetMean"))
    f["recommMean"] = num(c.get("recommMean"))
    f["consensusDate"] = c.get("createDate")
    etf = None
    if d.get("stockEndType") == "etf" or d.get("etfKeyIndicator"):
        k = d.get("etfKeyIndicator") or {}
        etf = {
            "nav": num(info.get("nav")) or num(k.get("nav")),
            "issuer": k.get("issuerName") or info.get("issueName"),
            "fee": k.get("totalFee") if k.get("totalFee") is not None else num(info.get("fundPay")),
            "baseIndex": info.get("etfBaseIdx"),
            "totalNav": k.get("totalNav"),
            "return1m": k.get("returnRate1m"), "return3m": k.get("returnRate3m"), "return1y": k.get("returnRate1y"),
            "dividendYield": k.get("dividendYieldTtm"),
        }
    return f, etf


# ---------------------------------------------------------------- 미국
def us_basic(reuters):
    return cached(("usb", reuters), 8, lambda: fetch_json(f"https://api.stock.naver.com/stock/{urllib.parse.quote(reuters)}/basic"))


def us_quote(reuters):
    d = us_basic(reuters)
    info = {t.get("code"): t.get("value") for t in d.get("stockItemTotalInfos") or []}
    ex = d.get("stockExchangeType") or {}
    q = {
        "price": num(d.get("closePriceRaw") or d.get("closePrice")),
        "change": num(d.get("compareToPreviousClosePriceRaw") or d.get("compareToPreviousClosePrice")),
        "changeRate": num(d.get("fluctuationsRatioRaw") or d.get("fluctuationsRatio")),
        "open": num(info.get("openPrice")), "high": num(info.get("highPrice")), "low": num(info.get("lowPrice")),
        "volume": num(info.get("accumulatedTradingVolume")),
        "marketStatus": d.get("marketStatus"),
        "tradedAt": d.get("localTradedAt"),
        "currency": ((d.get("currencyType") or {}).get("code")) or "USD",
        "exchange": ex.get("nameKor") or d.get("stockExchangeName"),
        "name": d.get("stockName"),
        "nameEng": d.get("stockNameEng"),
        "delay": d.get("delayTimeName"),
    }
    om = d.get("overMarketPriceInfo")
    if om and num(om.get("overPrice")):
        q["overMarket"] = {
            "price": num(om.get("overPrice")),
            "changeRate": num(om.get("fluctuationsRatio")),
            "session": (om.get("tradingSessionType") or ""),
            "tradedAt": om.get("localTradedAt"),
        }
    return q


def us_history(symbol):
    ysym = symbol.replace(".", "-")

    def run():
        d = fetch_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ysym)}?range=5y&interval=1d&includePrePost=false")
        res = ((d.get("chart") or {}).get("result") or [None])[0]
        if not res or not res.get("timestamp"):
            raise NotFound(f"{symbol} 가격 이력을 받지 못했습니다")
        off = (res.get("meta") or {}).get("gmtoffset") or 0
        closes = (((res.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
        rows = []
        for ts, c in zip(res["timestamp"], closes):
            if c is None:
                continue
            day = datetime.fromtimestamp(ts + off, tz=timezone.utc).strftime("%Y-%m-%d")
            if rows and rows[-1][0] == day:
                rows[-1][1] = round(c, 4)
            else:
                rows.append([day, round(c, 4)])
        return {"rows": rows, "meta": res.get("meta") or {}}
    return cached(("ush", ysym), 600, run)


def us_fundamentals(reuters):
    d = us_basic(reuters)
    info = {t.get("code"): t.get("value") for t in d.get("stockItemTotalInfos") or []}
    f = {
        "per": num(info.get("per")), "eps": num(info.get("eps")),
        "pbr": num(info.get("pbr")), "bps": num(info.get("bps")),
        "dividendYield": num(info.get("dividendYieldRatio")), "dividend": num(info.get("dividend")),
        "high52": num(info.get("highPriceOf52Weeks")), "low52": num(info.get("lowPriceOf52Weeks")),
        "marketValue": info.get("marketValue"),
    }
    try:
        c = cached(("usi", reuters), 600, lambda: fetch_json(f"https://api.stock.naver.com/stock/{urllib.parse.quote(reuters)}/integration")).get("consensusInfo") or {}
    except (Upstream, NotFound):
        c = {}
    f["targetPrice"] = num(c.get("priceTargetMean"))
    f["targetHigh"] = num(c.get("priceTargetHigh"))
    f["targetLow"] = num(c.get("priceTargetLow"))
    f["recommMean"] = num(c.get("recommMean"))
    f["consensusDate"] = c.get("createDate")
    return f


# ---------------------------------------------------------------- 조립
def merge_live(rows, quote, trade_date):
    """일봉 마지막 날을 실시간 현재가로 갱신(같은 날) 또는 추가(새 날)"""
    rows = [list(r) for r in rows]
    p = quote.get("price")
    if p and trade_date:
        if rows and rows[-1][0] == trade_date:
            rows[-1][1] = p
        elif not rows or rows[-1][0] < trade_date:
            rows.append([trade_date, p])
    return rows


def trade_date_of(quote):
    t = quote.get("tradedAt") or ""
    return t[:10] if re.match(r"\d{4}-\d{2}-\d{2}", t) else None


def get_quote(code, nation):
    if nation == "KOR":
        q = kr_quote(code)
        nav = None
        try:
            info = {t.get("code"): t.get("value") for t in kr_integration(code).get("totalInfos") or []}
            nav = num(info.get("nav"))
        except (Upstream, NotFound):
            pass
        return {"quote": q, "nav": nav}
    item = resolve(code, "USA")
    return {"quote": us_quote(item["reuters"]), "nav": None}


def get_stock(q, nation=None):
    item = resolve(q, nation)
    code = item["code"]
    warnings = []
    if item["nation"] == "KOR":
        quote = kr_quote(code)
        rows = kr_history(code)
        try:
            fund, etf = kr_fundamentals(code)
        except (Upstream, NotFound) as e:
            fund, etf = {}, None
            warnings.append(f"재무지표를 받지 못했습니다: {e}")
        sources = ["네이버 금융 (현재가·일봉·지표)"]
    else:
        quote = us_quote(item["reuters"])
        h = us_history(code)
        rows = h["rows"]
        try:
            fund = us_fundamentals(item["reuters"])
        except (Upstream, NotFound) as e:
            fund = {}
            warnings.append(f"재무지표를 받지 못했습니다: {e}")
        etf = {"nav": None} if item["isEtf"] else None
        sources = ["네이버 금융 (현재가·지표)", "야후 파이낸스 (일봉)"]
    if not quote.get("price"):
        raise NotFound("현재가를 받지 못했습니다")
    rows = merge_live(rows, quote, trade_date_of(quote))
    return {
        "item": item,
        "quote": quote,
        "fundamentals": fund,
        "etf": etf,
        "history": rows,
        "sources": sources,
        "warnings": warnings,
        "fetchedAt": datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC_DIR, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        qs = urllib.parse.parse_qs(u.query)
        arg = lambda k: (qs.get(k) or [""])[0].strip()
        try:
            if u.path == "/api/search":
                return self.send_json({"items": search(arg("q"))[:10]})
            if u.path == "/api/stock":
                if not arg("q"):
                    return self.send_json({"error": "종목을 입력하세요"}, 400)
                return self.send_json(get_stock(arg("q"), arg("nation") or None))
            if u.path == "/api/quote":
                return self.send_json(get_quote(arg("code"), arg("nation") or "KOR"))
            return self.send_json({"error": "없는 주소입니다"}, 404)
        except NotFound as e:
            return self.send_json({"error": str(e)}, 404)
        except Upstream as e:
            return self.send_json({"error": f"시세를 가져오지 못했습니다: {e}. 인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요."}, 502)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"오류: {e!r}\n")
            return self.send_json({"error": "처리 중 오류가 발생했습니다. 서버 창의 메시지를 확인해 주세요."}, 500)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="밸류 체커 — 주식·ETF 저평가/고평가 판단 웹앱")
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--lan", action="store_true", help="같은 와이파이의 다른 기기(아이패드 등)에서도 접속 허용")
    ap.add_argument("--no-browser", action="store_true", help="브라우저 자동 열기 끄기")
    args = ap.parse_args()
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    try:
        srv = ThreadingHTTPServer((host, args.port), Handler)
    except OSError:
        print(f"포트 {args.port} 를 쓸 수 없습니다. 이미 실행 중이 아닌지 확인하거나 --port 8778 처럼 다른 포트를 지정하세요.")
        sys.exit(1)
    url = f"http://127.0.0.1:{args.port}"
    print("=" * 52)
    print(" 밸류 체커가 실행되었습니다")
    print(f"  이 컴퓨터:  {url}")
    if args.lan:
        ip = lan_ip()
        if ip:
            print(f"  아이패드·휴대폰 (같은 와이파이):  http://{ip}:{args.port}")
    print("  끄려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요")
    print("=" * 52)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
