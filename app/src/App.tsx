import { useState, useRef, useEffect, type CSSProperties } from "react";
import {
  retrieve, buildPrompt, SYSTEM_MESSAGE, citedIds, refusalSignals, disclaimer, loadCorpus, onEmbedProgress, peekModelCache, WEAK_THRESHOLD,
  type Retrieved,
} from "./rag";
import { chatStream, pingOllama, judgeWithOllama, type ChatMsg } from "./ollama";
import { geminiStream, judgeTurn } from "./gemini";
import type { JudgeResult } from "./judge";
import "./App.css";

interface Turn {
  role: "user" | "assistant";
  content: string;
  sources?: Retrieved[];
  question?: string;
  judge?: JudgeResult;
  judgeBy?: "qwen3.5:2b" | "gemini-3.5-flash";
  judgeError?: boolean;
  feedback?: "up" | "down";
}

type Phase = "idle" | "embed" | "search" | "stream" | "error-ollama";

/** 답변 바로 아래 근거 문단 — 답변이 인용한 문단을 펼쳐 보여 준다 (근거 문단 먼저: PRD 2장).
 *  답변에 ID가 없으면 검색 상위 3개를 "관련될 수 있는 문단"으로, 거절 답변이면 아무것도 보이지 않는다. */
function CitedParagraphs({ answer, sources }: { answer: string; sources: Retrieved[] }) {
  const cited = citedIds(answer, sources);
  const list = cited.size ? sources.filter((s) => cited.has(s.chunk.id)) : sources.slice(0, 3);
  if (!cited.size && (refusalSignals(answer).refused || sources[0].score < WEAK_THRESHOLD)) return null;
  return (
    <div className="cited">
      <div className="cited-title">
        {cited.size ? "📚 근거 문단 — 원문으로 확인하세요" : "📚 관련될 수 있는 문단 — 답변에 근거 표시가 없어 검색 상위 문단을 보여 드립니다"}
      </div>
      {list.map((s) => (
        <div key={s.chunk.id} className="cited-row">
          <span className="cited-id">{s.chunk.id}</span>
          <span className="cited-sec">{s.chunk.section}</span>
          <a href={s.chunk.url} target="_blank" rel="noreferrer">
            {s.chunk.url.includes("kasb.or.kr") ? "기준서 원문 →" : "사내 가이드 →"}
          </a>
        </div>
      ))}
      <p className="cited-note">{disclaimer(list)}</p>
    </div>
  );
}

