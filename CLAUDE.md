# 프로젝트 개요
K-IFRS 제1115호 수익인식 학습·문단 찾기 도우미 (브라우저 RAG 챗봇)

회계 학습자(회계 전공생, 자격시험 수험생, 회계팀 신입)가 K-IFRS 제1115호 '고객과의 계약에서 생기는 수익'의 개념을 물으면, 기준서 요약 자료에서 근거를 찾아 2~4문장으로 답하고 근거가 된 **기준서 문단 번호와 원문 링크**를 함께 보여 준다. 실제 계약의 회계처리 판단은 하지 않는다.

- 모두콘 안내 챗봇(github.com/suncreation/moducon-chatbot) 구조에서 자료와 도메인 문구만 교체한 과제 산출물이다.
- 제품 요구사항·답변 규칙·수용 기준: `PRD.md` (v2.0, 2026-10-14)
- 사용자용 설명·실험 기록: `README.md`
- 배포 주소(예정): https://rubilisa08.github.io/finance-rag-chatbot/ — 아직 열리지 않음 (아래 "현재 구현 상태" 참고)

## 목표
회계 기준 관련 질문에 근거 자료를 바탕으로 답변하는 챗봇을 만든다.

- 답변보다 **근거가 먼저** 보이게 한다: 답변 바로 아래에 인용한 문단(섹션·문단 번호·원문 링크)을 펼쳐 보여 준다.
- 자료에 없는 질문은 "제가 가진 자료에는 없습니다"로, 범위 밖 질문(주가·세무·투자·다른 기준서)은 정해진 문구로 거절한다.
- 개별 계약의 판단 질문에는 결론을 내리지 않고 관련 기준 문단만 안내하며 전문가 확인을 권한다.
- 서버 없이 브라우저와 사용자 PC의 Ollama만으로 동작한다.

## 기술 스택
| 영역 | 사용 기술 |
|---|---|
| 프런트엔드 | React 19, TypeScript 6, Vite 8 (`base: './'`), 린터 oxlint |
| 임베딩 | `onnx-community/embeddinggemma-300m-ONNX`의 `model_no_gather_q4` (q4 고정, 768차원). 브라우저는 transformers.js 4.2.0 토크나이저 + onnxruntime-web 세션 직접 생성, Node는 `scripts/node-embedder.mjs` |
| 벡터 저장소 | **DB 없음.** 정적 JSON 파일 `app/public/ifrs-docs.json`을 브라우저가 받아 메모리에서 검색 |
| 검색 | 벡터 내적(=코사인) top-10 + BM25 top-5 하이브리드 (`app/src/search-core.ts`) |
| 생성 LLM | 로컬 Ollama `qwen3.5:2b` (`http://localhost:11434/api/chat`, 스트리밍). 선택: 사용자 키로 Gemini `gemini-3.5-flash` |
| 판정 | LLM-as-a-Judge 루브릭 (`app/src/judge.ts`). 로컬은 qwen3.5:2b 자기평가 |
| 배포 | GitHub Actions → GitHub Pages (`.github/workflows/deploy.yml`, Node 20으로 빌드만) |
| 스크립트 실행 | Node 22.18 이상 (`scripts/`가 `src/*.ts`를 직접 import). 이 PC는 v24.19.0 |

## 현재 구현 상태
2026-10-14 기준, `main` 브랜치에서 확인한 내용이다.

