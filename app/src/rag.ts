// K-IFRS 1115 안내 챗봇 — RAG 유틸리티
// 임베딩: embeddinggemma-300m (model_no_gather_q4 변형 — 브라우저 WASM ORT 호환)
//   - transformers.js pipeline()은 q4/q8 기본 파일을 골라 GatherBlockQuantized
//     미지원으로 실패하므로, 토크나이저만 transformers.js로 쓰고
//     ORT 세션은 no_gather_q4 파일로 직접 만든다 (2026-08 헤드리스 검증).
// 검색: ifrs-docs.json 정적 벡터스토어에서 하이브리드 검색 (계산은 search-core.ts)
//   (벡터스토어는 scripts/embed-docs.mjs로 embed()와 같은 방식으로 생성,
//    입력 형식·모델 설정은 embed-format.ts 한 곳에서 정의)

import { AutoTokenizer, type PreTrainedTokenizer } from "@huggingface/transformers";
import { MODEL_ID, MODEL_FILE, queryInput, metaMismatch, type StoreMeta } from "./embed-format";
import { rankHybrid, type DocChunk, type Retrieved } from "./search-core";

export { WEAK_THRESHOLD, type DocChunk, type Retrieved } from "./search-core";
export { buildPrompt, SYSTEM_MESSAGE, citedIds } from "./prompt";

const HF_ONNX = `https://huggingface.co/${MODEL_ID}/resolve/main/onnx`;
// transformers.js 4.2.0이 쓰는 것과 같은 onnxruntime-web 빌드 (검증된 조합)
const ORT_URL =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort.webgpu.bundle.min.mjs";

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { dims: number[]; data: Float32Array }>>;
}

let session: OrtSession | null = null;
let tokenizer: PreTrainedTokenizer | null = null;
let ready: Promise<void> | null = null;

/** 임베딩 모델 내려받기 진행률 (첫 방문 1회, 이후 브라우저 캐시 — cached: 캐시 히트) */
export type EmbedProgress = { pct: number; file: string; cached?: boolean };
let progressCb: ((p: EmbedProgress) => void) | null = null;
export function onEmbedProgress(cb: (p: EmbedProgress) => void) {
  progressCb = cb;
}

/** 모델 캐시 보유 여부만 확인한다(다운로드 없음) — 첫 화면에서 "캐시된 모델" 표시용 */
export async function peekModelCache(): Promise<boolean> {
  try {
    const c = await caches.open(MODEL_CACHE);
    return (await c.match(`${HF_ONNX}/${MODEL_FILE}.onnx_data`)) !== undefined;
  } catch {
    return false;
  }
}

// 모델 파일 캐시 — HF resolve URL은 요청마다 서명이 다른 CDN 주소로 리다이렉트되어
// HTTP 캐시가 히트하지 않는다. Cache Storage에 직접 보관해 재방문 시 재다운로드를 막는다.
const MODEL_CACHE = "moducon-embed-v1";

