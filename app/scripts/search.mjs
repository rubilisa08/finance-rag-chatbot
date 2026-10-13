// 터미널 검색기 — 질문을 넣으면 앱과 같은 하이브리드 검색 결과를 점수와 함께 보여 준다
// 임베딩: node-embedder.mjs (질문용 입력 형식), 순위 계산: src/search-core.ts (앱과 같은 코드)
//
// 사용법 (app 폴더에서):
//   node scripts/search.mjs "질문1" ["질문2" …] [--k 3]
//   --k 15 로 실행하면 앱이 모델에 넘기는 근거 15개(벡터 10 + BM25 5)를 그대로 볼 수 있다.

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { metaMismatch } from "../src/embed-format.ts";
import { rankHybrid, isWeak, WEAK_THRESHOLD } from "../src/search-core.ts";
import { embedQuery } from "./node-embedder.mjs";

const STORE = fileURLToPath(new URL("../public/ifrs-docs.json", import.meta.url));
const META = fileURLToPath(new URL("../public/ifrs-docs.meta.json", import.meta.url));

let docs = null;

/** 벡터스토어 읽기 — 메타가 현재 임베딩 계약과 다르면 거부 */
async function loadStore() {
  if (docs) return docs;
  let meta;
  try {
    meta = JSON.parse(await readFile(META, "utf8"));
  } catch {
    throw new Error("벡터스토어 메타 파일이 없습니다 — node scripts/embed-docs.mjs ../data/chunks.json public/ifrs-docs.json 을 다시 실행하세요");
  }
  const why = metaMismatch(meta);
  if (why) throw new Error(`벡터스토어와 현재 임베딩 설정이 다릅니다: ${why} — embed-docs.mjs를 다시 실행하세요`);
  docs = JSON.parse(await readFile(STORE, "utf8"));
  return docs;
}

/** 질문 하나 검색 — 앱의 retrieve()와 같은 순위 (2단계에서 재사용) */
export async function search(question, k = 3) {
  const [store, q] = await Promise.all([loadStore(), embedQuery(question)]);
  return rankHybrid(store, q, question, k);
}

export { WEAK_THRESHOLD };

const bar = (score) => {
  const n = Math.max(0, Math.min(20, Math.round(score * 20)));
  return "█".repeat(n) + "░".repeat(20 - n);
};

function print(question, hits) {
  const warn = isWeak(hits) ? `  ⚠ 관련 자료가 약함(<${WEAK_THRESHOLD})` : "";
  console.log(`\nQ: ${question}${warn}`);
  hits.forEach((h, i) => {
    const how = h.method === "bm25" ? "BM25" : "벡터";
    console.log(`  ${i + 1}. ${h.chunk.id}  ${h.score.toFixed(3)}  ${bar(h.score)}  ${how}  [${h.chunk.section}]`);
    console.log(`     ${h.chunk.text.slice(0, 60)}…`);
    console.log(`     출처: ${h.chunk.url}`);
  });
}

async function main(argv) {
  const questions = [];
  let k = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--k") k = Number(argv[++i]);
    else questions.push(argv[i]);
  }
  if (!questions.length || !(k > 0)) {
    console.error('사용법: node scripts/search.mjs "질문1" ["질문2" …] [--k 3]');
    process.exit(1);
  }
  for (const q of questions) print(q, await search(q, k));
}

// 다른 파일이 search()를 import할 때는 CLI를 돌리지 않는다 (node -e 등으로 argv[1]이 없을 때도 안전하게)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ 중단: ${e.message}`);
    process.exit(1);
  }
}
