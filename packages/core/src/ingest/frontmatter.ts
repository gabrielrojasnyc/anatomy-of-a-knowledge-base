export function parseFrontMatter(md: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim();
    meta[kv[1]] = val.startsWith("[")
      ? val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : val;
  }
  return { meta, body: md.slice(m[0].length) };
}
