import { useEffect, useRef, useState } from "react";
import type { FormEvent, MutableRefObject } from "react";

interface EvidenceRow {
  content: string;
  source: string;
  sourceId: string;
  title: string | null;
  url: string;
  score: number;
  recency: string | null;
  tool: string;
}
interface PlanStage {
  tools: { name: string; query: string }[];
  reasoning: string;
  fallback: boolean;
}
interface EvidenceStage {
  tool: string;
  rows: EvidenceRow[];
}

type Stage =
  | { kind: "plan"; plan: PlanStage }
  | { kind: "evidence"; tool: string; rows: EvidenceRow[] }
  | { kind: "answer"; text: string };

interface Project {
  sourceId: string;
  title: string | null;
}

const SOURCE_BADGE: Record<string, string> = {
  confluence: "co",
  jira: "ji",
  github: "gh",
  bucket: "bu",
  people: "pe",
};

function badgeFor(source: string): string {
  return SOURCE_BADGE[source] ?? source.slice(0, 2);
}

// Flat, numbered, de-duped evidence list in arrival order, mirroring
// askStream's `source:sourceId` dedupe so `[n]` in the answer lines up
// with the same row the synthesis prompt cited. `citations` maps each
// key to its 1-based number; a row missing from the map is a duplicate
// of an earlier row (possible when the plan picks overlapping tools,
// e.g. "search" plus "search_confluence") and carries no citation of
// its own.
function numberEvidence(stages: Stage[]): {
  numbered: EvidenceRow[];
  citations: Map<string, number>;
} {
  const citations = new Map<string, number>();
  const numbered: EvidenceRow[] = [];
  for (const stage of stages) {
    if (stage.kind !== "evidence") continue;
    for (const row of stage.rows) {
      const key = `${row.source}:${row.sourceId}`;
      if (citations.has(key)) continue;
      numbered.push(row);
      citations.set(key, numbered.length);
    }
  }
  return { numbered, citations };
}

function SkeletonBars() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800"
          style={{ width: `${90 - i * 15}%` }}
        />
      ))}
    </div>
  );
}

