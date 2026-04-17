import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { log } from '../startup/dashboard';

// ─── Configuration ──────────────────────────────────────────────────────────
const INDEX_DIR = path.join(os.homedir(), '.zerollama', 'rag');
const INDEX_FILE = path.join(INDEX_DIR, 'index.json');
const MAX_CHUNK_CHARS = parseInt(process.env.RAG_CHUNK_SIZE ?? '1000', 10);
const OVERLAP_CHARS = parseInt(process.env.RAG_OVERLAP ?? '200', 10);
const TOP_K = parseInt(process.env.RAG_TOP_K ?? '4', 10);

// Supported file extensions
const SUPPORTED_EXTS = new Set([
  '.md',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.rb',
  '.sh',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.cfg',
  '.ini',
  '.html',
  '.css',
  '.sql',
  '.swift',
  '.kt',
]);

// ─── Chunk ──────────────────────────────────────────────────────────────────
interface Chunk {
  id: string; // sha256 of content
  filePath: string; // absolute path
  content: string;
  startLine: number;
  endLine: number;
}

// ─── Persisted index ────────────────────────────────────────────────────────
interface RagIndex {
  version: number;
  indexedAt: string;
  directories: string[];
  chunks: Chunk[];
  // Pre-computed IDF values per term
  idf: Record<string, number>;
  // Per-chunk term frequency vectors (sparse: term → tf)
  tfs: Record<string, Record<string, number>>;
}

let currentIndex: RagIndex | null = null;

// ─── Tokenizer (simple whitespace + camelCase split) ────────────────────────
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase split
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// ─── Chunk a file ───────────────────────────────────────────────────────────
function chunkFile(filePath: string, content: string): Chunk[] {
  const chunks: Chunk[] = [];
  let charIdx = 0;
  let lineIdx = 0;

  while (charIdx < content.length) {
    const endChar = Math.min(charIdx + MAX_CHUNK_CHARS, content.length);
    const slice = content.slice(charIdx, endChar);

    // Count lines in this slice
    const sliceLines = slice.split('\n').length;
    const startLine = lineIdx + 1;
    const endLine = lineIdx + sliceLines;

    const id = crypto.createHash('sha256').update(slice).digest('hex').slice(0, 16);

    chunks.push({ id, filePath, content: slice, startLine, endLine });

    // Advance with overlap
    const advance = Math.max(MAX_CHUNK_CHARS - OVERLAP_CHARS, 200);
    const nextCharIdx = charIdx + advance;
    // Count how many lines we advanced
    const advanced = content.slice(charIdx, nextCharIdx);
    const advancedLines = advanced.split('\n').length - 1;
    lineIdx += advancedLines;
    charIdx = nextCharIdx;
  }

  return chunks;
}

// ─── Walk directory ─────────────────────────────────────────────────────────
function walkDir(dirPath: string): string[] {
  const results: string[] = [];
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '__pycache__',
    '.next',
    '.venv',
    'venv',
    'target',
  ]);

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) && entry.isDirectory()) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          results.push(full);
        }
      }
    }
  }

  walk(dirPath);
  return results;
}

// ─── Build TF-IDF index ────────────────────────────────────────────────────
export function indexDirectories(dirs: string[]): { chunks: number; files: number } {
  const allChunks: Chunk[] = [];
  let fileCount = 0;

  for (const dir of dirs) {
    const absDir = path.resolve(dir);
    if (!fs.existsSync(absDir)) {
      log(`[${new Date().toISOString()}] RAG: directory not found: ${absDir}`);
      continue;
    }
    const files = walkDir(absDir);
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Skip very large files (>500KB)
        if (content.length > 500_000) continue;
        const chunks = chunkFile(filePath, content);
        allChunks.push(...chunks);
        fileCount++;
      } catch {
        // skip unreadable files
      }
    }
  }

  // Compute TF per chunk
  const tfs: Record<string, Record<string, number>> = {};
  const docFreq: Record<string, number> = {};
  const N = allChunks.length || 1;

  for (const chunk of allChunks) {
    const tokens = tokenize(chunk.content);
    const tf: Record<string, number> = {};
    for (const t of tokens) {
      tf[t] = (tf[t] ?? 0) + 1;
    }
    // Normalize by max frequency
    const maxFreq = Math.max(...Object.values(tf), 1);
    for (const t of Object.keys(tf)) {
      tf[t] /= maxFreq;
    }
    tfs[chunk.id] = tf;

    const seen = new Set(tokens);
    for (const t of seen) {
      docFreq[t] = (docFreq[t] ?? 0) + 1;
    }
  }

  // Compute IDF
  const idf: Record<string, number> = {};
  for (const [term, df] of Object.entries(docFreq)) {
    idf[term] = Math.log(N / df);
  }

  currentIndex = {
    version: 1,
    indexedAt: new Date().toISOString(),
    directories: dirs.map((d) => path.resolve(d)),
    chunks: allChunks,
    idf,
    tfs,
  };

  // Persist to disk
  try {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(currentIndex));
  } catch (err) {
    log(`[${new Date().toISOString()}] RAG: failed to persist index: ${(err as Error).message}`);
  }

  log(
    `[${new Date().toISOString()}] RAG: indexed ${fileCount} files → ${allChunks.length} chunks across ${dirs.length} directories`,
  );
  return { chunks: allChunks.length, files: fileCount };
}