async function fetchWithProgress(url: string, file: string): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      progressCb?.({ pct: 100, file, cached: true });
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch {
    cache = null; // 캐시 API를 쓸 수 없는 환경 — 그냥 내려받는다
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`모델 파일 내려받기 실패 (${res.status}): ${file}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    const pct = Math.round((got / total) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      progressCb?.({ pct, file });
    }
  }
  const out = new Uint8Array(got);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  if (cache) await putWithRetry(cache, url, out);
  return out;
}

/** 캐시 저장 — Chrome이 간헐히 Unexpected internal error를 내는 경우가 있어 1회 재시도한다 */
async function putWithRetry(cache: Cache, url: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
  for (let i = 0; i < 2; i++) {
    try {
      await cache.put(url, new Response(body));
      return;
    } catch (e) {
      console.warn(`임베딩 모델 캐시 저장 실패 (${i + 1}/2) — ${url}:`, e);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

/** 토크나이저 + ORT 세션 준비 (첫 호출 시 모델 다운로드, 이후 Cache Storage 재사용) */
function ensureReady(): Promise<void> {
  if (session && tokenizer) return Promise.resolve();
  if (!ready) {
    ready = (async () => {
      // 디스크 여유가 부족할 때 브라우저가 이 사이트의 저장소를 임의로 비우지 않게 한다
      navigator.storage?.persist?.().catch(() => undefined);
      const ort = (await import(/* @vite-ignore */ ORT_URL)) as {
        InferenceSession: { create(
          buf: Uint8Array,
          opts: { executionProviders: string[]; externalData: { path: string; data: Uint8Array }[] },
        ): Promise<OrtSession> };
      };
      const core = await fetchWithProgress(`${HF_ONNX}/${MODEL_FILE}.onnx`, `${MODEL_FILE}.onnx`);
      const data = await fetchWithProgress(`${HF_ONNX}/${MODEL_FILE}.onnx_data`, `${MODEL_FILE}.onnx_data`);
      session = await ort.InferenceSession.create(core, {
        executionProviders: ["wasm"],
        externalData: [{ path: `${MODEL_FILE}.onnx_data`, data }],
      });
      tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    })().catch((e) => {
      ready = null; // 실패 시 다음 질문에서 재시도 가능
      throw e;
    });
  }
  return ready;
}

/** 문장 → 768차원 벡터 (mean pooling + L2 정규화 — 벡터스토어 생성 방식과 동일) */
export async function embed(text: string): Promise<number[]> {
  await ensureReady();
  const { input_ids, attention_mask } = await tokenizer!(text);
  const out = await session!.run({ input_ids, attention_mask });
  const hs = out.last_hidden_state;
  const [, seq, hid] = hs.dims;
  const am = attention_mask.data as ArrayLike<bigint> | ArrayLike<number>;
  const acc = new Float64Array(hid);
  let cnt = 0;
  for (let s = 0; s < seq; s++) {
    const w = Number(am[s]);
    cnt += w;
    if (!w) continue;
    for (let h = 0; h < hid; h++) acc[h] += hs.data[s * hid + h];
  }
  let norm = 0;
  for (let h = 0; h < hid; h++) {
    acc[h] /= cnt;
    norm += acc[h] * acc[h];
  }
  norm = Math.sqrt(norm);
  const vec = new Array<number>(hid);
  for (let h = 0; h < hid; h++) vec[h] = acc[h] / norm;
  return vec;
}

let corpus: DocChunk[] | null = null;

export async function loadCorpus(): Promise<DocChunk[]> {
  if (corpus) return corpus;
  // 안전장치: 벡터스토어를 만든 임베딩 설정이 지금 질문 임베딩 설정과 같을 때만 검색한다
  const metaRes = await fetch(`${import.meta.env.BASE_URL}ifrs-docs.meta.json`);
  if (!metaRes.ok) throw new Error(`벡터스토어 메타 파일이 없습니다 (${metaRes.status}) — app 폴더에서 node scripts/embed-docs.mjs를 다시 실행하세요`);
  const why = metaMismatch((await metaRes.json()) as StoreMeta);
  if (why) throw new Error(`벡터스토어와 현재 임베딩 설정이 다릅니다: ${why} — app 폴더에서 node scripts/embed-docs.mjs를 다시 실행하세요`);
  const res = await fetch(`${import.meta.env.BASE_URL}ifrs-docs.json`);
  if (!res.ok) throw new Error(`docs 로드 실패: ${res.status}`);
  corpus = (await res.json()) as DocChunk[];
  return corpus;
}

/** 하이브리드 검색 — 질문을 브라우저에서 임베딩한 뒤 search-core.ts의 rankHybrid로 순위를 매긴다
 *  (벡터 유사도 상위 10개 + BM25 상위 5개, 항상 k개). */
export async function retrieve(question: string, k = 15): Promise<Retrieved[]> {
  const [docs, q] = await Promise.all([loadCorpus(), embed(queryInput(question))]);
  return rankHybrid(docs, q, question, k);
}
