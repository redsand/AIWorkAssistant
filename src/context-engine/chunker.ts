// Structure-aware chunking for code and knowledge ingestion.
//
// Replaces naive fixed-size character slicing (which cut functions, classes,
// and markdown sections mid-block) with token-aware strategies that respect
// semantic boundaries. Each emitted chunk carries a structural context header
// so downstream keyword extraction and embeddings see complete units in
// context. See issue #228.
import { CHARS_PER_TOKEN, type ChunkOptions, type ContentChunk } from "./types";
import { estimateTokens } from "./budget";

// ---------------------------------------------------------------------------
// Language helpers
// ---------------------------------------------------------------------------

const JS_LIKE = new Set(["typescript", "javascript"]);

const HASH_COMMENT_LANGS = new Set([
  "python",
  "ruby",
  "shell",
  "yaml",
  "toml",
  "powershell",
  "dockerfile",
  "env",
]);

function lineComment(language: string): string {
  return HASH_COMMENT_LANGS.has(language) ? "#" : "//";
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Declaration detection
// ---------------------------------------------------------------------------

// Top-level (indent 0) declarations we split on.
const JS_TOP_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
// Class members (indented) used to break up an oversized class.
const JS_MEMBER_DECL =
  /^\s+(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|abstract\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*[(<]/;

const PY_TOP_DECL = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/;
const PY_MEMBER_DECL = /^\s+(?:async\s+)?def\s+([A-Za-z_][\w]*)/;

interface DeclMatch {
  symbol: string;
  kind: "function" | "class" | "interface" | "enum" | "namespace" | "method";
}

function matchTopDecl(line: string, language: string): DeclMatch | null {
  if (JS_LIKE.has(language)) {
    const m = JS_TOP_DECL.exec(line);
    if (!m) return null;
    const kw = /\bclass\b/.test(line)
      ? "class"
      : /\binterface\b/.test(line)
        ? "interface"
        : /\benum\b/.test(line)
          ? "enum"
          : /\bnamespace\b/.test(line)
            ? "namespace"
            : "function";
    return { symbol: m[1], kind: kw as DeclMatch["kind"] };
  }
  if (language === "python") {
    const m = PY_TOP_DECL.exec(line);
    if (!m) return null;
    return { symbol: m[1], kind: /\bclass\b/.test(line) ? "class" : "function" };
  }
  return null;
}

function matchMemberDecl(line: string, language: string): string | null {
  if (JS_LIKE.has(language)) {
    // Avoid matching control-flow keywords that look like calls.
    const trimmed = line.trim();
    if (/^(if|for|while|switch|catch|return|else|do)\b/.test(trimmed)) return null;
    const m = JS_MEMBER_DECL.exec(line);
    return m ? m[1] : null;
  }
  if (language === "python") {
    const m = PY_MEMBER_DECL.exec(line);
    return m ? m[1] : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line/segment primitives
// ---------------------------------------------------------------------------

interface Segment {
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  lines: string[];
  symbol: string; // breadcrumb fragment, e.g. "class Bar" or "" for preamble
  parent?: string; // e.g. "class Bar" for a method
}

function segmentText(seg: Segment): string {
  return seg.lines.join("\n");
}

function segmentTokens(seg: Segment): number {
  return estimateTokens(segmentText(seg));
}

function buildHeader(
  language: string,
  filePath: string | undefined,
  breadcrumb: string,
): string {
  const prefix = lineComment(language);
  const parts: string[] = [];
  if (filePath) parts.push(`File: ${filePath}`);
  if (breadcrumb) parts.push(breadcrumb);
  if (parts.length === 0) return "";
  return `${prefix} ${parts.join(" → ")}`;
}

function toChunk(
  seg: Segment,
  language: string,
  filePath: string | undefined,
): ContentChunk {
  const breadcrumb = seg.parent
    ? `${seg.parent} → ${seg.symbol}`
    : seg.symbol;
  return {
    content: segmentText(seg),
    startLine: seg.startLine,
    endLine: seg.endLine,
    contextHeader: buildHeader(language, filePath, breadcrumb),
  };
}

// Greedily merge adjacent segments so small ones (< minTokens) coalesce while
// staying under maxTokens. Segments that are already large are emitted alone.
function packSegments(
  segments: Segment[],
  maxTokens: number,
  minTokens: number,
  language: string,
  filePath: string | undefined,
): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  let current: Segment | null = null;

  const flush = () => {
    if (current) {
      chunks.push(toChunk(current, language, filePath));
      current = null;
    }
  };

  for (const seg of segments) {
    if (!current) {
      current = { ...seg, lines: [...seg.lines] };
      continue;
    }
    const currentTok = segmentTokens(current);
    const segTok = segmentTokens(seg);
    const sameParent = current.parent === seg.parent;
    // Merge when the running chunk is still under the min size, or the two
    // together still fit a single chunk — but never merge across different
    // structural parents (keeps a method attached to its own class breadcrumb).
    const shouldMerge =
      sameParent &&
      (currentTok < minTokens || currentTok + segTok <= maxTokens);
    if (shouldMerge) {
      current.lines.push(...seg.lines);
      current.endLine = seg.endLine;
      // Pick the most meaningful breadcrumb when merging distinct symbols:
      // a real declaration always wins over the import "module scope"
      // preamble; merging two distinct declarations generalizes to module
      // scope (no single symbol describes the chunk).
      if (current.symbol !== seg.symbol) {
        const curPreamble = current.symbol === "module scope" || current.symbol === "";
        const segPreamble = seg.symbol === "module scope" || seg.symbol === "";
        if (curPreamble && !segPreamble) {
          current.symbol = seg.symbol;
        } else if (!curPreamble && !segPreamble && !current.parent) {
          current.symbol = "module scope";
        }
      }
    } else {
      flush();
      current = { ...seg, lines: [...seg.lines] };
    }
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Strategy: structural code
// ---------------------------------------------------------------------------

export function structuralCodeChunk(
  content: string,
  language: string,
  maxTokens: number,
  minTokens: number,
  filePath?: string,
): ContentChunk[] {
  if (content.trim() === "") return [];

  const lines = content.split("\n");

  if (!JS_LIKE.has(language) && language !== "python") {
    // Languages without a declaration heuristic: blank-line separated blocks.
    return packSegments(
      blankLineSegments(lines),
      maxTokens,
      minTokens,
      language,
      filePath,
    );
  }

  // Find top-level declaration boundaries (indentation 0).
  const boundaries: Array<{ line: number; decl: DeclMatch }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) !== 0) continue;
    const decl = matchTopDecl(lines[i], language);
    if (decl) boundaries.push({ line: i, decl });
  }

  if (boundaries.length === 0) {
    return packSegments(
      blankLineSegments(lines),
      maxTokens,
      minTokens,
      language,
      filePath,
    );
  }

  const segments: Segment[] = [];

  // Preamble: everything before the first declaration (imports, etc.).
  if (boundaries[0].line > 0) {
    const preLines = lines.slice(0, boundaries[0].line);
    if (preLines.join("").trim() !== "") {
      segments.push({
        startLine: 1,
        endLine: boundaries[0].line,
        lines: preLines,
        symbol: "module scope",
      });
    }
  }

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b].line;
    const end = b + 1 < boundaries.length ? boundaries[b + 1].line : lines.length;
    const unitLines = lines.slice(start, end);
    const decl = boundaries[b].decl;
    const symbol = `${decl.kind} ${decl.symbol}`;
    const unit: Segment = {
      startLine: start + 1,
      endLine: end,
      lines: unitLines,
      symbol,
    };

    // Split oversized classes by member (method) boundaries so individual
    // methods become retrievable units that still carry the class breadcrumb.
    if (
      decl.kind === "class" &&
      segmentTokens(unit) > maxTokens
    ) {
      segments.push(...splitClassByMembers(unit, language, start));
    } else {
      segments.push(unit);
    }
  }

  return packSegments(segments, maxTokens, minTokens, language, filePath);
}

// Break a class unit into [signature, ...methods] sub-segments using indented
// member declarations as boundaries. absoluteStart is the 0-based index of the
// class's first line within the original file.
function splitClassByMembers(
  unit: Segment,
  language: string,
  absoluteStart: number,
): Segment[] {
  const lines = unit.lines;
  const memberLines: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (indentOf(lines[i]) === 0) continue; // stay inside the class body
    if (matchMemberDecl(lines[i], language)) memberLines.push(i);
  }

  if (memberLines.length === 0) return [unit];

  const out: Segment[] = [];
  // Class signature + anything before the first member.
  if (memberLines[0] > 0) {
    out.push({
      startLine: absoluteStart + 1,
      endLine: absoluteStart + memberLines[0],
      lines: lines.slice(0, memberLines[0]),
      symbol: unit.symbol,
    });
  }

  for (let m = 0; m < memberLines.length; m++) {
    const s = memberLines[m];
    const e = m + 1 < memberLines.length ? memberLines[m + 1] : lines.length;
    const memberName = matchMemberDecl(lines[s], language) ?? "member";
    out.push({
      startLine: absoluteStart + s + 1,
      endLine: absoluteStart + e,
      lines: lines.slice(s, e),
      symbol: `method ${memberName}()`,
      parent: unit.symbol,
    });
  }
  return out;
}