### 동작하는 기능
- 질문 → 브라우저 임베딩 → 하이브리드 검색(근거 15개) → 프롬프트 조립(v3) → Ollama 스트리밍 답변
- 검색 단계 표시: ① 임베딩 ② 근거 검색(벡터/BM25 개수, 유사도 막대) ③ 답변 생성
- 답변 아래 `CitedParagraphs`: 답변에 적힌 ID의 문단을 펼쳐 보여 줌. ID가 없으면 검색 상위 3개, 거절·약한 근거면 숨김
- 면책 문구 `disclaimer()`: 인용 청크의 section에서 문단 번호를 뽑아 프로그램이 생성
- 출처 칩: ✓는 답변에 ID가 실제로 적힌 근거 (모델이 아니라 `citedIds()`가 확인)
- 약한 근거 경고: 1위 유사도 < 0.55면 ⚠ 배지와 프롬프트 주의 문구
- 벡터 저장소 안전장치: `ifrs-docs.meta.json`이 현재 임베딩 설정과 다르면 검색 거부
- LLM 판정 배지, 👍/👎 피드백(콘솔 기록만, 서버 전송 없음), Gemini 엔진 전환
- 터미널 도구: 검색기(`search`), 질문기(`ask`), 일괄 실험(`run-questions.mjs`, `--resume` 지원)
- `npm run build`, `npm run lint` 통과 (2026-10-14 확인)

### 자료
- 청크 30개 (`data/chunks.json`), 본문 155~330자(평균 235자)
  - 기준서 요약 26개: `IFRS-001`~`014`, `IFRS-019`~`030` (본문 일부, 부록 A 계약자산·부채, 부록 B 반품권·보증·본인 대 대리인)
  - 교육용 사내 가이드 4개: `IFRS-015`~`018` (`docs/revenue-guide.md`의 `##` 절)
- 일부러 넣지 않은 주제(근거 부족 실험용): 라이선싱, 고객의 선택권, 재매입약정, 위탁약정, 미인도청구약정 등
- 고정 질문 세트 14개 (`data/fixed-questions.json`), 결과 `experiments/fixed-v3.json`

### 미완성·알려진 문제
- **배포 안 됨**: GitHub Pages가 꺼져 있어 Deploy 워크플로가 `configure-pages` 단계에서 실패한다(빌드 자체는 통과). 배포 주소는 404.
- **사례 판단 질문 실패**: "소프트웨어 + 1년 유지보수, 수행의무 몇 개?"에 결론("1개")을 내리고 엉뚱한 청크(IFRS-026)를 인용함
- **근거 부족 질문 실패**: "라이선스 수익은 언제 인식해?"에 자료에 없는 내용을 지어냄
- **5단계 개요 질문**: 5단계 중 이행 단계 한 문장만 답함 (개요 청크 없음)
- **출처 표기 흔들림**: 일부 답변이 ID 대신 "(문단 22)"처럼 문단 번호만 적음 → ✓가 안 붙고 "관련될 수 있는 문단"으로 표시됨
- **일상어 질문 검색 약함**: "대금을 먼저 받으면 바로 매출로 인식하나요?"에서 정답 청크 IFRS-014가 근거 15개 안에 안 들어옴 (청크가 기준서 용어로만 쓰여 있음)
- 판정이 같은 2B 모델의 자기평가라 관대함 (README 실험 0)
- 속도: GPU가 없는 이 PC에서 답변 1~3분(평균 약 179초), 판정은 몇 분 더

