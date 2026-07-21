import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { Connector, DistillCtx } from "../schema/types.js";
import { embedDocs } from "../models/embeddings.js";
import { computeIdf, rebuildTokenIdf, tokenize } from "./idf.js";
import { bucketConnector } from "./connectors/bucket.js";
import { confluenceConnector } from "./connectors/confluence.js";
import { githubConnector } from "./connectors/github.js";
import { jiraConnector } from "./connectors/jira.js";

export interface IngestSummary {
  perSource: Record<
    string,
    { ingested: number; skipped: number; degraded: number; failed: number }
  >;
  tokens: number;
}

export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function bootstrapJiraIdf(fixturesDir: string): Map<string, number> {
  const dir = join(fixturesDir, "jira");
  const docs: string[][] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const issue = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      description: string;
      comments: { body: string }[];
    };
    docs.push(tokenize(issue.description));
    for (const c of issue.comments) docs.push(tokenize(c.body));
  }
  return new Map([...computeIdf(docs)].map(([t, s]) => [t, s.idf]));
}

export function defaultConnectors(
  fixturesDir: string,
  jiraIdf: Map<string, number>,
): Connector[] {
  return [
    confluenceConnector(join(fixturesDir, "confluence")),
    jiraConnector(join(fixturesDir, "jira"), jiraIdf),
    githubConnector(join(fixturesDir, "github/helios"), "helios"),
    bucketConnector(join(fixturesDir, "bucket")),
  ];
}

export async function runIngest(
  pool: pg.Pool,
  opts: {
    fixturesDir: string;
    sources?: string[];
    llm?: DistillCtx["llm"];
    distillModel: string;
    log: (m: string) => void;
  },
): Promise<IngestSummary> {
  const connectors = defaultConnectors(
    opts.fixturesDir,
    bootstrapJiraIdf(opts.fixturesDir),
  ).filter((c) => !opts.sources || opts.sources.includes(c.source));
  const summary: IngestSummary = { perSource: {}, tokens: 0 };

  for (const connector of connectors) {
    const stat = { ingested: 0, skipped: 0, degraded: 0, failed: 0 };
    summary.perSource[connector.source] = stat;
    const known = new Map<string, string>(
      (
        await pool.query(
          `SELECT source_id, content_hash FROM embeddings WHERE source = $1`,
          [connector.source],
        )
      ).rows.map((r) => [r.source_id, r.content_hash]),
    );
    const ctx: DistillCtx = {
      llm: opts.llm,
      model: opts.distillModel,
      log: opts.log,
    };
    const pending: {
      doc: Awaited<ReturnType<Connector["distill"]>>[number];
      hash: string;
    }[] = [];

    for await (const item of connector.discover()) {
      try {
        for (const doc of await connector.distill(item, ctx)) {
          const hash = createHash("sha256").update(doc.content).digest("hex");
          if (known.get(doc.sourceId) === hash) {
            stat.skipped++;
            continue;
          }
          if (
            doc.metadata.distilled === false &&
            connector.source !== "github" &&
            connector.source !== "jira"
          )
            stat.degraded++;
          pending.push({ doc, hash });
        }
      } catch (e) {
        stat.failed++;
        opts.log(`item ${item.sourceId} failed: ${e}`);
      }
    }

    const vectors = await embedDocs(pending.map((p) => p.doc.content));
    for (let i = 0; i < pending.length; i++) {
      const { doc, hash } = pending[i];
      await pool.query(
        `INSERT INTO embeddings
           (source, source_id, kind, title, content, raw, metadata, authored_at, content_hash, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (source, source_id) DO UPDATE SET
           kind=$3, title=$4, content=$5, raw=$6, metadata=$7, authored_at=$8,
           content_hash=$9, embedding=$10, updated_at=now()`,
        [
          doc.source,
          doc.sourceId,
          doc.kind,
          doc.title,
          doc.content,
          JSON.stringify(doc.raw),
          JSON.stringify(doc.metadata),
          doc.authoredAt,
          hash,
          vectorLiteral(vectors[i]),
        ],
      );
      stat.ingested++;
    }
    await pool.query(
      `INSERT INTO sources (name, last_synced) VALUES ($1, now())
       ON CONFLICT (name) DO UPDATE SET last_synced = now()`,
      [connector.source],
    );
    opts.log(
      `${connector.source}: ${stat.ingested} ingested, ${stat.skipped} skipped, ` +
        `${stat.degraded} degraded, ${stat.failed} failed`,
    );
  }

  const projectsFile = JSON.parse(
    readFileSync(join(opts.fixturesDir, "projects.json"), "utf8"),
  ) as { projects: { name: string; description: string; sources: string[] }[] };
  for (const p of projectsFile.projects) {
    await pool.query(
      `INSERT INTO projects (name, description) VALUES ($1,$2)
       ON CONFLICT (name) DO UPDATE SET description=$2`,
      [p.name, p.description],
    );
    for (const s of p.sources) {
      await pool.query(
        `INSERT INTO sources (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [s],
      );
      await pool.query(
        `INSERT INTO project_sources (project, source) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [p.name, s],
      );
    }
  }
  summary.tokens = await rebuildTokenIdf(pool);
  return summary;
}
