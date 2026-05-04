import { CHARS_PER_TOKEN, type ScoredDocument } from "./types";

const ABBREVIATIONS = new Set([
  "vs", "etc", "ie", "eg", "cf", "approx", "dept", "est", "govt", "inc",
  "jr", "sr", "no", "st", "dr", "prof", "mr", "mrs", "ms", "repr", "tech",
  "api", "url", "sql", "css", "html", "json", "yaml", "tcp", "udp", "http",
  "https", "ssh", "dns", "ssl", "tls", "cpu", "gpu", "ram", "io",
]);

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < text.length; i++) {
    current += text[i];

    if (/[.!?]/.test(text[i])) {
      const preceding = current.trimEnd();
      const lastWord = preceding.split(/\s+/).pop() ?? "";
      const wordBase = lastWord.replace(/[.!?]+$/, "").toLowerCase();

      if (ABBREVIATIONS.has(wordBase)) {
        continue;
      }

      const nextChar = text[i + 1];
      if (nextChar === undefined || /\s/.test(nextChar)) {
        const peek = text.slice(i + 1).trimStart();
        if (peek.length === 0 || /^[A-Z]/.test(peek)) {
          sentences.push(current.trim());
          current = "";
        }
      }
    }
  }

  if (current.trim()) {
    sentences.push(current.trim());
  }

  return sentences.filter((s) => s.length > 0);
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function scoreSentence(
  sentence: string,
  queryTokens: Set<string>,
  position: number,
  totalPositions: number,
): number {
  const sentenceTokens = tokenize(sentence);
  if (sentenceTokens.size === 0) return 0;

  const overlap = jaccardSimilarity(sentenceTokens, queryTokens);

  const positionBoost =
    position === 0
      ? 0.15
      : position === totalPositions - 1
        ? 0.1
        : 0;

  return overlap + positionBoost;
}

export function compressDocument(
  content: string,
  query: string,
  tokenBudget: number,
): { compressed: string; originalTokens: number; compressedTokens: number } {
  const queryTokens = tokenize(query);
  const originalTokens = Math.ceil(content.length / CHARS_PER_TOKEN);

  if (originalTokens <= tokenBudget) {
    return { compressed: content, originalTokens, compressedTokens: originalTokens };
  }

  const sentences = splitSentences(content);
  if (sentences.length === 0) {
    return { compressed: content, originalTokens, compressedTokens: originalTokens };
  }

  const scored = sentences.map((s, i) => ({
    sentence: s,
    score: scoreSentence(s, queryTokens, i, sentences.length),
    index: i,
  }));

  scored.sort((a, b) => b.score - a.score);

  const maxChars = Math.floor(tokenBudget * CHARS_PER_TOKEN);
  const selected = new Map<number, string>();
  let usedChars = 0;

  for (const item of scored) {
    if (usedChars + item.sentence.length + 1 > maxChars) continue;
    selected.set(item.index, item.sentence);
    usedChars += item.sentence.length + 1;
  }

  const result = Array.from(selected.entries())
    .sort(([a], [b]) => a - b)
    .map(([, s]) => s)
    .join("\n");

  const compressedTokens = Math.ceil(result.length / CHARS_PER_TOKEN);
  return { compressed: result, originalTokens, compressedTokens };
}

export function compressDocuments(
  docs: ScoredDocument[],
  query: string,
  totalTokenBudget: number,
): ScoredDocument[] {
  if (docs.length === 0) return docs;

  const budgetPerDoc = Math.floor(totalTokenBudget / docs.length);

  return docs.map((doc) => {
    const { compressed, originalTokens, compressedTokens } = compressDocument(
      doc.content,
      query,
      budgetPerDoc,
    );
    return {
      ...doc,
      content: compressed,
      tokens: compressedTokens,
      metadata: {
        ...doc.metadata,
        originalTokens,
        compressionRatio: originalTokens > 0 ? originalTokens / compressedTokens : 1,
      },
    };
  });
}