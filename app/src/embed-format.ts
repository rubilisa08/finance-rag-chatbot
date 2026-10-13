// 임베딩 계약 — 브라우저(rag.ts, 질문)와 Node(scripts/embed-docs.mjs, 문서)가 함께 쓰는 유일한 정의
// 여기 값을 바꾸면 반드시 벡터스토어를 다시 만든다: cd app && node scripts/embed-docs.mjs ../data/chunks.json public/ifrs-docs.json
// (Node가 이 .ts 파일을 직접 읽으므로 타입 표기 외의 TS 전용 문법은 쓰지 않는다)

export const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
/** 브라우저 WASM ORT에서 동작하는 변형 — dtype은 q4로 고정 (q4/q8 기본 파일은 GatherBlockQuantized 미지원) */
export const MODEL_FILE = "model_no_gather_q4";
export const DIM = 768;
/** 입력 형식 버전 — 아래 두 함수를 바꾸면 이 값도 올린다 */
export const INPUT_FORMAT = "embeddinggemma-official-v1";

/** 질문용 입력 형식 (EmbeddingGemma 공식 검색 질의 형식) */
export function queryInput(question: string): string {
  return `task: search result | query: ${question}`;
}

/** 문서용 입력 형식 (EmbeddingGemma 공식 문서 형식) */
export function documentInput(chunk: { section: string; text: string }): string {
  return `title: ${chunk.section} | text: ${chunk.text}`;
}

/** 벡터스토어 옆 메타 파일(ifrs-docs.meta.json)의 내용 */
export interface StoreMeta {
  model: string;
  modelFile: string;
  dim: number;
  inputFormat: string;
  count: number;
  createdAt: string;
}

/** 저장된 메타가 현재 임베딩 계약과 같은지 — 다르면 이유를 돌려준다 */
export function metaMismatch(meta: StoreMeta): string | null {
  if (meta.model !== MODEL_ID) return `모델이 다릅니다 (저장소 ${meta.model}, 현재 ${MODEL_ID})`;
  if (meta.modelFile !== MODEL_FILE) return `모델 파일이 다릅니다 (저장소 ${meta.modelFile}, 현재 ${MODEL_FILE})`;
  if (meta.dim !== DIM) return `차원이 다릅니다 (저장소 ${meta.dim}, 현재 ${DIM})`;
  if (meta.inputFormat !== INPUT_FORMAT) return `입력 형식이 다릅니다 (저장소 ${meta.inputFormat}, 현재 ${INPUT_FORMAT})`;
  return null;
}