// ─── Load persisted index from disk ─────────────────────────────────────────
export function loadIndex(): boolean {
  if (currentIndex) return true;
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
    currentIndex = JSON.parse(raw) as RagIndex;
    log(
      `[${new Date().toISOString()}] RAG: loaded index (${currentIndex.chunks.length} chunks from ${currentIndex.indexedAt})`,
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Query: return top-K chunks by TF-IDF cosine similarity ─────────────────
export function query(text: string, topK?: number): Chunk[] {
  if (!currentIndex) {
    loadIndex();
    if (!currentIndex) return [];
  }

  const k = topK ?? TOP_K;
  const queryTokens = tokenize(text);
  if (queryTokens.length === 0) return [];

  // Build query TF-IDF vector
  const queryTf: Record<string, number> = {};
  for (const t of queryTokens) queryTf[t] = (queryTf[t] ?? 0) + 1;
  const maxQf = Math.max(...Object.values(queryTf), 1);
  const queryVec: Record<string, number> = {};
  for (const [term, tf] of Object.entries(queryTf)) {
    const idfVal = currentIndex.idf[term] ?? 0;
    queryVec[term] = (tf / maxQf) * idfVal;
  }

  // Score each chunk via dot product / (|q| * |d|)
  const scores: { chunk: Chunk; score: number }[] = [];
  const qNorm = Math.sqrt(Object.values(queryVec).reduce((s, v) => s + v * v, 0)) || 1;

  for (const chunk of currentIndex.chunks) {
    const docTf = currentIndex.tfs[chunk.id];
    if (!docTf) continue;

    let dot = 0;
    let dNorm2 = 0;
    for (const [term, tf] of Object.entries(docTf)) {
      const idfVal = currentIndex.idf[term] ?? 0;
      const tfidf = tf * idfVal;
      dNorm2 += tfidf * tfidf;
      if (queryVec[term]) {
        dot += queryVec[term] * tfidf;
      }
    }

    const dNorm = Math.sqrt(dNorm2) || 1;
    const cosine = dot / (qNorm * dNorm);
    if (cosine > 0.01) {
      scores.push({ chunk, score: cosine });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k).map((s) => s.chunk);
}

// ─── Build context string for injection into chat messages ──────────────────
export function buildRagContext(userMessage: string): string | null {
  const chunks = query(userMessage);
  if (chunks.length === 0) return null;

  const parts = chunks.map(
    (c, i) =>
      `[${i + 1}] ${c.filePath} (lines ${c.startLine}–${c.endLine}):\n${c.content.slice(0, MAX_CHUNK_CHARS)}`,
  );
  return parts.join('\n\n');
}

// ─── Stats for TUI ──────────────────────────────────────────────────────────
export function ragStats(): {
  indexed: boolean;
  chunks: number;
  directories: string[];
  indexedAt: string | null;
} {
  if (!currentIndex) return { indexed: false, chunks: 0, directories: [], indexedAt: null };
  return {
    indexed: true,
    chunks: currentIndex.chunks.length,
    directories: currentIndex.directories,
    indexedAt: currentIndex.indexedAt,
  };
}

// ─── Clear index ────────────────────────────────────────────────────────────
export function clearIndex(): void {
  currentIndex = null;
  try {
    fs.unlinkSync(INDEX_FILE);
  } catch {
    // ignore
  }
  log(`[${new Date().toISOString()}] RAG: index cleared`);
}

// ─── Enabled check ──────────────────────────────────────────────────────────
export function isRagEnabled(): boolean {
  return currentIndex !== null && currentIndex.chunks.length > 0;
}
