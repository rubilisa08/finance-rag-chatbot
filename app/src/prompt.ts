// 생성 계약 — 브라우저(App.tsx)와 Node(scripts/ask.mjs)가 함께 쓰는 시스템 메시지·프롬프트 조립
// (Node가 이 .ts 파일을 직접 읽으므로 타입 표기 외의 TS 전용 문법은 쓰지 않는다)
//
// 프롬프트 형식은 버전으로 관리한다. 바꿀 때는 README 실험으로 전후를 비교하고 PROMPT_FORMAT을 옮긴다.
//   v1 — 모두콘 구조 그대로: 자료 줄 "[ID | 섹션] 본문", 출처 규칙 "[ID]를 답 안에서 표시"
//   v2 — 튜토리얼 STEP 6 형식: 자료 줄 "[ID] (섹션) 본문", 출처 규칙에 실제 모양([IFRS-014]) + 질문 뒤에 한 번 더
//   v3 — v2와 같되 출처 예시 ID를 고정값 대신 이번 질문의 검색 1위 ID로 (README 실험 3: v2는 예시 ID를 그대로 베껴
//        넘기지도 않은 청크를 인용함). 시스템 메시지에는 특정 ID 예시를 넣지 않는다.
//   v4 — v3과 출처 형식은 같고, 시스템 메시지만 "학습·문단 찾기 도우미"로 (README 실험 5: 사용자를 회계 학습자로
//        좁히고, 짧게 요약한 뒤 근거 문단을 안내하는 답변 방식)

import { isWeak, type Retrieved } from "./search-core.ts";

export type PromptFormat = "v1" | "v2" | "v3" | "v4";
export const PROMPT_FORMATS: PromptFormat[] = ["v1", "v2", "v3", "v4"];
/** 앱과 ask.mjs가 기본으로 쓰는 형식 — README 실험 3에서 v3 채택 (머리 베낌·가짜 ID·잘못된 거절 0건) */
export const PROMPT_FORMAT: PromptFormat = "v3";

// 시스템 메시지 — 챗봇의 역할과 경계 (제품 결정: PRD 1·3·5장)
// v4: 학습·문단 찾기 도우미 (PRD v2)
const SYSTEM_STUDY = [
  "당신은 K-IFRS 제1115호 '고객과의 계약에서 생기는 수익'을 공부하는 회계 학습자를 돕는 기준서 학습·문단 찾기 도우미입니다.",
  "질문과 관련된 기준서 내용을 주어진 자료에서 찾아 2~4문장으로 짧게 요약하고, 근거가 된 자료를 안내합니다.",
  "주어진 자료에 근거한 내용만 답하고, 자료에 없는 정보는 '제가 가진 자료에는 없습니다'라고 답합니다.",
  "{CITE}",
  "주가 전망, 세무(절세·신고), 투자처럼 회계기준과 무관한 질문에는 '본 챗봇은 K-IFRS 제1115호 회계기준 범위 내의 질문에만 답변할 수 있습니다'라고만 답합니다.",
  "리스, 금융상품처럼 제1115호가 아닌 기준서에 관한 질문에는 제가 가진 자료의 범위 밖이라 답할 수 없다고 밝히고, 해당 기준서 원문을 확인하도록 안내합니다.",
  "특정 회사나 계약의 회계처리를 묻는 질문에는 학습용 도우미이므로 결론을 내리지 않고, 관련 기준서 원칙만 {CITE_INLINE} 짧게 설명한 뒤 '실제 회계처리는 회계 담당자나 감사인과 확인하세요'라고 덧붙입니다.",
].join(" ");

// v1~v3: 안내 도우미 (PRD v1)
const SYSTEM_BASE = [
  "당신은 K-IFRS 제1115호 '고객과의 계약에서 생기는 수익' 안내 도우미이며, 사용자는 회계팀 신입과 회계 학습자입니다.",
  "주어진 자료에 근거한 내용만 답하고, 자료에 없는 정보는 '제가 가진 자료에는 없습니다'라고 답합니다.",
  "{CITE}",
  "주가 전망, 세무(절세·신고), 투자처럼 회계기준과 무관한 질문에는 '본 챗봇은 K-IFRS 제1115호 회계기준 범위 내의 질문에만 답변할 수 있습니다'라고만 답합니다.",
  "리스, 금융상품처럼 제1115호가 아닌 기준서에 관한 질문에는 제가 가진 자료의 범위 밖이라 답할 수 없다고 밝히고, 해당 기준서 원문을 확인하도록 안내합니다.",
  "특정 회사나 계약의 회계처리를 묻는 질문에는 결론을 내리지 않고, 판단에 필요한 기준서 원칙만 {CITE_INLINE} 설명한 뒤 '실제 회계처리는 회계 담당자나 감사인과 확인하세요'라고 덧붙입니다.",
].join(" ");

