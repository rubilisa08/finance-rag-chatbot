// 청크 → 벡터스토어 생성 스크립트 (Node)
// 임베딩은 node-embedder.mjs(= src/rag.ts embed()와 같은 계산), 모델·입력 형식은 src/embed-format.ts.
//
// 사용법 (app 폴더에서):
//   node scripts/embed-docs.mjs <청크.json> <출력.json>     청크에 vector를 붙여 저장 + <출력>.meta.json 기록
//   node scripts/embed-docs.mjs --verify <벡터스토어.json> [개수]
//                                                           저장된 벡터와 다시 만든 벡터의 코사인 비교

import { readFile, writeFile } from "node:fs/promises";
import { MODEL_ID, MODEL_FILE, DIM, INPUT_FORMAT } from "../src/embed-format.ts";
import { embedDocument } from "./node-embedder.mjs";

const cosine = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

async function verify(storePath, n) {
  const docs = JSON.parse(await readFile(storePath, "utf8"));
  for (const d of docs.slice(0, n)) {
    const v = await embedDocument(d);
    console.log(`${d.id}  저장된 벡터와 코사인 유사도 = ${cosine(v, d.vector).toFixed(6)}`);
  }
}

/** 임베딩 전에 청크 검사 — 필드 누락·중복 id는 중단, 120자 미만은 경고 */
function checkChunks(chunks) {
  const seen = new Set();
  for (const [i, c] of chunks.entries()) {
    const missing = ["id", "text", "url", "section"].filter((k) => !c[k]);
    if (missing.length) throw new Error(`${i + 1}번째 청크(${c.id ?? "id 없음"})에 필드 누락: ${missing.join(", ")}`);
    if (seen.has(c.id)) throw new Error(`중복 id: ${c.id}`);
    seen.add(c.id);
    if (c.text.length < 120) console.warn(`⚠ ${c.id}: text가 ${c.text.length}자입니다 (120자 이상 권장)`);
  }
}

async function build(inPath, outPath) {
  const chunks = JSON.parse(await readFile(inPath, "utf8"));
  checkChunks(chunks);
  const out = [];
  for (const { id, text, url, section } of chunks) {
    const vector = await embedDocument({ section, text });
    out.push({ id, text, url, section, vector });
    console.log(`✓ ${id} (${section})`);
  }
  const bad = out.filter((c) => c.vector.length !== DIM);
  if (bad.length) throw new Error(`${DIM}차원이 아닌 벡터: ${bad.map((c) => `${c.id}(${c.vector.length})`).join(", ")}`);
  // 학습용: 벡터가 어떻게 생겼는지, 정규화됐는지(노름 1.0) 확인
  const first = out[0].vector;
  const norm = Math.sqrt(first.reduce((s, v) => s + v * v, 0));
  console.log(`첫 벡터 앞 5개: [${first.slice(0, 5).map((v) => v.toFixed(4)).join(", ")}]  노름: ${norm.toFixed(4)}`);
  await writeFile(outPath, JSON.stringify(out));
  // 안전장치: 어떤 설정으로 만들었는지 옆에 기록 — rag.ts·search.mjs가 현재 설정과 다르면 검색을 거부한다
  const metaPath = outPath.replace(/\.json$/, ".meta.json");
  const meta = { model: MODEL_ID, modelFile: MODEL_FILE, dim: DIM, inputFormat: INPUT_FORMAT, count: out.length, createdAt: new Date().toISOString() };
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  console.log(`저장: ${outPath} — ${out.length}청크 × ${DIM}차원 (설정 기록: ${metaPath})`);
}

const args = process.argv.slice(2);
try {
  if (args[0] === "--verify") await verify(args[1], Number(args[2] ?? 3));
  else if (args.length === 2) await build(args[0], args[1]);
  else {
    console.error("사용법: node scripts/embed-docs.mjs <청크.json> <출력.json> | --verify <벡터스토어.json> [개수]");
    process.exit(1);
  }
} catch (e) {
  console.error(`✗ 중단: ${e.message}`);
  process.exit(1);
}
