# K-IFRS 제1115호 수익인식 안내 챗봇

회계팀 신입과 회계 학습자가 K-IFRS 제1115호의 수익인식 기준을 물으면, 기준서 요약에서 근거를 찾아 답하고 기준서 원문을 바로 열어 확인할 수 있게 하는 브라우저 RAG 챗봇이다. 모두콘 안내 챗봇(github.com/suncreation/moducon-chatbot) 구조에서 데이터와 도메인 문구만 교체했다.

- 무엇을 왜 만드는지, 답변 규칙, 수용 기준: `PRD.md`
- 사용자용 설명, 실험 기록: `README.md`

## 바꾸지 않는 것
과제 조건이다. 결과 차이를 자료 차이로 읽기 위해 유지한다.
- 벡터스토어 스키마: `app/public/ifrs-docs.json`은 `[{ id, text, url, section, vector }]` 배열
- 검색 순서: 벡터 유사도 top-10 + BM25 top-5 (`app/src/search-core.ts`의 `rankHybrid()`, 모두콘 `retrieve()`에서 로직 그대로 옮김)
- 프롬프트의 근거·출처 규칙과 "근거 약함" 기준(최고 유사도 < 0.55), 판정 로직(`app/src/judge.ts`)
- 이 중 하나를 바꾸는 것은 "실험"이다. 한 번에 변수 하나만 바꾸고 README 실험 결과에 기록한다.

## 임베딩 계약
- 정의는 `app/src/embed-format.ts` **한 곳에만** 둔다. 브라우저(`rag.ts`, 질문)와 Node(`app/scripts/node-embedder.mjs` → `embed-docs.mjs` 문서, `search.mjs` 질문)가 모두 이 파일을 가져다 쓴다.
- Node 임베딩 파이프라인은 `app/scripts/node-embedder.mjs`에서 한 번만 만들어 재사용한다(`embedDocument(chunk)`, `embedQuery(question)`).
- 모델: `onnx-community/embeddinggemma-300m-ONNX`의 `model_no_gather_q4` 파일. dtype은 q4로 고정이다. 질문 임베딩이 브라우저 WASM에서 돌아서, q4/q8 기본 파일은 쓸 수 없다(GatherBlockQuantized 미지원).
- 벡터 만들기: `last_hidden_state` → mean pooling → L2 정규화, 768차원. 정규화했으므로 내적 = 코사인 유사도다.
- 입력 형식 (`INPUT_FORMAT = "embeddinggemma-official-v1"`)
  - 문서: `"title: " + section + " | text: " + text`
  - 질문: `"task: search result | query: " + question`
- 안전장치: `embed-docs.mjs`가 벡터스토어 옆에 `ifrs-docs.meta.json`(`model`, `modelFile`, `dim`, `inputFormat`, `count`, `createdAt`)을 기록한다. `rag.ts`의 `loadCorpus()`는 메타가 `embed-format.ts`와 다르면 검색을 거부하고 "embed-docs.mjs를 다시 실행하라"고 안내한다.
- 입력 형식이나 모델을 바꾸면 `INPUT_FORMAT` 값을 올리고 벡터스토어를 다시 만든다.

## 검색 계약
- 순위 계산은 `app/src/search-core.ts`의 `rankHybrid()` **한 곳에만** 둔다. 브라우저(`rag.ts`의 `retrieve()`)와 Node(`app/scripts/search.mjs`의 `search()`)가 같은 코드를 쓰므로 터미널 결과 = 앱 결과다. 다만 점수가 같은 청크끼리는 순서가 바뀔 수 있다(WASM과 CPU의 소수점 끝자리 차이).
- 벡터는 정규화되어 있으므로 코사인 유사도 = 내적. 벡터 top-10 + BM25 top-5(벡터 결과와 중복 제외, 모자라면 벡터 11위부터 보충).
- top-k: 앱은 15로 고정(모델에 넘기는 근거 수). CLI는 기본 3, `--k 15`로 앱과 같은 근거 목록을 본다. k ≤ 10이면 벡터 결과만 나온다.
- 약한 근거 기준 `WEAK_THRESHOLD = 0.55`는 `search-core.ts`에서만 정의·export한다. 프롬프트 경고(`rag.ts`), 화면 ⚠ 배지(`App.tsx`), CLI 경고(`search.mjs`)가 모두 이 값을 import한다. 1위 점수가 이보다 낮으면 "관련 자료가 약함"을 표시하고, 결과는 버리지 않는다.
- 기준값 근거: README 실험 1에서 무관한 질문(주가·날씨) 0.47~0.50, 관련 질문 0.70 이상. 단 "법인세 절세"(0.581)는 기준 위라 거절은 프롬프트 규칙에 맡긴다.
- `search.mjs`는 직접 실행될 때만 CLI를 돈다(`process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`). 다른 파일은 `search(question, k)`와 `WEAK_THRESHOLD`를 import해 재사용한다.
- 메타 파일이 현재 임베딩 계약과 다르면 `search.mjs`도 검색을 거부한다.