## 주요 파일
| 경로 | 역할 |
|---|---|
| `PRD.md` | 제품 정의(v2.0), 답변 규칙(5장), 수용 기준(8장), 고정 질문(9장), 결정 기록(11장) |
| `README.md` | 사용자 안내, 사용 조건(Ollama·CORS), 설계 결정, 실험 0~5 기록 |
| `data/chunks.json` | **청크 원본.** 사람이 고치는 유일한 자료 파일 |
| `data/fixed-questions.json` | 고정 질문 세트 (`type`, `question`, `expect`, `expectRefusal`) |
| `data/exp3-questions.json` | 실험 3용 질문 |
| `docs/revenue-guide.md` | 교육용 사내 가이드(SOP). `##` 절 하나 = 청크 하나 |
| `experiments/*.json` | 실험 결과 원문 (답변 전문과 측정값, 실패도 지우지 않음) |
| `app/public/ifrs-docs.json` | 벡터 저장소 `[{ id, text, url, section, vector }]`. **직접 고치지 않음** (`npm run embed`로 생성) |
| `app/public/ifrs-docs.meta.json` | 벡터 저장소를 만든 설정 (`model`, `modelFile`, `dim`, `inputFormat`, `count`, `createdAt`) |
| `app/src/embed-format.ts` | **임베딩 계약** 한 곳: 모델, 차원, 입력 형식, `metaMismatch()` |
| `app/src/search-core.ts` | **검색 계약** 한 곳: `rankHybrid()`, BM25, `WEAK_THRESHOLD = 0.55` |
| `app/src/prompt.ts` | **생성 계약** 한 곳: 시스템 메시지, `buildPrompt()`, `PROMPT_FORMAT = "v3"`, `citedIds()`, `refusalSignals()`, `disclaimer()` |
| `app/src/rag.ts` | 브라우저 임베딩 `embed()`, `loadCorpus()`(메타 검사), `retrieve()` |
| `app/src/ollama.ts` | Ollama 스트리밍 `chatStream()`, `pingOllama()`, `judgeWithOllama()` |
| `app/src/gemini.ts` | Gemini 스트리밍과 판정 (선택 기능) |
| `app/src/judge.ts` | 판정 루브릭과 집계 (모두콘 로직 유지) |
| `app/src/App.tsx` | 화면 전체: 단계 표시, 근거 문단, 출처 칩, 판정 배지, Ollama 연결 안내 |
| `app/scripts/embed-docs.mjs` | 청크 → 벡터 저장소 생성, `--verify`로 재현 확인 |
| `app/scripts/node-embedder.mjs` | Node 임베딩 파이프라인 (`embedDocument()`, `embedQuery()`) |
| `app/scripts/search.mjs` | 터미널 검색기 (앱과 같은 `rankHybrid()`) |
| `app/scripts/ask.mjs` | 터미널 질문기 (`--show-prompt`, `--judge`) |
| `app/scripts/run-questions.mjs` | 질문 목록 일괄 실행 → `experiments/<이름>.json` |
| `.github/workflows/deploy.yml` | main push 시 빌드 → Pages 배포 |

## 실행 방법
모든 명령은 `app` 폴더에서 실행한다.

```bash
npm install
npm run dev                                          # http://localhost:5173 (CORS 설정 불필요)
npm run build                                        # tsc + vite build → app/dist
npm run lint                                         # oxlint
npm run embed                                        # data/chunks.json → public/ifrs-docs.json + meta 재생성
node scripts/embed-docs.mjs --verify public/ifrs-docs.json 3   # 저장된 벡터 재현 확인 (1.000000이어야 함)
npm run search -- "계약부채가 뭐야?" "내일 날씨 어때?"            # 검색만 (기본 top-3, --k 15로 앱과 같은 15개)
npm run ask -- "계약부채가 뭐야?" --show-prompt                 # 모델 입력만 출력 (Ollama 불필요)
npm run ask -- "계약부채가 뭐야?"                               # 답변 + 근거 목록 (--judge로 판정까지)
node scripts/run-questions.mjs --name fixed-v3 --format v3 [--questions 파일] [--judge] [--resume]
```

사전 준비
- Ollama 설치 후 `ollama pull qwen3.5:2b`
- 첫 실행 때 임베딩 모델(약 200MB)을 받는다. Node는 `~/.cache/embeddinggemma-onnx`, 브라우저는 Cache Storage(`moducon-embed-v1`)
- 배포 주소에서 쓰려면 `OLLAMA_ORIGINS=https://*.github.io` 설정 후 Ollama 재시작 (OS별 방법은 README "사용 조건")

## 작업 규칙

### 답변 규칙 (제품)
- 회계 기준 관련 답변에는 근거 출처를 표시한다: 근거가 된 청크 ID를 `[IFRS-xxx]`처럼 문장 끝에 적고, 화면은 그 청크의 문단 번호와 원문 URL을 보여 준다.
- 근거를 확인할 수 없는 내용은 확정적으로 답변하지 않는다. 자료에 없으면 "제가 가진 자료에는 없습니다"라고 답한다.
- 개별 계약의 판단은 결론 없이 관련 기준만 안내하고 전문가(작성자·감사인) 확인을 권한다.
- 범위 밖(주가, 세무, 투자, 다른 기준서, 실시간 데이터)은 정해진 문구로 거절한다. 상세 기준은 PRD 5장.
- 근거 표시와 면책 문구는 모델에 맡기지 않고 프로그램이 만든다(`citedIds()`, `disclaimer()`).

