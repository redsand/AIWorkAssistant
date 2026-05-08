import * as fs from "fs";
import * as path from "path";

export interface FileSymbol {
  name: string;
  kind: string;
  line: number;
  endLine: number;
}

export interface FileSummary {
  path: string;
  totalLines: number;
  sizeKB: number;
  language: string;
  imports: string[];
  symbols: FileSymbol[];
}

const IMPORT_PATTERNS: RegExp[] = [
  /^import\s+.*?from\s+['"]([^'"]+)['"]/gm,
  /^import\s+['"]([^'"]+)['"]/gm,
  /^import\s+(\w+)\s*$/gm,
  /^const\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/gm,
  /^from\s+([^\s]+)\s+import/gm,
  /^use\s+([^;]+)/gm,
  /^#include\s+[<"]([^>"]+)[>"]/gm,
];

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/m,
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m,
    /^\s*(?:export\s+)?interface\s+(\w+)/m,
    /^\s*(?:export\s+)?type\s+(\w+)\s*[\{=]/m,
    /^\s*(?:export\s+)?const\s+(\w+)\s*[=:](?!.*=>)/m,
    /^\s*(?:export\s+)?enum\s+(\w+)/m,
  ],
  javascript: [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/m,
    /^\s*(?:export\s+)?class\s+(\w+)/m,
    /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/m,
    /^\s*(?:export\s+)?const\s+(\w+)\s*[=:]/m,
  ],
  python: [
    /^\s*(?:async\s+)?def\s+(\w+)/m,
    /^\s*class\s+(\w+)/m,
  ],
  go: [
    /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m,
    /^\s*type\s+(\w+)\s+struct/m,
    /^\s*type\s+(\w+)\s+interface/m,
  ],
  rust: [
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m,
    /^\s*(?:pub\s+)?struct\s+(\w+)/m,
    /^\s*(?:pub\s+)?enum\s+(\w+)/m,
    /^\s*(?:pub\s+)?trait\s+(\w+)/m,
    /^\s*(?:pub\s+)?impl(?:<[^>]+>)?\s+(\w+)/m,
  ],
  java: [
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+(\w+)/m,
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/m,
  ],
  csharp: [
    /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|interface|struct|enum)\s+(\w+)/m,
    /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/m,
  ],
  ruby: [
    /^\s*def\s+(\w+)/m,
    /^\s*class\s+(\w+)/m,
    /^\s*module\s+(\w+)/m,
  ],
};

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".sh": "shell",
  ".bash": "shell",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".json": "json",
  ".md": "markdown",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "css",
};

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] || "unknown";
}

function kindFromPattern(pattern: RegExp): string {
  const source = pattern.source;
  if (source.includes("class")) return "class";
  if (source.includes("interface")) return "interface";
  if (source.includes("type")) return "type";
  if (source.includes("enum")) return "enum";
  if (source.includes("struct")) return "struct";
  if (source.includes("trait")) return "trait";
  if (source.includes("impl")) return "impl";
  if (source.includes("module")) return "module";
  if (source.includes("def")) return "function";
  if (source.includes("func")) return "function";
  if (source.includes("fn")) return "function";
  if (source.includes("function")) return "function";
  if (source.includes("const")) return "constant";
  return "symbol";
}

export function parseFileSymbols(content: string, language: string): FileSymbol[] {
  const patterns = SYMBOL_PATTERNS[language] || [];
  if (patterns.length === 0) {
    return parseGenericSymbols(content);
  }

  const symbols: FileSymbol[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const kind = kindFromPattern(pattern);
    let match: RegExpExecArray | null;
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    while ((match = globalPattern.exec(content)) !== null) {
      const name = match[1];
      if (!name || seen.has(name) || /^\d+$/.test(name)) continue;

      const line = content.substring(0, match.index).split("\n").length;
      seen.add(name);
      symbols.push({ name, kind, line, endLine: -1 });
    }
  }

  symbols.sort((a, b) => a.line - b.line);

  for (let i = 0; i < symbols.length; i++) {
    symbols[i].endLine = i + 1 < symbols.length ? symbols[i + 1].line - 1 : -1;
  }

  return symbols;
}

function parseGenericSymbols(content: string): FileSymbol[] {
  const genericPatterns: RegExp[] = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
    /^\s*(?:export\s+)?class\s+(\w+)/gm,
    /^\s*(?:export\s+)?interface\s+(\w+)/gm,
    /^\s*(?:export\s+)?const\s+(\w+)\s*[=:]/gm,
    /^\s*(?:async\s+)?def\s+(\w+)/gm,
    /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm,
  ];

  const symbols: FileSymbol[] = [];
  const seen = new Set<string>();

  for (const pattern of genericPatterns) {
    const kind = kindFromPattern(pattern);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (!name || seen.has(name)) continue;
      const line = content.substring(0, match.index).split("\n").length;
      seen.add(name);
      symbols.push({ name, kind, line, endLine: -1 });
    }
  }

  symbols.sort((a, b) => a.line - b.line);
  for (let i = 0; i < symbols.length; i++) {
    symbols[i].endLine = i + 1 < symbols.length ? symbols[i + 1].line - 1 : -1;
  }

  return symbols;
}