## 생성 계약
- 시스템 메시지와 프롬프트 조립은 `app/src/prompt.ts` **한 곳에만** 둔다. 앱(`App.tsx`)과 터미널(`app/scripts/ask.mjs`, `run-questions.mjs`)이 같은 코드를 쓴다. 시스템 메시지의 내용(역할, 범위 밖 규칙, 사례 판단 처리)은 제품 결정이라 PRD 5장과 맞춰 레포 소유자가 정한다.
- 프롬프트 형식은 `PROMPT_FORMAT`(현재 `"v3"`)으로 관리하고, v1·v2는 비교 재현용으로 남긴다. 형식을 바꾸면 README 실험으로 전후를 비교한다.
- 사용자 메시지 순서: ① 자료 소개 ② 근거 원칙(1위 점수 < `WEAK_THRESHOLD`면 "주의: …" 문구) ③ 출처 규칙 ④ KST 현재 시각 ⑤ `[자료]` + `[IFRS-xxx] (section) text` 줄들(대괄호 안에는 ID만) ⑥ `[질문]` ⑦ 출처 규칙 한 번 더.
- v3 출처 규칙: "근거가 된 조각의 ID만 [{검색 1위 ID}]처럼 대괄호로 감싸 해당 문장 끝에 표시합니다." 고정 예시 ID를 쓰면 모델이 그 ID를 그대로 베껴 넘기지 않은 청크를 인용한다(실험 3).
- LLM: Ollama `http://localhost:11434/api/chat`, `qwen3.5:2b`, `{ stream: true, think: false, options: { temperature: 0 } }`, NDJSON, `TextDecoder({ stream: true })` (`app/src/ollama.ts`).
- 근거 표시는 LLM에 맡기지 않는다. 넘긴 근거를 모두 보여 주고, 답변에 ID가 실제로 적힌 근거에 ✓를 붙인다(`citedIds()`).
- Ollama 연결은 실제로 호출할 때만 확인한다. `ask.mjs --show-prompt`는 Ollama 없이 동작한다.

## 데이터 규칙
- 청크 원본은 `data/chunks.json`. 벡터스토어는 여기서 만든다 (직접 고치지 않는다).
- 청크 하나에 중심 사실 하나, `text` 120자 이상, `id`는 `IFRS-001`부터 연속.
- 기준서 청크(`IFRS-001`~`014`, `IFRS-019`~`030`): `text`는 기준서 문장을 옮기지 않고 **직접 요약**한다. 원문에 없는 해석·예시·수치를 넣지 않는다. `text` 끝과 `section`에 문단 번호를 적고, `url`은 한국회계기준원 회계기준열람서비스(`https://db.kasb.or.kr/s/1115/...`)의 해당 목차 페이지다.
- 공개 레포라서 기준서 원문 발췌본은 레포에 넣지 않는다 (저작권은 IFRS 재단).
- 사내 가이드 청크(`IFRS-015`~`018`): `docs/revenue-guide.md`의 `##` 절 하나가 청크 하나다. `section`은 `교육용 사내 가이드 - 제목`, `url`은 `https://github.com/rubilisa08/finance-rag-chatbot/blob/main/docs/revenue-guide.md#제목`(공백은 하이픈). 사내 절차만 쓰고 회계기준 내용은 쓰지 않는다.

## 명령 (app 폴더에서)
```bash
npm run dev                                          # http://localhost:5173
npm run build                                        # tsc + vite build → app/dist
npm run lint                                         # oxlint
npm run embed                                        # data/chunks.json → public/ifrs-docs.json + meta 재생성
node scripts/embed-docs.mjs --verify public/ifrs-docs.json 3   # 저장된 벡터 재현 확인 (1.000000이어야 함)
npm run search -- "계약부채가 뭐야?" "내일 날씨 어때?"            # 터미널 검색 (기본 top-3, --k 15 가능)
```
- `scripts/`는 `src/*.ts`를 Node가 직접 읽으므로 **Node 22.18 이상**이 필요하다(이 PC는 v24.19.0). GitHub Actions 배포는 빌드만 하므로 Node 20으로도 된다.
- 처음 실행하면 임베딩 모델(약 200MB)을 `~/.cache/embeddinggemma-onnx`에 받는다.
- 로컬 Ollama(`qwen3.5:2b`)가 필요하다. 이 PC는 GPU가 없어 답변에 1~3분, 판정에 몇 분이 더 걸린다.

## 결정 필요
- [ ] GitHub Pages 켜기 (Settings → Pages → Source: GitHub Actions) — 레포 소유자가 직접
- [ ] 고정 질문 세트(PRD 9장) 실험 실행 후 README 실험 표 채우기 — 검색 단계는 `npm run search`로 빠르게 먼저 관찰
- [ ] (선택) 브라우저 모델 캐시 이름 `moducon-embed-v1`(`rag.ts`) — 바꾸면 기존 방문자가 모델을 다시 받으므로 그대로 둠
