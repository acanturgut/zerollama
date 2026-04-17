import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  tool_name?: string;
}

export interface Session {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

interface SessionIndexEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface SessionIndex {
  activeSessionId: string | null;
  sessions: SessionIndexEntry[];
}

// ─── Paths ───────────────────────────────────────────────────────────────────
const SESSIONS_DIR = path.join(os.homedir(), '.zerollama', 'sessions');
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

function ensureDir(): boolean {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function sessionFile(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

// ─── Safe I/O helpers (NEVER throw) ──────────────────────────────────────────
function readIndex(): SessionIndex {
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.sessions)) return data as SessionIndex;
  } catch {
    /* ignore */
  }
  return { activeSessionId: null, sessions: [] };
}

function writeIndex(index: SessionIndex): boolean {
  try {
    ensureDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function readSessionFile(id: string): Session | null {
  try {
    const raw = fs.readFileSync(sessionFile(id), 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data.id === 'string' && Array.isArray(data.messages)) {
      return data as Session;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeSessionFile(session: Session): boolean {
  try {
    ensureDir();
    fs.writeFileSync(sessionFile(session.id), JSON.stringify(session, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ─── Session CRUD (all safe — never throw) ───────────────────────────────────
export function createSession(name?: string): Session | null {
  try {
    if (!ensureDir()) return null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const session: Session = {
      id,
      name:
        name ||
        `Chat ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    if (!writeSessionFile(session)) return null;

    const index = readIndex();
    index.sessions.unshift({
      id,
      name: session.name,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    });
    index.activeSessionId = id;
    writeIndex(index);
    return session;
  } catch {
    return null;
  }
}

export function getSession(id: string): Session | null {
  return readSessionFile(id);
}

export function listSessions(): SessionIndexEntry[] {
  try {
    return readIndex().sessions;
  } catch {
    return [];
  }
}

export function deleteSession(id: string): boolean {
  try {
    const index = readIndex();
    const idx = index.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    index.sessions.splice(idx, 1);
    if (index.activeSessionId === id) {
      index.activeSessionId = index.sessions[0]?.id ?? null;
    }
    writeIndex(index);
    try {
      fs.unlinkSync(sessionFile(id));
    } catch {
      /* ok */
    }
    return true;
  } catch {
    return false;
  }
}

export function renameSession(id: string, newName: string): boolean {
  try {
    const session = readSessionFile(id);
    if (!session) return false;
    session.name = newName;
    writeSessionFile(session);
    const index = readIndex();
    const entry = index.sessions.find((s) => s.id === id);
    if (entry) entry.name = newName;
    writeIndex(index);
    return true;
  } catch {
    return false;
  }
}

// ─── Active Session ──────────────────────────────────────────────────────────
export function getActiveSessionId(): string | null {
  try {
    return readIndex().activeSessionId;
  } catch {
    return null;
  }
}

export function setActiveSession(id: string): boolean {
  try {
    const index = readIndex();
    if (!index.sessions.some((s) => s.id === id)) return false;
    index.activeSessionId = id;
    writeIndex(index);
    return true;
  } catch {
    return false;
  }
}

export function getActiveSession(): Session | null {
  const id = getActiveSessionId();
  if (!id) return null;
  return readSessionFile(id);
}

export function getOrCreateActiveSession(): Session | null {
  const active = getActiveSession();
  if (active) return active;
  return createSession();
}

// ─── Message Management ──────────────────────────────────────────────────────
export function appendMessages(sessionId: string, msgs: ChatMessage[]): void {
  try {
    const session = readSessionFile(sessionId);
    if (!session) return;
    session.messages.push(...msgs);
    session.updatedAt = new Date().toISOString();
    writeSessionFile(session);

    const index = readIndex();
    const entry = index.sessions.find((s) => s.id === sessionId);
    if (entry) {
      entry.updatedAt = session.updatedAt;
      entry.messageCount = session.messages.length;
    }
    writeIndex(index);
  } catch {
    /* silently fail — never crash server */
  }
}

export function getSessionMessages(sessionId: string): ChatMessage[] {
  return readSessionFile(sessionId)?.messages ?? [];
}

export function clearSessionMessages(sessionId: string): boolean {
  try {
    const session = readSessionFile(sessionId);
    if (!session) return false;
    session.messages = [];
    session.updatedAt = new Date().toISOString();
    writeSessionFile(session);
    const index = readIndex();
    const entry = index.sessions.find((s) => s.id === sessionId);
    if (entry) {
      entry.updatedAt = session.updatedAt;
      entry.messageCount = 0;
    }
    writeIndex(index);
    return true;
  } catch {
    return false;
  }
}

// ─── Auto-name from first message ────────────────────────────────────────────
export function autoNameSession(sessionId: string, firstUserMessage: string): void {
  try {
    const index = readIndex();
    const entry = index.sessions.find((s) => s.id === sessionId);
    if (!entry || !entry.name.startsWith('Chat ')) return;

    const truncated = firstUserMessage.slice(0, 50).trim();
    const name = truncated + (firstUserMessage.length > 50 ? '…' : '');
    entry.name = name;
    writeIndex(index);

    const session = readSessionFile(sessionId);
    if (session) {
      session.name = name;
      writeSessionFile(session);
    }
  } catch {
    /* silently fail */
  }
}
