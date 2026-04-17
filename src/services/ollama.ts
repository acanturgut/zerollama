import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { OLLAMA_URL } from '../config';
import { getOllamaEnv, log } from '../startup/dashboard';

const execAsync = promisify(exec);

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
  // Kill all ollama processes: serve, runner, and macOS app
  await execAsync(
    'pkill -9 -f "ollama" 2>/dev/null; killall -9 ollama 2>/dev/null; killall -9 "Ollama" 2>/dev/null; true',
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return !(await checkConnection());
}

export async function startOllama(): Promise<boolean> {
  const child = spawn('ollama', ['serve'], {
    env: getOllamaEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.unref();

  // Stream Ollama stdout/stderr into the dashboard log
  let stderrBuf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk
      .toString()
      .split('\n')
      .filter((l: string) => l.trim());
    for (const line of lines) {
      log(`[ollama] ${line}`);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) log(`[ollama] ${line}`);
    }
  });
  child.on('error', (err) => {
    log(`[ollama] process error: ${err.message}`);
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      log(`[ollama] exited with code ${code}`);
    }
  });

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await checkConnection()) return true;
  }
  return false;
}

export async function restartOllama(): Promise<boolean> {
  await execAsync(
    'pkill -9 -f "ollama" 2>/dev/null; killall -9 ollama 2>/dev/null; killall -9 "Ollama" 2>/dev/null; true',
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
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
    const resp = await fetch(
      'https://api.github.com/repos/ollama/ollama/releases/latest',
      {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github.v3+json' },
      },
    );
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

export async function updateOllama(
  onLog: (msg: string) => void,
): Promise<boolean> {
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
    const { stderr } = await execAsync(
      'curl -fsSL https://ollama.com/install.sh | sh',
      {
        timeout: 120000,
      },
    );
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
