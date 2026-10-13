// 실험용 일괄 실행 — 질문 목록을 같은 조건으로 돌려 답변 원문과 측정값을 파일로 남긴다
// 실패한 답도 지우지 않고 그대로 기록한다 (README 실험 기록의 근거).
//
// 사용법 (app 폴더에서):
//   node scripts/run-questions.mjs --name exp3-v1 --format v1 [--questions ../data/fixed-questions.json] [--judge]
//   → ../experiments/<name>.json

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { answer, checkOllama } from "./ask.mjs";
import { judgeWithOllama } from "../src/ollama.ts";
import { PROMPT_FORMAT, PROMPT_FORMATS } from "../src/prompt.ts";

const OUT_DIR = fileURLToPath(new URL("../../experiments/", import.meta.url));
const DEFAULT_QUESTIONS = fileURLToPath(new URL("../../data/fixed-questions.json", import.meta.url));

/** 답변에서 출처 표시 모양을 측정 */
function measure(r) {
  const allIds = [...r.text.matchAll(/IFRS-\d{3}/g)].map((m) => m[0]);
  const given = new Set(r.hits.map((h) => h.chunk.id));
  return {
    cited: r.cited.length > 0,                                  // 넘긴 근거의 ID가 하나라도 적혔나
    citedIds: r.cited,
    unknownIds: [...new Set(allIds.filter((id) => !given.has(id)))], // 넘기지 않은 ID를 지어냈나
    literalIdPlaceholder: r.text.includes("[ID]"),               // "[ID]"라는 글자를 그대로 썼나
    copiedHeader: /\[IFRS-\d{3}\s*\|/.test(r.text),              // "[IFRS-014 | 섹션]" 머리를 베꼈나
    chars: r.text.length,
  };
}

async function main(argv) {
  let name = null, format = PROMPT_FORMAT, qPath = DEFAULT_QUESTIONS, judge = false, k = 15;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i];
    else if (argv[i] === "--format") format = argv[++i];
    else if (argv[i] === "--questions") qPath = argv[++i];
    else if (argv[i] === "--judge") judge = true;
    else if (argv[i] === "--k") k = Number(argv[++i]);
  }
  if (!name || !PROMPT_FORMATS.includes(format)) {
    console.error("사용법: node scripts/run-questions.mjs --name <실험이름> --format v1|v2|v3 [--questions 파일] [--judge] [--k 15]");
    process.exit(1);
  }
  if (!(await checkOllama())) process.exit(1);
  const questions = JSON.parse(await readFile(qPath, "utf8"));
  await mkdir(OUT_DIR, { recursive: true });
  const outPath = `${OUT_DIR}${name}.json`;
  const results = [];
  for (const [i, q] of questions.entries()) {
    const r = await answer(q.question, { k, format });
    const row = {
      type: q.type, question: q.question, expect: q.expect ?? null,
      top1: `${r.hits[0].chunk.id} ${r.hits[0].score.toFixed(3)}`,
      ...measure(r), seconds: +(r.ms / 1000).toFixed(1), answer: r.text,
    };
    if (judge) {
      const src = r.hits.map((h) => `[${h.chunk.id}] ${h.chunk.text}`).join("\n");
      try {
        const v = await judgeWithOllama(q.question, src, r.text);
        row.judge = { score: v.score, grounded: v.grounded, noHalluc: v.noHalluc, cited: v.cited, refusal: v.refusal, comment: v.comment };
      } catch (e) {
        row.judge = { error: e.message };
      }
    }
    results.push(row);
    // 중간에 멈춰도 그때까지의 결과가 남도록 매 질문마다 저장
    await writeFile(outPath, JSON.stringify({ name, format, k, model: "qwen3.5:2b", temperature: 0, runAt: new Date().toISOString(), results }, null, 2) + "\n");
    console.log(`[${i + 1}/${questions.length}] ${q.question} — ${row.seconds}초, cited=${row.cited} (${row.citedIds.join(",") || "-"}), [ID]글자=${row.literalIdPlaceholder}, 머리베낌=${row.copiedHeader}${row.judge ? `, 판정 ${row.judge.score ?? "실패"}` : ""}`);
  }
  console.log(`저장: ${outPath}`);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  console.error(`✗ 중단: ${e.message}`);
  process.exit(1);
}
