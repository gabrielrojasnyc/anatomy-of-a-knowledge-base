export interface RawItem {
  sourceId: string;
  title: string;
  payload: unknown;
  authoredAt?: Date;
}

export interface DistillCtx {
  llm?: (opts: {
    model: string;
    system: string;
    user: string;
  }) => Promise<string>;
  model: string;
  log: (msg: string) => void;
}

export interface EmbeddingInsert {
  source: string;
  sourceId: string;
  kind:
    | "page_section"
    | "issue_thread"
    | "comment_burst"
    | "code_chunk"
    | "doc_section";
  title: string | null;
  content: string;
  raw: unknown;
  metadata: Record<string, unknown>;
  authoredAt: Date | null;
  contentHash: string;
  embedding: number[];
}

export type DistilledDoc = Omit<EmbeddingInsert, "embedding" | "contentHash">;

export interface Connector {
  source: string;
  discover(): AsyncIterable<RawItem>;
  distill(item: RawItem, ctx: DistillCtx): Promise<DistilledDoc[]>;
}
