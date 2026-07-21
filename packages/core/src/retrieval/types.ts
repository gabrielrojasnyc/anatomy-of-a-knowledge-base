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
  recency: string | null;
  tool: string;
}
