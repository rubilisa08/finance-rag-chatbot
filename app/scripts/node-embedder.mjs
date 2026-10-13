// Node용 임베딩 파이프라인 — embed-docs.mjs(문서)와 search.mjs(질문)가 함께 쓴다
// src/rag.ts의 embed()와 같은 계산:
//   embeddinggemma-300m model_no_gather_q4.onnx + 같은 토크나이저 → mean pooling → L2 정규화 (768차원)
//   모델·입력 형식은 src/embed-format.ts 한 곳에서 가져온다
// 파이프라인(ORT 세션 + 토크나이저)은 처음 한 번만 만들어 재사용한다.
// 모델 파일은 처음 한 번만 내려받아 ~/.cache/embeddinggemma-onnx 에 보관한다 (레포에 넣지 않음).

import { mkdir, stat, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { AutoTokenizer } from "@huggingface/transformers";
import { MODEL_ID, MODEL_FILE, documentInput, queryInput } from "../src/embed-format.ts";

const HF_ONNX = `https://huggingface.co/${MODEL_ID}/resolve/main/onnx`;
const FILES = [`${MODEL_FILE}.onnx`, `${MODEL_FILE}.onnx_data`];
const CACHE_DIR = join(homedir(), ".cache", "embeddinggemma-onnx");

async function download(file) {
  const dest = join(CACHE_DIR, file);
  try {
    await stat(dest);
    return dest;
  } catch {
    // 캐시에 없으면 내려받는다
  }
  console.log(`내려받는 중: ${file}`);
  const res = await fetch(`${HF_ONNX}/${file}`);
  if (!res.ok || !res.body) throw new Error(`모델 파일 내려받기 실패 (${res.status}): ${file}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);
  return dest;
}

let ready = null;

/** ORT 세션 + 토크나이저 — 한 번만 만든다 */
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      console.log("임베딩 모델 불러오는 중…(첫 실행은 다운로드, 약 200MB)");
      await mkdir(CACHE_DIR, { recursive: true });
      const paths = [];
      for (const f of FILES) paths.push(await download(f));
      // .onnx_data는 같은 폴더에 있으면 onnxruntime-node가 자동으로 읽는다
      const session = await ort.InferenceSession.create(paths[0], { executionProviders: ["cpu"] });
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      return { session, tokenizer };
    })();
  }
  return ready;
}

/** 입력 문자열 → 768차원 벡터 (src/rag.ts embed()와 같은 계산). 입력 형식은 붙이지 않는다. */
export async function embed(text) {
  const { session, tokenizer } = await ensureReady();
  const enc = await tokenizer(text);
  const toOrt = (t) => new ort.Tensor("int64", BigInt64Array.from(t.data, (x) => BigInt(x)), t.dims);
  const out = await session.run({ input_ids: toOrt(enc.input_ids), attention_mask: toOrt(enc.attention_mask) });
  const hs = out.last_hidden_state;
  const [, seq, hid] = hs.dims;
  const am = enc.attention_mask.data;
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
  return Array.from(acc, (v) => v / norm);
}

/** 문서 청크 → 벡터 (문서용 입력 형식) */
export const embedDocument = (chunk) => embed(documentInput(chunk));

/** 질문 → 벡터 (질문용 입력 형식) */
export const embedQuery = (question) => embed(queryInput(question));
