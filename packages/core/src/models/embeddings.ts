import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

const MODEL = "Xenova/bge-small-en-v1.5";
const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= (
    pipeline("feature-extraction", MODEL) as Promise<FeatureExtractionPipeline>
  ).catch((e) => {
    extractor = undefined;
    throw e;
  });
  return extractor;
}

export async function embedDocs(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extract = await getExtractor();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const t = await extract(batch, { pooling: "mean", normalize: true });
    out.push(...(t.tolist() as number[][]));
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedDocs([QUERY_PREFIX + text]);
  return v;
}
