"""
밸류 체커 간편 실행기 (아이패드 a-Shell용, PC에서도 동작)

a-Shell의 Documents 폴더에 이 파일 하나만 두고:
  python3 vc.py          → 밸류 체커 실행 (처음이면 코드를 자동으로 내려받음)
  python3 vc.py update   → 최신 버전으로 업데이트 후 실행
그다음 사파리에서 http://127.0.0.1:8777 을 엽니다.
"""
import glob
import io
import os
import runpy
import sys
import urllib.request
import zipfile

ZIP_URL = "https://github.com/yunjinyoung-dev/claude_20261118/archive/refs/heads/claude/household-budget-webapp-iex0fm.zip"
HERE = os.path.dirname(os.path.abspath(__file__))


def find_app():
    candidates = [os.path.join(HERE, "server.py")] + sorted(glob.glob(os.path.join(HERE, "*", "stock-valuation", "server.py")))
    for path in candidates:
        if os.path.isfile(path) and os.path.isfile(os.path.join(os.path.dirname(path), "static", "index.html")):
            return os.path.dirname(path)
    return None


def update():
    print("최신 버전을 내려받는 중…")
    data = urllib.request.urlopen(ZIP_URL, timeout=60).read()
    zipfile.ZipFile(io.BytesIO(data)).extractall(HERE)
    print("업데이트 완료")


def main():
    args = sys.argv[1:]
    if args[:1] == ["update"]:
        args = args[1:]
        update()
    app = find_app()
    if not app:
        update()
        app = find_app()
    if not app:
        print("밸류 체커 파일을 찾지 못했어요. 인터넷 연결을 확인하고 python3 vc.py update 를 실행해 보세요.")
        sys.exit(1)
    os.chdir(app)
    sys.path.insert(0, app)
    sys.argv = ["server.py", "--no-browser"] + args
    print("사파리에서 http://127.0.0.1:8777 을 여세요 (a-Shell은 화면에 띄워 두세요)")
    runpy.run_path(os.path.join(app, "server.py"), run_name="__main__")


if __name__ == "__main__":
    main()
