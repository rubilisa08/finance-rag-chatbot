// 터미널 질문기 — 앱과 같은 검색·프롬프트·Ollama 호출로 답변을 스트리밍하고 근거 출처를 보여 준다
// 검색: search.mjs(search-core.ts), 프롬프트: src/prompt.ts, LLM·판정: src/ollama.ts
//
// 사용법 (app 폴더에서):
//   node scripts/ask.mjs "질문" [--show-prompt] [--k 15] [--format v1|v2] [--judge]
//   --show-prompt  LLM에 보내는 system/user 메시지를 출력하고 끝낸다 (Ollama 없이 동작)
//   --k            모델에 넘길 근거 수 (기본 15 = 앱과 같음)
//   --format       프롬프트 형식 (기본 = src/prompt.ts의 PROMPT_FORMAT)
//   --judge        답변 뒤에 LLM-as-a-Judge 판정도 돌린다 (앱과 같은 qwen 자기평가, 몇 분 더 걸림)

import { pathToFileURL } from "node:url";
import { search, WEAK_THRESHOLD } from "./search.mjs";
import { buildPrompt, systemMessage, citedIds, PROMPT_FORMAT } from "../src/prompt.ts";
import { chatStream, pingOllama, judgeWithOllama } from "../src/ollama.ts";

const MODEL = "qwen3.5:2b";

/** LLM에 보낼 메시지 — 앱(App.tsx)과 같은 구성 */
export function buildMessages(question, hits, format = PROMPT_FORMAT) {
  return [
    { role: "system", content: systemMessage(format) },
    { role: "user", content: buildPrompt(question, hits, format) },
  ];
}

/** 질문 하나 → 검색 → 생성 (실험 스크립트에서 재사용) */
export async function answer(question, { k = 15, format = PROMPT_FORMAT, onToken = () => {} } = {}) {
  const hits = await search(question, k);
  const messages = buildMessages(question, hits, format);
  const t0 = Date.now();
  const text = await chatStream(messages, onToken, MODEL);
  return { question, format, hits, text, cited: [...citedIds(text, hits)], ms: Date.now() - t0 };
}

/** Ollama가 켜져 있는지 — 꺼져 있으면 안내하고 false */
export async function checkOllama() {
  if (await pingOllama()) return true;
  console.error("✗ Ollama에 연결할 수 없습니다. Ollama가 실행 중인지 확인하세요.");
  console.error("  확인: ollama list   (목록이 나오면 실행 중, 오류면 Ollama 앱을 실행)");
  console.error(`  모델: ollama pull ${MODEL}`);
  return false;
}

function printSources(hits, cited) {
  console.log(`\n📚 근거 (모델에 넘긴 ${hits.length}개 중 답변에 인용 ${cited.size}개, ✓ = 답변에 ID가 적힘)`);
  for (const h of hits) {
    const mark = cited.has(h.chunk.id) ? "✓" : " ";
    console.log(`  ${mark} ${h.chunk.id}  ${h.score.toFixed(3)}  [${h.chunk.section}]`);
    if (cited.has(h.chunk.id)) console.log(`      ${h.chunk.url}`);
  }
}

async function main(argv) {
  let question = null, showPrompt = false, judge = false, k = 15, format = PROMPT_FORMAT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--show-prompt") showPrompt = true;
    else if (argv[i] === "--judge") judge = true;
    else if (argv[i] === "--k") k = Number(argv[++i]);
    else if (argv[i] === "--format") format = argv[++i];
    else question = argv[i];
  }
  if (!question || !(k > 0) || !["v1", "v2"].includes(format)) {
    console.error('사용법: node scripts/ask.mjs "질문" [--show-prompt] [--k 15] [--format v1|v2] [--judge]');
    process.exit(1);
  }

  if (showPrompt) {
    const hits = await search(question, k);
    const [sys, user] = buildMessages(question, hits, format);
    console.log(`(프롬프트 형식 ${format}, 근거 ${hits.length}개, 1위 ${hits[0].score.toFixed(3)} / 약한 근거 기준 ${WEAK_THRESHOLD})`);
    console.log(`\n[system]\n${sys.content}\n\n[user]\n${user.content}`);
    return;
  }

  if (!(await checkOllama())) process.exit(1);
  console.log(`Q: ${question}\n`);
  const r = await answer(question, { k, format, onToken: (t) => process.stdout.write(t) });
  console.log(`\n\n(생성 ${(r.ms / 1000).toFixed(1)}초, 프롬프트 형식 ${format})`);
  printSources(r.hits, new Set(r.cited));

  if (judge) {
    console.log("\n④ 판정 중… (qwen3.5:2b 자기평가)");
    const src = r.hits.map((h) => `[${h.chunk.id}] ${h.chunk.text}`).join("\n"); // 앱과 같은 근거 문자열
    const v = await judgeWithOllama(question, src, r.text);
    console.log(`평가 ${v.score}점 · ${v.rubrics.map((x) => `${x.name} ${x.score}`).join(" · ")}${v.refusal ? " · 정당한 거부" : ""}`);
    console.log(`grounded=${v.grounded} cited=${v.cited} refusal=${v.refusal} — “${v.comment}”`);
  }
}

// 다른 파일이 answer()를 import할 때는 CLI를 돌리지 않는다
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    console.error(`\n✗ 중단: ${e.message}`);
    process.exit(1);
  }
}
