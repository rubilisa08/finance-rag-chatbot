// 검색 계약 — 브라우저(rag.ts)와 Node(scripts/search.mjs)가 함께 쓰는 검색 계산
// 질문 벡터를 받아 하이브리드 순위를 매긴다 (임베딩·파일 읽기는 각 환경이 담당).
// (Node가 이 .ts 파일을 직접 읽으므로 타입 표기 외의 TS 전용 문법은 쓰지 않는다)

/** 약한 근거 기준 — 1위 점수가 이보다 낮으면 "관련 자료가 약함". 결과는 버리지 않는다.
 *  이 값은 여기서만 정의하고 프롬프트(rag.ts)·화면 배지(App.tsx)·CLI(search.mjs)가 가져다 쓴다. */
export const WEAK_THRESHOLD = 0.55;

export interface DocChunk {
  id: string;
  text: string;
  url: string;
  section: string;
  vector: number[];
}

export interface Retrieved {
  chunk: DocChunk;
  score: number;
  method: "vector" | "bm25";
}

// 단어 검색용 불용어 — 조사·접속사·군더더기 표현 (2글자 이상만 걸러낸다)
const STOPWORDS = new Set([
  "에서", "에게", "한테", "부터", "까지", "처럼", "같이", "마다", "보다", "라는",
  "무엇", "언제", "어디", "누구", "어떤", "어떻게", "왜요", "인가요", "나요",
  "있는", "없는", "하는", "했던", "하는지", "인지", "니까", "이며", "하고",
  "주세요", "알려줘", "알려주세요", "가르쳐", "가르쳐줘", "말해줘", "해줘",
  "해주세요", "해주실", "그리고", "그래서", "하지만", "그런데", "근데", "the", "is", "what", "when", "where", "how", "about", "please", "tell",
]);

/** 질문에서 검색어 뽑기 — 소문자 통일, 1글자·불용어 제거 */
function queryTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^가-힣a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ── BM25 단어 검색 ────────────────────────────────────────────────────────
//  tf(빈도)·IDF(희귀도)·문서 길이 정규화를 갖춘 표준 단어 검색 점수(k1=1.5, b=0.75).
//  tf는 토큰 '포함' 관계로 세서 조사가 붙은 형태("수행의무를")도 "수행의무" 검색어에
//  적중시킨다. 말뭉치가 작아 질문마다 그 자리에서 계산한다(별도 색인 없음).
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** BM25 원점수 — 문서별 점수(정규화 전). 점수 0 = 적중 없음 */
function bm25(docs: DocChunk[], terms: string[]): { chunk: DocChunk; score: number }[] {
  if (!terms.length) return [];
  const toks = docs.map((d) => queryTerms(d.text)); // 문서 토큰화도 질문과 같은 규칙
  const avgdl = toks.reduce((s, t) => s + t.length, 0) / docs.length;
  const df = new Map<string, number>(); // 검색어 → 그 검색어를 포함하는 문서 수
  for (const t of new Set(terms)) {
    df.set(t, toks.reduce((n, dt) => n + (dt.some((x) => x.includes(t)) ? 1 : 0), 0));
  }
  return docs.map((chunk, i) => {
    const dl = toks[i].length || 1;
    let score = 0;
    for (const [t, dfv] of df) {
      if (!dfv) continue;
      let tf = 0;
      for (const x of toks[i]) if (x.includes(t)) tf++;
      if (!tf) continue;
      const idf = Math.log((docs.length - dfv + 0.5) / (dfv + 0.5) + 1);
      score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl));
    }
    return { chunk, score };
  });
}

/** 하이브리드 순위 — 벡터 유사도 상위 10개 + BM25 상위 5개(벡터 결과와 중복 제외).
 *  BM25가 5개를 못 채우면 벡터 순위 11위부터 보충해 항상 k개를 돌려준다.
 *  BM25 점수는 표시를 위해 이번 질문의 최상위가 1이 되게 정규화한다.
 *  벡터는 정규화되어 있으므로 내적 = 코사인 유사도. q는 질문 벡터(queryInput 형식으로 임베딩). */
export function rankHybrid(docs: DocChunk[], q: number[], question: string, k = 15): Retrieved[] {
  const vec = docs
    .map((chunk) => {
      let dot = 0;
      const v = chunk.vector;
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
      return { chunk, score: dot, method: "vector" as const };
    })
    .sort((a, b) => b.score - a.score);
  const topVec = vec.slice(0, Math.min(10, k));
  const picked = new Set(topVec.map((r) => r.chunk.id));
  const scored = bm25(docs, queryTerms(question))
    .filter((r) => r.score > 0 && !picked.has(r.chunk.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, k - topVec.length));
  const top = scored[0]?.score ?? 0;
  const lex = scored.map((r) => ({
    chunk: r.chunk,
    score: top > 0 ? r.score / top : 0,
    method: "bm25" as const,
  }));
  for (const r of lex) picked.add(r.chunk.id);
  const rest = vec.filter((r) => !picked.has(r.chunk.id)).slice(0, k - topVec.length - lex.length);
  return [...topVec, ...lex, ...rest];
}

/** 1위 점수가 약한 근거 기준보다 낮은가 */
export function isWeak(hits: Retrieved[]): boolean {
  return (hits[0]?.score ?? 0) < WEAK_THRESHOLD;
}
