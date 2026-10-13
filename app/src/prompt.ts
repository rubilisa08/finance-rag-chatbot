// 생성 계약 — 브라우저(App.tsx)와 Node(scripts/ask.mjs)가 함께 쓰는 시스템 메시지·프롬프트 조립
// (Node가 이 .ts 파일을 직접 읽으므로 타입 표기 외의 TS 전용 문법은 쓰지 않는다)
//
// 프롬프트 형식은 버전으로 관리한다. 바꿀 때는 README 실험으로 전후를 비교하고 PROMPT_FORMAT을 옮긴다.
//   v1 — 모두콘 구조 그대로: 자료 줄 "[ID | 섹션] 본문", 출처 규칙 "[ID]를 답 안에서 표시"
//   v2 — 튜토리얼 STEP 6 형식: 자료 줄 "[ID] (섹션) 본문", 출처 규칙에 실제 모양([IFRS-014]) + 질문 뒤에 한 번 더

import { isWeak, type Retrieved } from "./search-core.ts";

export type PromptFormat = "v1" | "v2";
/** 앱과 ask.mjs가 기본으로 쓰는 형식 */
export const PROMPT_FORMAT: PromptFormat = "v1";

// 시스템 메시지 — 챗봇의 역할과 경계 (제품 결정: PRD 1·3·5장)
const SYSTEM_BASE = [
  "당신은 K-IFRS 제1115호 '고객과의 계약에서 생기는 수익' 안내 도우미이며, 사용자는 회계팀 신입과 회계 학습자입니다.",
  "주어진 자료에 근거한 내용만 답하고, 자료에 없는 정보는 '제가 가진 자료에는 없습니다'라고 답합니다.",
  "{CITE}",
  "주가 전망, 세무(절세·신고), 투자처럼 회계기준과 무관한 질문에는 '본 챗봇은 K-IFRS 제1115호 회계기준 범위 내의 질문에만 답변할 수 있습니다'라고만 답합니다.",
  "리스, 금융상품처럼 제1115호가 아닌 기준서에 관한 질문에는 제가 가진 자료의 범위 밖이라 답할 수 없다고 밝히고, 해당 기준서 원문을 확인하도록 안내합니다.",
  "특정 회사나 계약의 회계처리를 묻는 질문에는 결론을 내리지 않고, 판단에 필요한 기준서 원칙만 {CITE_INLINE} 설명한 뒤 '실제 회계처리는 회계 담당자나 감사인과 확인하세요'라고 덧붙입니다.",
].join(" ");

const CITE = {
  v1: { system: "근거 조각의 [ID]를 답에 표시합니다.", inline: "근거 [ID]와 함께", rule: "근거가 된 조각의 [ID]를 답 안에서 표시합니다." },
  v2: {
    system: "근거 조각의 ID만 [IFRS-014]처럼 대괄호로 감싸 해당 문장 끝에 표시합니다.",
    inline: "근거 ID와 함께",
    rule: "근거가 된 조각의 ID만 [IFRS-014]처럼 대괄호로 감싸 해당 문장 끝에 표시합니다.",
  },
} as const;

export function systemMessage(format: PromptFormat = PROMPT_FORMAT): string {
  return SYSTEM_BASE.replace("{CITE}", CITE[format].system).replace("{CITE_INLINE}", CITE[format].inline);
}

/** 앱 기본 형식의 시스템 메시지 */
export const SYSTEM_MESSAGE = systemMessage();

/** 사용자 메시지(프롬프트) 조립 — ① 자료 소개 ② 근거 원칙 ③ 출처 규칙 ④ KST 시각 ⑤ [자료] ⑥ [질문] (⑦ v2만: 출처 규칙 한 번 더) */
export function buildPrompt(question: string, hits: Retrieved[], format: PromptFormat = PROMPT_FORMAT): string {
  const now = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "long", day: "numeric", weekday: "long",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date());
  const context = hits
    .map((h) =>
      format === "v1"
        ? `[${h.chunk.id} | ${h.chunk.section}] ${h.chunk.text}`
        : `[${h.chunk.id}] (${h.chunk.section}) ${h.chunk.text}`,
    )
    .join("\n\n");
  const weakNote = isWeak(hits)
    ? "주의: 검색된 조각의 유사도가 낮습니다. 질문과 완전히 맞는 근거가 아닐 수 있으니, 근거에 있는 내용만 짧게 답하고 자료에 없는 부분은 없다고 말합니다."
    : "자료에 근거한 내용만 답하고, 자료에 없으면 없다고 말합니다.";
  const lines = [
    "다음 자료는 K-IFRS 제1115호 '고객과의 계약에서 생기는 수익' 기준서를 요약한 조각과, 섹션 이름이 '교육용 사내 가이드'로 시작하는 사내 절차 조각입니다. 기준서 조각 끝의 괄호는 기준서 문단 번호입니다.",
    weakNote,
    CITE[format].rule,
    `현재 시각은 ${now}(한국 표준시 KST)입니다. '지금', '올해', '다음 주' 같은 상대 표현은 이 시각을 기준으로 해석합니다.`,
    "",
    "[자료]",
    context,
    "",
    "[질문]",
    question,
  ];
  if (format === "v2") lines.push("", "(답할 때 근거로 쓴 자료의 ID를 [IFRS-014]처럼 문장 끝에 붙입니다.)");
  return lines.join("\n");
}

/** 답변에 실제로 적힌 근거 ID — 출처 목록의 ✓ 표시용 (근거 표시는 LLM에 맡기지 않고 프로그램이 확인) */
export function citedIds(answer: string, hits: Retrieved[]): Set<string> {
  return new Set(hits.map((h) => h.chunk.id).filter((id) => answer.includes(id)));
}