function blankLineSegments(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  let blockStart = 0;
  let buf: string[] = [];

  const push = (endIdx: number) => {
    if (buf.join("").trim() === "") {
      buf = [];
      return;
    }
    segments.push({
      startLine: blockStart + 1,
      endLine: endIdx,
      lines: buf,
      symbol: "",
    });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      if (buf.length > 0) {
        buf.push(lines[i]);
        push(i + 1);
      }
      blockStart = i + 1;
    } else {
      if (buf.length === 0) blockStart = i;
      buf.push(lines[i]);
    }
  }
  if (buf.length > 0) push(lines.length);

  return segments;
}

// ---------------------------------------------------------------------------
// Strategy: markdown
// ---------------------------------------------------------------------------

const MD_HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

export function markdownChunk(
  content: string,
  maxTokens: number,
  minTokens: number,
  filePath?: string,
): ContentChunk[] {
  if (content.trim() === "") return [];

  const lines = content.split("\n");

  interface Section {
    startLine: number;
    endLine: number;
    lines: string[];
    level: number; // 0 = preamble
    breadcrumb: string;
  }

  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];

  let cur: Section | null = null;
  const closeCur = (endIdx: number) => {
    if (cur) {
      cur.endLine = endIdx;
      sections.push(cur);
      cur = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const m = MD_HEADING.exec(lines[i]);
    if (m) {
      closeCur(i);
      const level = m[1].length;
      const title = m[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const breadcrumb = [...stack.map((s) => s.title), title].join(" → ");
      stack.push({ level, title });
      cur = { startLine: i + 1, endLine: i + 1, lines: [lines[i]], level, breadcrumb };
    } else if (cur) {
      cur.lines.push(lines[i]);
    } else {
      // Preamble before the first heading.
      cur = { startLine: i + 1, endLine: i + 1, lines: [lines[i]], level: 0, breadcrumb: "" };
    }
  }
  closeCur(lines.length);

  const prefix = lineComment("markdown"); // "//"
  const chunks: ContentChunk[] = [];

  let pending: Section | null = null;
  const flushPending = () => {
    if (!pending) return;
    const text = pending.lines.join("\n");
    const header = pending.breadcrumb
      ? `${prefix} ${pending.breadcrumb}`
      : filePath
        ? `${prefix} File: ${filePath}`
        : "";
    if (estimateTokens(text) > maxTokens) {
      // Oversized section: split the body but repeat the heading breadcrumb.
      const parts = fallbackChunk(text, maxTokens, 0, filePath);
      for (const part of parts) {
        chunks.push({
          content: part.content,
          startLine: pending.startLine + part.startLine - 1,
          endLine: pending.startLine + part.endLine - 1,
          contextHeader: header,
        });
      }
    } else {
      chunks.push({
        content: text,
        startLine: pending.startLine,
        endLine: pending.endLine,
        contextHeader: header,
      });
    }
    pending = null;
  };

  for (const section of sections) {
    if (section.lines.join("").trim() === "") continue;
    if (!pending) {
      pending = { ...section, lines: [...section.lines] };
      continue;
    }
    // Merge a too-small section forward, keeping the first breadcrumb.
    if (estimateTokens(pending.lines.join("\n")) < minTokens) {
      pending.lines.push(...section.lines);
      pending.endLine = section.endLine;
    } else {
      flushPending();
      pending = { ...section, lines: [...section.lines] };
    }
  }
  flushPending();

  return chunks;
}

// ---------------------------------------------------------------------------
// Strategy: token-aware fixed-size fallback
// ---------------------------------------------------------------------------

export function fallbackChunk(
  content: string,
  maxTokens: number,
  overlapTokens: number,
  filePath?: string,
): ContentChunk[] {
  if (content.trim() === "") return [];

  const chunkChars = Math.max(1, Math.floor(maxTokens * CHARS_PER_TOKEN));
  const overlapChars = Math.max(
    0,
    Math.min(chunkChars - 1, Math.floor(overlapTokens * CHARS_PER_TOKEN)),
  );
  const step = Math.max(1, chunkChars - overlapChars);

  // Cumulative offsets for O(log n) char → line lookup.
  const lines = content.split("\n");
  const lineOffsets: number[] = new Array(lines.length + 1);
  lineOffsets[0] = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i + 1] = lineOffsets[i] + lines[i].length + 1;
  }
  const charToLine = (pos: number): number => {
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lineOffsets[mid + 1] <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };

  const chunks: ContentChunk[] = [];
  let charPos = 0;
  while (charPos < content.length) {
    const end = Math.min(charPos + chunkChars, content.length);
    const slice = content.substring(charPos, end);
    chunks.push({
      content: slice,
      startLine: charToLine(charPos),
      endLine: charToLine(end - 1),
      contextHeader: filePath ? `${lineComment("text")} File: ${filePath}` : "",
    });
    if (end >= content.length) break;
    charPos += step;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function chunkContent(
  content: string,
  language: string,
  options: ChunkOptions,
): ContentChunk[] {
  const { strategy, maxTokens, minTokens, overlapTokens, filePath } = options;

  if (strategy === "fixed") {
    return fallbackChunk(content, maxTokens, overlapTokens, filePath);
  }

  try {
    if (language === "markdown") {
      return markdownChunk(content, maxTokens, minTokens, filePath);
    }
    return structuralCodeChunk(content, language, maxTokens, minTokens, filePath);
  } catch {
    // Any heuristic failure degrades gracefully to the fixed-size fallback.
    return fallbackChunk(content, maxTokens, overlapTokens, filePath);
  }
}