// {EX}는 출처 예시 ID 자리 — v1·v2는 고정값, v3은 buildPrompt가 검색 1위 ID로 채운다
const CITE = {
  v1: { system: "근거 조각의 [ID]를 답에 표시합니다.", inline: "근거 [ID]와 함께", rule: "근거가 된 조각의 [ID]를 답 안에서 표시합니다.", tail: "" },
  v2: {
    system: "근거 조각의 ID만 [IFRS-014]처럼 대괄호로 감싸 해당 문장 끝에 표시합니다.",
    inline: "근거 ID와 함께",
    rule: "근거가 된 조각의 ID만 [IFRS-014]처럼 대괄호로 감싸 해당 문장 끝에 표시합니다.",
    tail: "(답할 때 근거로 쓴 자료의 ID를 [IFRS-014]처럼 문장 끝에 붙입니다.)",
  },
  v3: {
    system: "근거 조각의 ID만 대괄호로 감싸 해당 문장 끝에 표시합니다.",
    inline: "근거 ID와 함께",
    rule: "근거가 된 조각의 ID만 [{EX}]처럼 대괄호로 감싸 해당 문장 끝에 표시합니다.",
    tail: "(답할 때 근거로 쓴 자료의 ID를 [{EX}]처럼 문장 끝에 붙입니다.)",
  },
  v4: {
    system: "근거 조각의 ID만 대괄호로 감싸 해당 문장 끝에 표시합니다.",
    inline: "근거 ID와 함께",
    rule: "근거가 된 조각의 ID만 [{EX}]처럼 대괄호로 감싸 해당 문장 끝에 표시합니다.",
    tail: "(답할 때 근거로 쓴 자료의 ID를 [{EX}]처럼 문장 끝에 붙입니다.)",
  },
} as const;

export function systemMessage(format: PromptFormat = PROMPT_FORMAT): string {
  const base = format === "v4" ? SYSTEM_STUDY : SYSTEM_BASE;
  return base.replace("{CITE}", CITE[format].system).replace("{CITE_INLINE}", CITE[format].inline);
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
  const ex = hits[0]?.chunk.id ?? "IFRS-001"; // v3 출처 예시 = 이번 질문의 검색 1위
  const fill = (s: string) => s.replaceAll("{EX}", ex);
  const weakNote = isWeak(hits)
    ? "주의: 검색된 조각의 유사도가 낮습니다. 질문과 완전히 맞는 근거가 아닐 수 있으니, 근거에 있는 내용만 짧게 답하고 자료에 없는 부분은 없다고 말합니다."
    : "자료에 근거한 내용만 답하고, 자료에 없으면 없다고 말합니다.";
  const lines = [
    "다음 자료는 K-IFRS 제1115호 '고객과의 계약에서 생기는 수익' 기준서를 요약한 조각과, 섹션 이름이 '교육용 사내 가이드'로 시작하는 사내 절차 조각입니다. 기준서 조각 끝의 괄호는 기준서 문단 번호입니다.",
    weakNote,
    fill(CITE[format].rule),
    `현재 시각은 ${now}(한국 표준시 KST)입니다. '지금', '올해', '다음 주' 같은 상대 표현은 이 시각을 기준으로 해석합니다.`,
    "",
    "[자료]",
    context,
    "",
    "[질문]",
    question,
  ];
  if (CITE[format].tail) lines.push("", fill(CITE[format].tail));
  return lines.join("\n");
}

/** 답변이 거절·범위 밖 안내를 했는지 — 시스템 메시지에 정한 문구 기준 (화면의 근거 문단 표시와 실험 측정이 함께 씀) */
export function refusalSignals(text: string): { refused: boolean; scopeRefusal: boolean; noData: boolean; expertAdvice: boolean } {
  const scopeRefusal = /범위 내의 질문에만 답변/.test(text); // 도메인 밖 고정 문구
  const noData = /자료에는 없|자료에 없|자료의 범위 밖|답할 수 없|명시되어 있지 않/.test(text); // 근거 부족·다른 기준서
  const expertAdvice = /감사인과 확인|회계 담당자나 감사인/.test(text); // 사례 판단 안내
  return { refused: scopeRefusal || noData, scopeRefusal, noData, expertAdvice };
}

/** 답변 아래 면책 문구 — LLM이 아니라 프로그램이 근거 청크의 section에서 문단 번호를 뽑아 만든다 (빠뜨리거나 틀릴 일이 없게) */
export function disclaimer(sources: Retrieved[]): string {
  const paras = sources
    .filter((s) => s.chunk.url.includes("kasb.or.kr"))
    .map((s) => s.chunk.section.match(/\(([^()]*(?:문단|부록)[^()]*)\)\s*$/)?.[1])
    .filter((p): p is string => !!p);
  const hasGuide = sources.some((s) => !s.chunk.url.includes("kasb.or.kr"));
  const basis = [
    paras.length ? `K-IFRS 제1115호 기준서 요약(${[...new Set(paras)].join(", ")})` : "",
    hasGuide ? "교육용 사내 가이드(가상 예시)" : "",
  ].filter(Boolean).join(" 및 ");
  const check = paras.length
    ? "저작권 때문에 기준서 원문 대신 직접 쓴 요약을 쓰므로 정확한 표현은 원문 링크에서 확인하고, "
    : "";
  return `본 답변은 ${basis || "기준서 요약 자료"}에 기초한 학습용 참고 자료입니다. ${check}실제 회계처리는 작성자와 감사인의 판단이 필요합니다.`;
}

/** 답변에 실제로 적힌 근거 ID — 출처 목록의 ✓ 표시용 (근거 표시는 LLM에 맡기지 않고 프로그램이 확인) */
export function citedIds(answer: string, hits: Retrieved[]): Set<string> {
  return new Set(hits.map((h) => h.chunk.id).filter((id) => answer.includes(id)));
}
