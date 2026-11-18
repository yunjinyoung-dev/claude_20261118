# 우리집 가계부

설치·빌드 없이 브라우저에서 바로 쓰는 가벼운 가계부입니다. (외부 라이브러리 0개, 전체 약 110KB)

## 사용 방법

- `index.html` 을 브라우저로 열면 됩니다. (또는 `python3 -m http.server` 후 `http://localhost:8000`)
- GitHub Pages 등 정적 호스팅에 그대로 올려도 동작합니다.
- 데이터는 브라우저(localStorage)에만 저장됩니다. 백업·기기 이동은 **엑셀 내보내기 → 가져오기**로 하세요.

## 주요 기능

- 수입/지출 입력 (날짜·분류·내용·금액·결제수단·메모), 행을 누르면 수정
- 금액 칸에 `=4500*3`, `3만`, `5천` 같은 입력 가능
- 월별 요약 카드(수입·지출·잔액·저축률/예산), 분류별 지출 막대
- 검색, 전체 기간 보기, 내용 입력 시 이전 분류·결제수단 자동 채움
- 설정: 분류·결제수단 편집, 월 예산

## 엑셀 호환

### 내보내기 (.xlsx)
| 시트 | 내용 |
|---|---|
| 거래내역 | A 날짜 · B 구분 · C 분류 · D 내용 · E 금액 · F 결제수단 · G 메모 (날짜는 실제 엑셀 날짜, 필터·틀고정 적용) |
| 월별요약 | `SUMIFS` 수식으로 계산되는 월별 수입·지출·잔액·저축률 |
| 분류별지출 | 분류 × 월 `SUMIFS` 표 |
| 수식 | 앱에서 저장한 수식 (엑셀에서 그대로 계산됨) |

모든 수식은 실제 엑셀 수식으로 들어가므로 내역을 엑셀에서 추가/수정하면 요약도 같이 바뀝니다.

### 가져오기
- `.xlsx`, `.csv`(UTF-8/EUC-KR) 지원. 첫 행 머리글에서 `날짜`·`금액`(또는 `수입`/`지출` 열)을 찾아 읽습니다.
  `분류/카테고리`, `내용/적요/사용처`, `결제수단`, `메모/비고` 등 흔한 머리글 이름을 인식합니다.
- 이 앱에서 내보낸 파일은 수식까지 그대로 되돌아옵니다. 기존 내역에 추가할 때 중복은 자동 제외됩니다.
- 구형 `.xls` 는 엑셀에서 `.xlsx` 로 저장한 뒤 가져오세요.

### 수식 계산기
앱 안에서 엑셀과 같은 문법으로 계산합니다. 표의 열 문자(A–G)와 행 번호가 내보낸 `거래내역` 시트와 같습니다.

```
=SUMIFS(E:E,B:B,"지출",C:C,"식비")
=SUMIFS(E:E,B:B,"지출",A:A,">="&DATE(2026,11,1),A:A,"<"&EDATE(DATE(2026,11,1),1))
=COUNTIFS(B:B,"지출",E:E,">=10000")
=ROUND(AVERAGEIF(B:B,"지출",E:E),-2)
```

지원 함수: SUM, SUMIF, SUMIFS, COUNT, COUNTA, COUNTBLANK, COUNTIF, COUNTIFS, AVERAGE, AVERAGEIF, AVERAGEIFS,
MAXIFS, MINIFS, SUMPRODUCT, MAX, MIN, MEDIAN, LARGE, SMALL, ROUND, ROUNDUP, ROUNDDOWN, INT, ABS, MOD, POWER, SQRT,
IF, IFS, IFERROR, AND, OR, NOT, TODAY, DATE, YEAR, MONTH, DAY, WEEKDAY, EDATE, EOMONTH, TEXT, VALUE,
LEN, LEFT, RIGHT, MID, TRIM, CONCAT, CONCATENATE  
조건은 `"식비"`, `">=10000"`, `"<>현금"`, `"*카드"`(와일드카드) 등 엑셀 방식 그대로입니다.

## 파일 구성

```
index.html      화면
css/style.css   스타일 (다크 모드·모바일 대응)
js/formula.js   엑셀 호환 수식 엔진
js/xlsx.js      경량 xlsx/csv 읽기·쓰기 (브라우저 내장 압축 사용)
js/app.js       가계부 로직
```
