import type { Tool } from "./tools.js";

type Llm = (o: {
  model: string;
  system: string;
  user: string;
}) => Promise<string>;

const SYSTEM = `You are a query planner for a knowledge base. Given a question and a
catalog of tools and projects, select the best tools to answer it.
Reply with ONLY JSON: {"tools": [{"name": "...", "query": "..."}], "reasoning": "one line"}.
Pick 1 to 3 tools. Rewrite the query per tool when it helps (an exact flag for
search_code, a topic for who_knows). Prefer plain search unless the question is
clearly about code text, people, or one specific system.`;

export async function plan(
  question: string,
  tools: Tool[],
  projectsCatalog: string,
  opts: { llm: Llm; model: string },
): Promise<{
  tools: { name: string; query: string }[];
  reasoning: string;
  fallback: boolean;
}> {
  const fallback = {
    tools: [{ name: "search", query: question }],
    reasoning: "fallback: plain search",
    fallback: true,
  };
  const catalog = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  try {
    const reply = await opts.llm({
      model: opts.model,
      system: SYSTEM,
      user: `<question>${question}</question>\n<tools>\n${catalog}\n</tools>\n<projects>\n${projectsCatalog}\n</projects>`,
    });
    const parsed = JSON.parse(
      reply.replace(/```(?:json)?|```/g, "").trim(),
    ) as {
      tools?: { name?: string; query?: string }[];
      reasoning?: string;
    };
    const known = new Set(tools.map((t) => t.name));
    const picked = (parsed.tools ?? [])
      .filter((t) => t.name && known.has(t.name))
      .slice(0, 3)
      .map((t) => ({
        name: t.name as string,
        query: t.query?.trim() || question,
      }));
    if (picked.length === 0) return fallback;
    return {
      tools: picked,
      reasoning: parsed.reasoning ?? "",
      fallback: false,
    };
  } catch {
    return fallback;
  }
}