### 바꾸지 않는 것 (과제 조건)
결과 차이를 자료 차이로 읽기 위해 유지한다. 이 중 하나를 바꾸면 **실험**이다.
- 벡터 저장소 스키마 `[{ id, text, url, section, vector }]`
- 검색 순서: 벡터 top-10 + BM25 top-5 (`rankHybrid()`, 모두콘 `retrieve()` 로직 그대로)
- 프롬프트의 근거·출처 규칙, "근거 약함" 기준(1위 < 0.55), 판정 로직(`judge.ts`)

### 실험 규칙
- 한 번에 변수 하나만 바꾸고, 전후를 같은 질문으로 비교해 README "실험 결과"에 기록한다.
- 실패한 답도 지우지 않는다. 결과 원문은 `experiments/`에 남긴다.
- 프롬프트 형식을 바꾸면 `PROMPT_FORMAT`을 새 버전으로 두고 이전 버전은 비교 재현용으로 남긴다(v1·v2·v4 보존, v4는 실험 5에서 기각).

### 임베딩 계약
- 정의는 `app/src/embed-format.ts`에만 둔다. 브라우저(`rag.ts`)와 Node(`node-embedder.mjs` → `embed-docs.mjs`, `search.mjs`)가 모두 이 파일을 쓴다.
- 벡터: `last_hidden_state` → mean pooling → L2 정규화, 768차원 (내적 = 코사인).
- 입력 형식 `INPUT_FORMAT = "embeddinggemma-official-v1"`
  - 문서: `"title: " + section + " | text: " + text`
  - 질문: `"task: search result | query: " + question`
- q4/q8 기본 파일은 브라우저 WASM에서 `GatherBlockQuantized` 미지원이라 쓰지 않는다.
- 모델이나 입력 형식을 바꾸면 `INPUT_FORMAT` 값을 올리고 `npm run embed`로 저장소를 다시 만든다.

### 검색 계약
- 순위 계산은 `rankHybrid()` 한 곳에만 둔다. 터미널 결과 = 앱 결과 (동점끼리는 WASM/CPU 소수점 차이로 순서가 바뀔 수 있음).
- BM25가 5개를 못 채우면 벡터 11위부터 보충해 항상 k개. 앱은 k=15 고정, CLI는 기본 3.
- `WEAK_THRESHOLD`는 `search-core.ts`에서만 정의하고 프롬프트·화면·CLI가 import한다. 근거: 실험 1에서 무관한 질문 0.47~0.50, 관련 질문 0.70 이상. "법인세 절세"(0.581)처럼 기준 위인 범위 밖 질문은 프롬프트 규칙으로 거절한다.
- `search.mjs`는 직접 실행될 때만 CLI를 돈다. 다른 파일은 `search()`를 import해 재사용한다.

### 생성 계약
- 시스템 메시지와 프롬프트 조립은 `app/src/prompt.ts`에만 둔다. 앱과 터미널(`ask.mjs`, `run-questions.mjs`)이 같은 코드를 쓴다. 시스템 메시지 내용은 제품 결정이라 PRD 5장과 맞춰 레포 소유자가 정한다.
- 사용자 메시지 순서: ① 자료 소개 ② 근거 원칙(1위 < 0.55면 "주의: …") ③ 출처 규칙 ④ KST 현재 시각 ⑤ `[자료]` + `[IFRS-xxx] (section) text` 줄들 ⑥ `[질문]` ⑦ 출처 규칙 한 번 더
- v3 출처 규칙은 예시 ID로 **검색 1위 ID**를 쓴다. 고정 예시 ID를 쓰면 모델이 그 ID를 베껴 넘기지 않은 청크를 인용한다(실험 3).
- Ollama 호출: `{ stream: true, think: false, options: { temperature: 0 } }`, NDJSON을 `TextDecoder({ stream: true })`로 읽는다. 연결 확인은 실제 호출할 때만 한다.