// 파이프라인 단계 — 튜토리얼용 표시
const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  embed: "① 질문 임베딩 중 — 브라우저에서 질문을 벡터로 바꿉니다",
  search: "② 근거 검색 중 — 벡터 유사도 상위 10개 + BM25 상위 5개, 총 15개를 찾습니다",
  stream: "③ 답변 생성 중 — 찾은 근거를 붙여 모델이 답을 씁니다",
  "error-ollama": "연결 실패",
};

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([
    {
      role: "assistant",
      content:
        "안녕하세요. K-IFRS 제1115호(고객과의 계약에서 생기는 수익) 학습 도우미입니다. 공부하다 궁금한 개념을 물어보세요. 짧게 요약하고, 근거가 된 기준서 문단을 바로 아래에 원문 링크와 함께 보여 드립니다. 실제 계약의 회계처리 판단은 하지 않습니다.",
    },
  ]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [engine, setEngine] = useState<"local" | "gemini">("local");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("gemini_key") ?? "");
  const [showSource, setShowSource] = useState<Retrieved[] | null>(null);
  const [lastHits, setLastHits] = useState<Retrieved[] | null>(null);
  const [dlPct, setDlPct] = useState<number | null>(null);
  const [judgeBusy, setJudgeBusy] = useState(false);
  const [openSrc, setOpenSrc] = useState<Record<number, boolean>>({});
  const [hitsOpen, setHitsOpen] = useState(false);
  const [embedCached, setEmbedCached] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pingOllama().then(setOllamaOk);
    loadCorpus().catch(() => undefined); // 프리로드
    peekModelCache().then(setEmbedCached); // 재방문이면 "캐시된 모델" 표시
    onEmbedProgress((p) => {
      if (p.cached) setEmbedCached(true);
      setDlPct(p.pct >= 100 ? null : p.pct);
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, phase]);

  async function ask() {
    const q = input.trim();
    if (!q || phase !== "idle") return;
    setInput("");
    setTurns((t) => [...t, { role: "user", content: q }]);

    let streamStarted = false;
    try {
      setPhase("embed");
      await new Promise((r) => setTimeout(r, 350)); // 임베딩 단계를 눈으로 볼 수 있게 짧게 표시
      setPhase("search");
      const hits = await retrieve(q, 15);
      setDlPct(null);
      setLastHits(hits);
      setHitsOpen(false);
      await new Promise((r) => setTimeout(r, 450)); // 검색 결과를 눈으로 볼 수 있게 표시
      const prompt = buildPrompt(q, hits);
      const messages: ChatMsg[] = [
        { role: "system", content: SYSTEM_MESSAGE }, // 생성 계약: src/prompt.ts
        { role: "user", content: prompt },
      ];

      const lastQ = q;
      setTurns((t) => [...t, { role: "assistant", content: "", sources: hits, question: lastQ }]);
      setPhase("stream");
      streamStarted = true;
      abortRef.current = new AbortController();
      let acc = "";
      const onPiece = (piece: string) => {
        acc += piece;
        setTurns((t) => {
          const copy = [...t];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: acc, sources: hits };
          return copy;
        });
      };
      if (engine === "gemini") {
        await geminiStream(
          [
            { role: "user", text: messages[0].content },
            { role: "user", text: messages[1].content },
          ],
          apiKey,
          onPiece,
          abortRef.current.signal,
        );
      } else {
        await chatStream(messages, onPiece, "qwen3.5:2b", abortRef.current.signal);
      }
      setPhase("idle");
      // ④ LLM-as-a-Judge — 답변에 쓴 엔진과 같은 모델이 판정한다
      //    로컬 → qwen 자기평가(API 키 불필요), gemini → gemini-3.5-flash
      setJudgeBusy(true);
      try {
        const src = hits.map((h) => `[${h.chunk.id}] ${h.chunk.text}`).join("\n");
        const by = engine === "gemini" && apiKey ? "gemini-3.5-flash" as const : "qwen3.5:2b" as const;
        const verdict =
          engine === "gemini" && apiKey
            ? await judgeTurn(lastQ, src, acc, apiKey)
            : await judgeWithOllama(lastQ, src, acc);
        setTurns((t) => {
          const copy = [...t];
          const li = copy.length - 1;
          copy[li] = { ...copy[li], judge: verdict, judgeBy: by };
          return copy;
        });
      } catch {
        // 판정 실패가 답변을 해치지 않게 배지만 단다
        setTurns((t) => {
          const copy = [...t];
          const li = copy.length - 1;
          copy[li] = { ...copy[li], judgeError: true };
          return copy;
        });
      } finally {
        setJudgeBusy(false);
      }
    } catch (e: unknown) {
      console.error("챗봇 파이프라인 오류:", e);
      setDlPct(null);
      const msg = e instanceof Error ? e.message : String(e);
      if (!streamStarted) {
        // 검색/임베딩 단계 오류 — 원인을 채팅창에 그대로 보여준다 (ollama와 무관)
        setTurns((t) => [
          ...t.filter((x) => x.content !== ""),
          { role: "assistant", content: `⚠ 답변을 만들지 못했습니다 — ${msg}` },
        ]);
        setPhase("idle");
        return;
      }
      setPhase("error-ollama");
      setOllamaOk(false);
      setTurns((t) => [
        ...t.filter((x) => x.content !== ""),
        { role: "assistant", content: "⚠ 로컬 모델(ollama)에 연결하지 못했습니다 — 페이지 위 안내를 따라 ollama를 실행·설정한 뒤 다시 질문해 주세요." },
      ]);
      setPhase("idle");
    }
  }

  function stop() {
    abortRef.current?.abort();
    setPhase("idle");
  }

  function setFeedback(i: number, v: "up" | "down") {
    setTurns((t) => {
      const copy = [...t];
      copy[i] = { ...copy[i], feedback: copy[i].feedback === v ? undefined : v };
      return copy;
    });
    // 피드백은 로컬에만 기록 (제출 없음 — 데모)
    console.log("feedback", { turn: i, value: v });
  }

  const nBm = lastHits ? lastHits.filter((h) => h.method === "bm25").length : 0;

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-inner">
          <p className="hero-badge">회계 학습자를 위한 기준서 학습 · 문단 찾기 도우미</p>
          <h1>K-IFRS 1115 <span className="accent">수익인식</span></h1>
          <p className="hero-sub">
            수백 문단짜리 기준서에서 "계약부채가 뭐지?", "본인과 대리인은 어떻게 구분하지?"의 답이 있는
            문단을 찾기 어려우셨나요? 질문하면 짧게 요약하고, 근거가 된 기준서 문단을 원문 링크와 함께
            바로 보여 드립니다. 공부를 돕는 도구이며, 실제 계약의 회계처리를 판단하지는 않습니다.
          </p>
          <a className="hero-cta" href="#chat">질문하고 문단 찾기 ↓</a>
        </div>
      </header>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[0, 1].map((g) => (
            <div className="marquee-group" key={g}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i}>IDENTIFY · ALLOCATE · RECOGNIZE <i>5</i></span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <section className="engine">
        <div className="engine-row">
          <span>답변 엔진:</span>
          <label><input type="radio" checked={engine==="local"} onChange={()=>setEngine("local")} /> 로컬 ollama (qwen3.5:2b)</label>
          <label><input type="radio" checked={engine==="gemini"} onChange={()=>setEngine("gemini")} /> Gemini API</label>
        </div>
        {engine === "gemini" && (
          <div className="engine-row">
            <input
              type="password"
              placeholder="Gemini API 키 (브라우저에만 저장됩니다)"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); localStorage.setItem("gemini_key", e.target.value); }}
            />
          </div>
        )}
      </section>

      {ollamaOk === false && engine === "local" && (
        <div className="banner">
          <strong>로컬 모델(ollama)에 연결할 수 없습니다.</strong>
          <ol>
            <li>브라우저 확인 — Safari는 이 페이지(https)에서 로컬 ollama 호출을 차단하므로 Chrome·Edge를 사용하세요. Chrome에서 "로컬 네트워크" 접근 권한을 물으면 <strong>허용</strong>을 누릅니다.</li>
            <li><code>ollama serve</code> 실행 (또는 Ollama 앱 실행) · 모델 확인: <code>ollama pull qwen3.5:2b</code></li>
            <li>
              github.io에서 열었다면 CORS 허용 — 운영 체제별로 한 번만 설정하고 Ollama를 재시작합니다:
              <div className="os-guide">
                <div><strong>macOS</strong><code>launchctl setenv OLLAMA_ORIGINS "https://*.github.io"</code>입력 후 메뉴 막대의 Ollama 앱을 종료하고 다시 실행합니다.</div>
                <div><strong>Windows</strong>작업 표시줄에서 Ollama를 종료합니다. 설정에서 <code>환경 변수</code>를 검색해 <code>계정의 환경 변수 편집</code>을 열고 새 변수 <code>OLLAMA_ORIGINS</code>에 <code>https://*.github.io</code>를 넣은 뒤 Ollama를 다시 시작합니다.</div>
                <div><strong>Linux</strong><code>sudo systemctl edit ollama.service</code>를 열어 <code>[Service]</code> 아래에 <code>Environment="OLLAMA_ORIGINS=https://*.github.io"</code>를 추가하고 <code>sudo systemctl restart ollama</code>로 재시작합니다.</div>
              </div>
            </li>
          </ol>
          <button onClick={() => pingOllama().then(setOllamaOk)}>다시 확인</button>
        </div>
      )}

      <section className="info">
        <div className="card card-a">
          <h2>공부할 수 있는 범위</h2>
          <p>
            K-IFRS 제1115호의 핵심 원칙, 수익인식 5단계(계약 식별 → 수행의무 식별 → 거래가격 산정 →
            배분 → 수행의무 이행)와 계약변경·진행률·변동대가·금융요소·계약원가·반품권·보증·본인 대
            대리인, 계약자산·계약부채 용어. 다른 기준서, 세무, 주가는 다루지 않고, 개별 계약의 회계처리는
            판단하지 않습니다.
          </p>
        </div>
        <div className="card card-b">
          <h2>근거 문단 먼저</h2>
          <p>
            답변 바로 아래에 근거가 된 기준서 문단(문단 번호·원문 링크)이 펼쳐져 나옵니다. 요약보다
            원문이 정확하니, 링크를 열어 원문으로 공부하세요. 자료는 한국회계기준원 회계기준열람서비스의
            기준서를 직접 요약한 것과 교육용 사내 가이드이며, 자료에 없으면 없다고 답합니다. 기준서 원문은
            저작권(IFRS 재단)이 있어 옮기지 않고 요약했습니다.
          </p>
        </div>
        <div className="card card-c">
          <h2>실행 구조</h2>
          <p>
            브라우저가 직접 로컬 ollama 모델(qwen3.5:2b)을 호출하고, 질문 임베딩도
            브라우저에서 실행합니다. Gemini API 키를 넣으면 Gemini이 답변을 만듭니다.
          </p>
        </div>
      </section>

      <section id="chat" className="chat">
        <h2>
          K-IFRS 1115 학습 도우미
          <span className={`conn ${ollamaOk === true ? "ok" : ollamaOk === false ? "bad" : ""}`}>
            {engine === "gemini"
              ? "Gemini API"
              : ollamaOk === true
                ? "ollama 연결됨"
                : ollamaOk === false
                  ? "ollama 미연결"
                  : "연결 확인 중…"}
          </span>
        </h2>
        <div className="chat-log">
          {turns.map((t, i) => (
            <div key={i} className={`bubble ${t.role}`}>
              <div className="bubble-text">{t.content || (phase === "stream" && i === turns.length - 1 ? "…" : "")}</div>
              {t.role === "assistant" && t.question && (
                <div className="meta-row">
                  {t.judge ? (
                    <span className={`judge ${(t.judge.score ?? 0) >= 70 ? "ok" : "bad"}`}>
                      평가 {t.judge.score}점 (루브릭 평균) ·
                      {(t.judge.rubrics ?? []).map((r) => ` ${r.name} ${r.score}`).join(" ·")}
                      {t.judge.refusal ? " · 정당한 거부" : ""}
                      {t.judge.comment && <em> “{t.judge.comment}”</em>}
                      <span className="judge-by"> · 판정 {t.judgeBy === "gemini-3.5-flash" ? "gemini-3.5-flash" : "qwen3.5:2b 자기평가"}</span>
                    </span>
                  ) : t.judgeError ? (
                    <span className="judge fail">판정 실패 — 평가 모델이 결과를 만들지 못했습니다 (답변은 정상)</span>
                  ) : judgeBusy && i === turns.length - 1 ? (
                    <span className="judge">④ 판정 중… (LLM-as-a-Judge)</span>
                  ) : null}
                  <span className="feedback">
                    <button aria-label="좋아요" className={t.feedback === "up" ? "on" : ""} onClick={() => setFeedback(i, "up")}>👍</button>
                    <button aria-label="싫어요" className={t.feedback === "down" ? "on" : ""} onClick={() => setFeedback(i, "down")}>👎</button>
                  </span>
                </div>
              )}
              {t.sources && t.content && !(phase === "stream" && i === turns.length - 1) && (
                <CitedParagraphs answer={t.content} sources={t.sources} />
              )}
              {t.sources && !(phase === "stream" && i === turns.length - 1) && (
                <div className="chips">
                  <button
                    className="chips-toggle"
                    onClick={() => setOpenSrc((m) => ({ ...m, [i]: !m[i] }))}
                  >
                    출처 {t.sources.length}개 · 답변에 인용 {citedIds(t.content, t.sources).size}개{" "}
                    {openSrc[i] ? "접기 ▴" : "펼쳐 보기 ▾"}
                  </button>
                  {t.sources[0].score < WEAK_THRESHOLD && (
                    <span className="weak-badge">⚠ 최고 유사도 {(t.sources[0].score * 100).toFixed(1)}%</span>
                  )}
                  {openSrc[i] &&
                    t.sources.map((s) => (
                      <button
                        key={s.chunk.id}
                        className={`chip ${s.method === "bm25" ? "bm25" : "vec"}`}
                        onClick={() => setShowSource(t.sources!)}
                      >
                        {/* ✓ = 답변에 이 ID가 실제로 적혔다 (LLM이 아니라 프로그램이 확인) */}
                        {citedIds(t.content, t.sources!).has(s.chunk.id) ? "✓ " : ""}
                        {s.chunk.id} · {s.chunk.section} · {s.method === "bm25" ? "BM25" : "벡터"} {(s.score * 100).toFixed(0)}%
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}
          {(phase === "embed" || phase === "search") && (
            <div className="phase-box">
              <span className="spinner" />
              <span>
                {phase === "embed" && embedCached
                  ? "① 질문 임베딩 중 — 캐시된 모델 사용 (다운로드 없음)"
                  : PHASE_LABEL[phase]}
                {dlPct !== null && (
                  <div className="dl-progress">
                    임베딩 모델을 내려받는 중 {dlPct}% — 첫 방문 1회(약 200MB), 이후 브라우저에 캐시됩니다
                  </div>
                )}
              </span>
            </div>
          )}
          {lastHits && phase === "stream" && (
            <div className="hits-box">
              <div className="hits-title">
                <button className="chips-toggle" onClick={() => setHitsOpen((o) => !o)}>
                  ② 검색된 근거 {lastHits.length}개 — 벡터 {lastHits.length - nBm} · BM25 {nBm}{" "}
                  {hitsOpen ? "접기 ▴" : "펼쳐 보기 ▾"}
                </button>
                {lastHits[0].score < WEAK_THRESHOLD && (
                  <span className="weak-badge"> ⚠ 최고 유사도 {(lastHits[0].score * 100).toFixed(1)}% — 근거가 약합니다</span>
                )}
              </div>
              {hitsOpen &&
                lastHits.map((h) => (
                  <div key={h.chunk.id} className={`hit-row ${h.method === "bm25" ? "bm25" : "vec"}`}>
                    <span className="hit-id">{h.chunk.id}</span>
                    <span className="hit-sec">{h.chunk.section}</span>
                    <span className="hit-score" style={{ "--w": `${Math.round(h.score * 100)}%` } as CSSProperties}>
                      {h.method === "bm25" ? "BM25" : "벡터"} {(h.score * 100).toFixed(1)}%
                    </span>
                    <span className="hit-text">{h.chunk.text.slice(0, 80)}…</span>
                  </div>
                ))}
              {phase === "stream" && (
                <div className="hits-title" style={{ marginTop: hitsOpen ? ".6rem" : undefined }}>③ 이 근거로 답변을 만듭니다…</div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="chat-input">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="예: 계약부채가 뭐야? / 본인과 대리인은 어떻게 구분해?"
            disabled={phase !== "idle"}
          />
          {phase === "stream" ? (
            <button onClick={stop} className="stop-btn">정지</button>
          ) : (
            <button onClick={ask} disabled={phase !== "idle" || !input.trim()}>
              보내기
            </button>
          )}
        </div>
      </section>

      {showSource && (
        <div className="modal" onClick={() => setShowSource(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <h3>근거 조각</h3>
            {showSource.map((s) => (
              <div key={s.chunk.id} className="source-item">
                <div className="source-meta">
                  {s.chunk.id} · {s.chunk.section} · {s.method === "bm25" ? "BM25" : "벡터 유사도"} {(s.score * 100).toFixed(0)}%
                </div>
                <p>{s.chunk.text}</p>
                <a href={s.chunk.url} target="_blank" rel="noreferrer">
                  {s.chunk.url.includes("kasb.or.kr") ? "기준서 원문 보기 (한국회계기준원) →" : "사내 가이드 원문 보기 →"}
                </a>
              </div>
            ))}
            <button onClick={() => setShowSource(null)}>닫기</button>
          </div>
        </div>
      )}

      <footer className="footer">
        <p>
          K-IFRS 1115 학습 도우미 — 공부를 돕는 교육용 데모이며, 회계 자문이나 실제 회계처리 판단을 대신하지 않습니다.
          모델: qwen3.5:2b (ollama) · 임베딩: embeddinggemma-300m (브라우저).
        </p>
        <p>
          자료: 한국회계기준원 회계기준열람서비스의 K-IFRS 제1115호를 직접 요약. 기준서 원문의 저작권은
          IFRS 재단에 있습니다 (<a href="https://db.kasb.or.kr/s/1115/copyright" target="_blank" rel="noreferrer">저작권 고지</a>).
        </p>
      </footer>
    </div>
  );
}