export function parseImports(content: string): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    let match: RegExpExecArray | null;
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    while ((match = globalPattern.exec(content)) !== null) {
      const imp = match[1];
      if (imp && !seen.has(imp)) {
        seen.add(imp);
        imports.push(imp);
      }
    }
  }

  return imports.slice(0, 30);
}

export function getFileSummary(filePath: string, rootDir: string): FileSummary | { error: string } {
  const resolved = path.resolve(rootDir, filePath);

  if (!resolved.startsWith(rootDir)) {
    return { error: "Access denied: path outside project root" };
  }

  if (!fs.existsSync(resolved)) {
    return { error: `File not found: ${filePath}` };
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { error: `Path is a directory, not a file: ${filePath}` };
  }

  const language = detectLanguage(resolved);
  const sizeKB = Math.round(stat.size / 1024);

  if (stat.size > 5 * 1024 * 1024) {
    return {
      path: filePath,
      totalLines: -1,
      sizeKB,
      language,
      imports: [],
      symbols: [],
    };
  }

  const content = fs.readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;
  const symbols = parseFileSymbols(content, language).slice(0, 100);
  const imports = parseImports(content);

  return {
    path: filePath,
    totalLines,
    sizeKB,
    language,
    imports,
    symbols,
  };
}

export function readFileSection(
  filePath: string,
  rootDir: string,
  options: { symbol?: string; startLine?: number; endLine?: number },
): { content: string; path: string; totalLines: number; startLine: number; endLine: number; symbol?: string } | { error: string } {
  const resolved = path.resolve(rootDir, filePath);

  if (!resolved.startsWith(rootDir)) {
    return { error: "Access denied: path outside project root" };
  }

  if (!fs.existsSync(resolved)) {
    return { error: `File not found: ${filePath}` };
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { error: `Path is a directory, not a file: ${filePath}` };
  }

  const language = detectLanguage(resolved);
  const content = fs.readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (options.symbol) {
    const symbols = parseFileSymbols(content, language);
    const match = symbols.find(
      (s) => s.name.toLowerCase() === options.symbol!.toLowerCase(),
    );

    if (!match) {
      const available = symbols.slice(0, 20).map((s) => s.name);
      return {
        error: `Symbol '${options.symbol}' not found. Available symbols: ${available.join(", ")}${symbols.length > 20 ? ` ... and ${symbols.length - 20} more` : ""}`,
      };
    }

    const startLine = match.line;
    const endLine = match.endLine > 0 ? Math.min(match.endLine, totalLines) : Math.min(startLine + 199, totalLines);

    const sectionLines = lines.slice(startLine - 1, endLine);
    return {
      content: sectionLines.map((l, i) => `${startLine + i}: ${l}`).join("\n"),
      path: filePath,
      totalLines,
      startLine,
      endLine,
      symbol: match.name,
    };
  }

  if (options.startLine !== undefined) {
    const startLine = Math.max(1, options.startLine);
    const maxLines = 500;
    const requestedEnd = options.endLine || startLine + 199;
    const endLine = Math.min(requestedEnd, startLine + maxLines - 1, totalLines);

    const sectionLines = lines.slice(startLine - 1, endLine);
    return {
      content: sectionLines.map((l, i) => `${startLine + i}: ${l}`).join("\n"),
      path: filePath,
      totalLines,
      startLine,
      endLine,
    };
  }

  return { error: "Provide either 'symbol' or 'startLine' parameter. Use local.file_summary first to find symbol names and line ranges." };
}

export interface FileChunk {
  id: number;
  lines: string;
  preview: string;
}

export function getFileChunks(
  filePath: string,
  rootDir: string,
  chunkSize: number,
  chunkId?: number,
): { chunks?: FileChunk[]; content?: string; path: string; totalLines: number; chunkSize: number } | { error: string } {
  const clampedChunkSize = Math.min(Math.max(chunkSize, 50), 500);
  const resolved = path.resolve(rootDir, filePath);

  if (!resolved.startsWith(rootDir)) {
    return { error: "Access denied: path outside project root" };
  }

  if (!fs.existsSync(resolved)) {
    return { error: `File not found: ${filePath}` };
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { error: `Path is a directory, not a file: ${filePath}` };
  }

  const content = fs.readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (chunkId !== undefined) {
    const startLine = (chunkId - 1) * clampedChunkSize + 1;
    if (startLine > totalLines) {
      return { error: `Chunk ${chunkId} does not exist. File has ${totalLines} lines with chunk size ${clampedChunkSize}.` };
    }
    const endLine = Math.min(startLine + clampedChunkSize - 1, totalLines);
    const chunkLines = lines.slice(startLine - 1, endLine);
    return {
      content: chunkLines.map((l, i) => `${startLine + i}: ${l}`).join("\n"),
      path: filePath,
      totalLines,
      chunkSize: clampedChunkSize,
    };
  }

  const chunks: FileChunk[] = [];
  const totalChunks = Math.ceil(totalLines / clampedChunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const startLine = i * clampedChunkSize + 1;
    const endLine = Math.min(startLine + clampedChunkSize - 1, totalLines);
    const firstLine = lines[i * clampedChunkSize]?.trim().substring(0, 80) || "";
    chunks.push({
      id: i + 1,
      lines: `${startLine}-${endLine}`,
      preview: firstLine,
    });
  }

  return {
    chunks,
    path: filePath,
    totalLines,
    chunkSize: clampedChunkSize,
  };
}