function PlanCard({ plan }: { plan: PlanStage }) {
  return (
    <div className="stage-enter rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Plan
      </h2>
      <ul className="mt-3 space-y-1.5">
        {plan.tools.map((t, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-2">
            <span className="rounded bg-zinc-100 px-1.5 font-mono text-sm dark:bg-zinc-800">
              {t.name}
            </span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              {t.query}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
        {plan.reasoning}
        {plan.fallback && (
          <span className="ml-1 text-zinc-400 dark:text-zinc-500">
            (fallback)
          </span>
        )}
      </p>
    </div>
  );
}

function EvidenceCard({
  stage,
  citations,
  rowRefs,
  flashed,
}: {
  stage: EvidenceStage;
  citations: Map<string, number>;
  rowRefs: MutableRefObject<Map<number, HTMLElement | null>>;
  flashed: Set<number>;
}) {
  return (
    <div className="stage-enter rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {stage.tool}
      </h2>
      <ul className="mt-3 space-y-3">
        {stage.rows.map((row) => {
          const key = `${row.source}:${row.sourceId}`;
          const n = citations.get(key);
          return (
            <li
              key={key}
              ref={(el) => {
                if (n !== undefined) rowRefs.current.set(n, el);
              }}
              className={
                "rounded-md p-2" +
                (n !== undefined && flashed.has(n) ? " evidence-flash" : "")
              }
            >
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {badgeFor(row.source)}
                </span>
                <span className="font-medium">{row.title ?? row.sourceId}</span>
                <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
                  {row.sourceId}
                </span>
                {row.recency && (
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">
                    {row.recency}
                  </span>
                )}
              </div>
              <details className="mt-1">
                <summary
                  className={
                    "cursor-pointer text-sm text-zinc-600 dark:text-zinc-400" +
                    (row.source === "github" ? " font-mono text-xs" : "")
                  }
                >
                  {row.content.slice(0, 160)}
                  {row.content.length > 160 ? "…" : ""}
                </summary>
                <p
                  className={
                    "mt-1 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400" +
                    (row.source === "github" ? " font-mono text-xs" : "")
                  }
                >
                  {row.content}
                </p>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AnswerCard({
  text,
  numbered,
  onCite,
}: {
  text: string;
  numbered: EvidenceRow[];
  onCite: (n: number) => void;
}) {
  // The synthesis prompt asks for "[n]" but the model sometimes groups
  // several citations in one bracket, e.g. "[2, 4, 7, 8]". Match either
  // shape and give each number inside its own clickable target.
  const parts = text.split(/(\[[\d,\s]+\])/g);
  return (
    <div className="stage-enter rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Answer
      </h2>
      <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed">
        {parts.map((part, i) => {
          const m = part.match(/^\[([\d,\s]+)\]$/);
          if (!m) return <span key={i}>{part}</span>;
          const nums = m[1]
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n));
          return (
            <span key={i}>
              [
              {nums.map((n, j) => (
                <span key={n}>
                  {j > 0 && ", "}
                  <button
                    type="button"
                    onClick={() => onCite(n)}
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {n}
                  </button>
                </span>
              ))}
              ]
            </span>
          );
        })}
      </p>
      {numbered.length > 0 && (
        <ol className="mt-4 space-y-1 border-t border-zinc-200 pt-3 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {numbered.map((row, i) => (
            <li key={`${row.source}:${row.sourceId}`}>
              <button
                type="button"
                onClick={() => onCite(i + 1)}
                className="text-left hover:underline"
              >
                [{i + 1}]{" "}
                <span className="font-mono text-xs">
                  {badgeFor(row.source)} {row.sourceId}
                </span>{" "}
                {row.title ?? ""}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashed, setFlashed] = useState<Set<number>>(new Set());
  const sourceRef = useRef<EventSource | null>(null);
  const rowRefs = useRef<Map<number, HTMLElement | null>>(new Map());

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((rows: Project[]) => setProjects(rows))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => () => sourceRef.current?.close(), []);

  const { numbered, citations } = numberEvidence(stages);
  const hasAnswer = stages.some((s) => s.kind === "answer");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    sourceRef.current?.close();
    setStages([]);
    setError(null);
    setFlashed(new Set());
    rowRefs.current = new Map();
    setLoading(true);

    const params = new URLSearchParams({ q: query });
    if (project) params.set("project", project);
    const es = new EventSource(`/api/ask?${params.toString()}`);
    sourceRef.current = es;

    es.addEventListener("plan", (ev) => {
      const plan = JSON.parse((ev as MessageEvent).data).plan as PlanStage;
      setStages((prev) => [...prev, { kind: "plan", plan }]);
    });
    es.addEventListener("evidence", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as {
        tool: string;
        rows: EvidenceRow[];
      };
      setStages((prev) => [
        ...prev,
        { kind: "evidence", tool: data.tool, rows: data.rows },
      ]);
    });
    es.addEventListener("answer", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { text: string };
      setStages((prev) => [...prev, { kind: "answer", text: data.text }]);
    });
    es.addEventListener("done", () => {
      es.close();
      setLoading(false);
    });
    es.addEventListener("error", (ev) => {
      const raw = (ev as MessageEvent).data;
      const message = raw ? JSON.parse(raw).message : "connection lost";
      setError(message);
      es.close();
      setLoading(false);
    });
  }

  function citeTo(n: number) {
    const el = rowRefs.current.get(n);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashed((prev) => new Set(prev).add(n));
    setTimeout(() => {
      setFlashed((prev) => {
        const next = new Set(prev);
        next.delete(n);
        return next;
      });
    }, 1200);
  }

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-[720px] px-6 py-12">
        <header className="mb-10">
          <h1 className="text-sm font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
            Anatomy of a Knowledge Base
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            watch a question move through the pipeline
          </p>
        </header>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask a question about the knowledge base"
            className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-indigo-600 dark:border-zinc-700 dark:focus:border-indigo-400"
          />
          <div className="flex items-center gap-3">
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
            >
              <option value="">all sources</option>
              {projects.map((p) => (
                <option key={p.sourceId} value={p.sourceId}>
                  {p.title ?? p.sourceId}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-indigo-400 dark:text-zinc-950"
            >
              Ask
            </button>
          </div>
        </form>

        <div className="mt-10 space-y-4">
          {error && (
            <div className="stage-enter rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          )}

          {stages.map((stage, i) => {
            if (stage.kind === "plan") {
              return <PlanCard key={i} plan={stage.plan} />;
            }
            if (stage.kind === "evidence") {
              return (
                <EvidenceCard
                  key={i}
                  stage={stage}
                  citations={citations}
                  rowRefs={rowRefs}
                  flashed={flashed}
                />
              );
            }
            return (
              <AnswerCard
                key={i}
                text={stage.text}
                numbered={numbered}
                onCite={citeTo}
              />
            );
          })}

          {loading && !hasAnswer && <SkeletonBars />}
        </div>

        <footer className="mt-16 border-t border-zinc-200 pt-6 text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          <a
            href="docs/00-overview.md"
            className="hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            docs/00-overview.md
          </a>
        </footer>
      </div>
    </div>
  );
}
