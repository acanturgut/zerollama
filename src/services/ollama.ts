import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OLLAMA_URL } from '../config';
import { getOllamaEnv, log } from '../startup/dashboard';

const execAsync = promisify(exec);

// ─── Track our own Ollama process ────────────────────────────────────────────
let managedPid: number | null = null;
let weStartedOllama = false;
const PID_FILE = path.join(os.homedir(), '.zerollama', 'ollama.pid');

function savePid(pid: number): void {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid), 'utf-8');
  } catch {
    /* ok */
  }
}

function clearPid(): void {
  managedPid = null;
  weStartedOllama = false;
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ok */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function didWeStartOllama(): boolean {
  return weStartedOllama;
}

export async function checkConnection(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function stopOllama(): Promise<boolean> {
  // Only kill the process WE started (or the specific PID we track)
  if (managedPid && isProcessAlive(managedPid)) {
    try {
      process.kill(managedPid, 'SIGTERM');
    } catch {
      /* ok */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // If still alive, force kill
    if (isProcessAlive(managedPid)) {
      try {
        process.kill(managedPid, 'SIGKILL');
      } catch {
        /* ok */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    clearPid();
    return !(await checkConnection());
  }

  // Fallback: we didn't start it, try graceful pkill
  await execAsync('pkill -f "ollama serve" 2>/dev/null; true');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  clearPid();
  return !(await checkConnection());
}

export async function startOllama(): Promise<boolean> {
  // Don't start if already running
  if (await checkConnection()) {
    log(`[${new Date().toISOString()}] Ollama already running`);
    return true;
  }

  const child = spawn('ollama', ['serve'], {
    env: getOllamaEnv(),
    stdio: 'ignore', // fully detached — no pipe breakage on exit
    detached: true,
  });
  child.unref();

  child.on('error', (err) => {
    log(`[${new Date().toISOString()}] [ollama] process error: ${err.message}`);
    clearPid();
  });

  if (child.pid) {
    managedPid = child.pid;
    weStartedOllama = true;
    savePid(child.pid);
  }

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await checkConnection()) return true;
  }
  return false;
}

export async function restartOllama(): Promise<boolean> {
  await stopOllama();
  await new Promise((resolve) => setTimeout(resolve, 500));
  return startOllama();
}

export async function getOllamaVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('ollama --version');
    // Output is like "ollama version is 0.1.32" or "ollama version 0.6.2"
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function getLatestOllamaVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const tag: string = data.tag_name ?? '';
    // tag is like "v0.6.2"
    return tag.replace(/^v/, '');
  } catch {
    return null;
  }
}

export async function updateOllama(onLog: (msg: string) => void): Promise<boolean> {
  onLog('Checking current Ollama version…');
  const current = await getOllamaVersion();
  if (!current) {
    onLog('Could not determine current Ollama version');
    return false;
  }
  onLog(`Current version: ${current}`);

  onLog('Checking latest release…');
  const latest = await getLatestOllamaVersion();
  if (!latest) {
    onLog('Could not fetch latest version from GitHub');
    return false;
  }
  onLog(`Latest version:  ${latest}`);

  if (current === latest) {
    onLog(`Already up to date (${current})`);
    return true;
  }

  onLog(`Updating Ollama ${current} → ${latest}…`);
  // Stop Ollama before updating
  onLog('Stopping Ollama…');
  await stopOllama();

  try {
    // macOS: use the official install script
    const { stderr } = await execAsync('curl -fsSL https://ollama.com/install.sh | sh', {
      timeout: 120000,
    });
    if (stderr && stderr.trim()) {
      onLog(`[update] ${stderr.trim()}`);
    }
  } catch (err: any) {
    onLog(`Update failed: ${err.message}`);
    return false;
  }

  const newVersion = await getOllamaVersion();
  onLog(`Updated to ${newVersion ?? 'unknown'}`);

  // Restart Ollama after update
  onLog('Starting Ollama…');
  const ok = await startOllama();
  if (ok) onLog('Ollama is running');
  else onLog('Ollama did not respond after restart');
  return ok;
}
