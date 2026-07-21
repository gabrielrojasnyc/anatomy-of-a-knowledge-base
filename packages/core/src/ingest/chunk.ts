export interface MdSection {
  heading: string | null;
  body: string;
  index: number;
}

export function splitMarkdownSections(md: string): MdSection[] {
  const lines = md.split("\n");
  const sections: MdSection[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body || heading !== null)
      sections.push({ heading, body, index: sections.length });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.*)$/);
    if (m) {
      flush();
      heading = m[1].trim();
    } else buf.push(line);
  }
  flush();
  return sections;
}

export interface CodeChunk {
  text: string;
  startLine: number;
  endLine: number;
  boundary: "class" | "function" | "block";
}

interface Span {
  start: number;
  end: number;
}

function matchSpans(lines: string[], re: RegExp): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let depth = 0,
      seen = false,
      end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          seen = true;
        }
        if (ch === "}") depth--;
      }
      if (seen && depth <= 0) {
        end = j;
        break;
      }
      end = j;
    }
    spans.push({ start: i, end });
    i = end;
  }
  return spans;
}

const CLASS_RE = /^\s*(export\s+)?(abstract\s+)?class\s+\w+/;
const FN_RE =
  /^\s*(export\s+)?(async\s+)?(function\s+\w+|(public|private|protected)?\s*\w+\s*\([^)]*\)\s*:?[^;{]*\{|const\s+\w+\s*=\s*(async\s*)?\()/;

function blocks(lines: string[], offset: number, size = 60): CodeChunk[] {
  const out: CodeChunk[] = [];
  for (let i = 0; i < lines.length; i += size) {
    const slice = lines.slice(i, i + size);
    if (slice.join("\n").trim() === "") continue;
    out.push({
      text: slice.join("\n"),
      startLine: offset + i + 1,
      endLine: offset + Math.min(i + size, lines.length),
      boundary: "block",
    });
  }
  return out;
}

function chunkSpan(
  lines: string[],
  offset: number,
  maxChars: number,
  level: "class" | "function" | "block",
): CodeChunk[] {
  const text = lines.join("\n");
  if (level === "block") return blocks(lines, offset);
  const re = level === "class" ? CLASS_RE : FN_RE;
  const next = level === "class" ? ("function" as const) : ("block" as const);
  const spans = matchSpans(lines, re);
  if (spans.length === 0) return chunkSpan(lines, offset, maxChars, next);
  const out: CodeChunk[] = [];
  let cursor = 0;
  const emit = (
    start: number,
    end: number,
    boundary: CodeChunk["boundary"],
  ) => {
    const t = lines.slice(start, end + 1).join("\n");
    if (t.trim() === "") return;
    if (t.length > maxChars)
      out.push(
        ...chunkSpan(
          lines.slice(start, end + 1),
          offset + start,
          maxChars,
          next,
        ),
      );
    else
      out.push({
        text: t,
        startLine: offset + start + 1,
        endLine: offset + end + 1,
        boundary,
      });
  };
  for (const s of spans) {
    if (s.start > cursor) emit(cursor, s.start - 1, "block");
    emit(s.start, s.end, level);
    cursor = s.end + 1;
  }
  if (cursor < lines.length) emit(cursor, lines.length - 1, "block");
  if (text.length <= maxChars && out.length > 1)
    return [
      {
        text,
        startLine: offset + 1,
        endLine: offset + lines.length,
        boundary: level,
      },
    ];
  return out;
}

export function chunkTypeScript(code: string, maxChars = 2000): CodeChunk[] {
  return chunkSpan(code.split("\n"), 0, maxChars, "class");
}
