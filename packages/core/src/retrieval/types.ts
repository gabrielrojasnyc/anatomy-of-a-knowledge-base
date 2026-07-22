export interface RetrievedDoc {
  id: number;
  source: string;
  sourceId: string;
  kind: string;
  title: string | null;
  content: string;
  metadata: Record<string, unknown>;
  authoredAt: Date | null;
  score: number;
}

export interface RankedList {
  name: string;
  docs: RetrievedDoc[];
}

export interface EvidenceRow {
  content: string;
  source: string;
  sourceId: string;
  title: string | null;
  url: string;
  score: number;
  /** What the score means: an RRF sum (~0.01 to 0.1) or an LLM rerank grade (0 to 10). */
  scoreKind?: "fused" | "reranked";
  /** How many retrievers independently surfaced this row. */
  retrieverAgreement?: number;
  authors?: string[];
  /** Hop targets distillation extracted: uris get_document can dereference. */
  links?: string[];
  recency: string | null;
  tool: string;
}