### 데이터 규칙
- 청크 원본은 `data/chunks.json`. 벡터 저장소는 여기서 만들고 직접 고치지 않는다.
- 청크 하나에 중심 사실 하나, `text` 120자 이상, `id`는 `IFRS-001`부터 빈 번호 없이.
- 기준서 청크: `text`는 기준서 문장을 옮기지 않고 **직접 요약**한다. 원문에 없는 해석·예시·수치를 넣지 않는다. `text` 끝과 `section`에 문단 번호, `url`은 한국회계기준원 회계기준열람서비스(`https://db.kasb.or.kr/s/1115/...`)의 해당 목차 페이지.
- 사내 가이드 청크: `section`은 `교육용 사내 가이드 - 제목`, `url`은 `https://github.com/rubilisa08/finance-rag-chatbot/blob/main/docs/revenue-guide.md#제목`(공백은 하이픈). 사내 절차만 쓰고 회계기준 내용은 쓰지 않는다.

### 저작권
- 기준서 원문의 저작권은 IFRS 재단에 있다. 공개 레포이므로 **원문 발췌본은 레포에 넣지 않는다.** 원문은 레포 밖 PC 폴더에만 두고 요약 검증에만 쓴다.
- 열람서비스(db.kasb.or.kr)는 `robots.txt`가 `Disallow: /`이므로 스크립트로 수집하지 않는다. 원문은 사람이 브라우저에서 읽고 복사한다.

## 다음 작업
우선순위 순서. 각 항목은 한 번에 하나씩 하고 결과를 README에 기록한다.

1. **GitHub Pages 켜기** (레포 소유자가 직접): Settings → Pages → Source: GitHub Actions → Actions에서 실패한 Deploy를 Re-run → 배포 주소 접속 확인
2. **자료 확장 (1115호 전체, 청크 500~800자)**
   - 원문 수집: 레포 밖 `1115-원문/` 폴더의 `목차.md`(56페이지: 본문 20, 부록 A 1, 부록 B 14, 적용사례 21)를 따라 사람이 복사해 넣는다. 본문 → 부록 A·B → 적용사례 순.
   - 요약: 채워진 페이지부터 주제별 500~800자 청크로 요약, 원문과 최장 겹침 길이 측정, 문단 번호·URL 부착. 예상 70~90개.
   - 청크 길이 규칙이 바뀌므로 데이터 규칙("중심 사실 하나, 120자 이상")을 함께 고친다.
   - 일부러 뺐던 주제(라이선싱 등)가 들어가므로 "라이선스 수익은 언제 인식해?"의 `expectRefusal`을 `false`로 바꾸고, 근거 부족 질문은 1115호에 없는 주제로 새로 정한다.
   - 프롬프트가 길어지므로 근거 수 k=15 → 8 비교를 별도 실험으로 한다.
   - `npm run embed` → `--verify` → 고정 질문 전체 재실행 → README에 전후 비교 기록
3. **일상어 질문 대응**: "대금을 먼저 받으면 바로 매출로 인식하나요?"가 IFRS-014를 찾도록 사내 가이드에 선수금 처리 절을 추가하는 실험
4. 남은 실험 후보 (한 번에 하나씩): 청크 본문 끝 "(문단 N)" 빼기 / 사례 판단 질문이 수행의무 청크를 찾도록 연결 문장 / 5단계 개요를 시스템 메시지에 고정
5. (선택) 고정 질문을 `--judge`로 돌려 LLM 판정과 문구 판정 비교 (이 PC에서 2시간 이상)
6. (선택) `deploy.yml`의 Node 20 액션 지원 종료 경고 대응 (`actions/*` 버전 올리기)
7. (그대로 둠) 브라우저 모델 캐시 이름 `moducon-embed-v1`: 바꾸면 기존 방문자가 모델을 다시 받는다
