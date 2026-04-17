import blessed from 'blessed';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { OLLAMA_URL, PORT } from '../config';
import { checkConnection, updateOllama } from '../services/ollama';

// ─── Debounced render ───────────────────────────────────────────────────────
let renderPending = false;
function scheduleRender(): void {
  if (!screen || renderPending) return;
  renderPending = true;
  process.nextTick(() => {
    renderPending = false;
    if (screen) screen.render();
  });
}

let screen: blessed.Widgets.Screen;
let zerollamaLogBox: blessed.Widgets.Log;
let ollamaLogBox: blessed.Widgets.Log;
let responsesBox: blessed.Widgets.Log;
let statusLine: blessed.Widgets.TextElement;
let bannerBox: blessed.Widgets.BoxElement;
let infoBox: blessed.Widgets.BoxElement;
let debugBox: blessed.Widgets.Log;
let debugInput: blessed.Widgets.TextboxElement;
let debugVisible = false;
let debugFocused = false;
let modelPickerActive = false;
let ollamaStatus = false;
const zerollamaLogLines: string[] = [];
const ollamaLogLines: string[] = [];

// ─── Model selection ────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.zerollama');
const DEFAULT_MODEL_FILE = path.join(CONFIG_DIR, 'default-model');

function loadDefaultModel(): string | null {
  try {
    const val = fs.readFileSync(DEFAULT_MODEL_FILE, 'utf-8').trim();
    return val || null;
  } catch {
    return null;
  }
}

function saveDefaultModel(model: string): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(DEFAULT_MODEL_FILE, model, 'utf-8');
  } catch {
    // ignore
  }
}

let defaultModel: string | null = loadDefaultModel();
let selectedModel: string | null = defaultModel;
let detectedModel: string | null = null;

export function getSelectedModel(): string | null {
  return selectedModel;
}

export function setSelectedModel(model: string): void {
  const prev = selectedModel;
  selectedModel = model;
  refreshUI();
  // Flush previous model from memory so the new one can load cleanly
  if (prev && prev !== model) {
    log(`[${new Date().toISOString()}] Flushing ${prev} from memory…`);
    fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: prev, keep_alive: 0 }),
    }).catch(() => {});
  }
}

// ─── Session stats ──────────────────────────────────────────────────────────
const sessionStartTime = new Date();
let sessionConnections = 0;
let sessionErrors = 0;
let sessionResponseCount = 0;

// ─── Ollama config ───────────────────────────────────────────────────────
export interface OllamaConfig {
  maxLoadedModels: string;
  numParallel: string;
  flashAttention: string;
  numGpu: string;
  keepAlive: string;
  contextLength: string;
  kvCacheType: string;
  gpuOverhead: string;
  loadTimeout: string;
  maxQueue: string;
  debug: string;
  schedSpread: string;
  multiuserCache: string;
}

let ollamaConfig: OllamaConfig = {
  maxLoadedModels: '1',
  numParallel: '2',
  flashAttention: '1',
  numGpu: '999',
  keepAlive: '24h',
  contextLength: '',
  kvCacheType: '',
  gpuOverhead: '0',
  loadTimeout: '5m',
  maxQueue: '512',
  debug: '0',
  schedSpread: '0',
  multiuserCache: '0',
};

export function getOllamaConfig(): OllamaConfig {
  return { ...ollamaConfig };
}

export function setOllamaConfig(cfg: Partial<OllamaConfig>): void {
  ollamaConfig = { ...ollamaConfig, ...cfg };
  refreshUI();
}

export function getOllamaEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OLLAMA_MAX_LOADED_MODELS: ollamaConfig.maxLoadedModels,
    OLLAMA_NUM_PARALLEL: ollamaConfig.numParallel,
    OLLAMA_FLASH_ATTENTION: ollamaConfig.flashAttention,
    OLLAMA_NUM_GPU: ollamaConfig.numGpu,
    OLLAMA_KEEP_ALIVE: ollamaConfig.keepAlive,
    OLLAMA_GPU_OVERHEAD: ollamaConfig.gpuOverhead,
    OLLAMA_LOAD_TIMEOUT: ollamaConfig.loadTimeout,
    OLLAMA_MAX_QUEUE: ollamaConfig.maxQueue,
    OLLAMA_DEBUG: ollamaConfig.debug,
    OLLAMA_SCHED_SPREAD: ollamaConfig.schedSpread,
    OLLAMA_MULTIUSER_CACHE: ollamaConfig.multiuserCache,
  };
  if (ollamaConfig.contextLength)
    env.OLLAMA_CONTEXT_LENGTH = ollamaConfig.contextLength;
  if (ollamaConfig.kvCacheType)
    env.OLLAMA_KV_CACHE_TYPE = ollamaConfig.kvCacheType;
  return env;
}

// ─── Token tracking ─────────────────────────────────────────────────────────
let sessionPromptTokens = 0;
let sessionCompletionTokens = 0;
let sessionRequests = 0;

export function addTokenUsage(
  promptTokens: number,
  completionTokens: number,
): void {
  sessionPromptTokens += promptTokens;
  sessionCompletionTokens += completionTokens;
  sessionRequests++;
  refreshUI();
}

export function getTokenStats() {
  return {
    prompt: sessionPromptTokens,
    completion: sessionCompletionTokens,
    total: sessionPromptTokens + sessionCompletionTokens,
    requests: sessionRequests,
  };
}

export function log(msg: string): void {
  if (msg.includes('[ollama]')) {
    ollamaLogLines.push(msg);
    if (ollamaLogBox) {
      ollamaLogBox.log(msg);
      scheduleRender();
    } else {
      process.stdout.write(msg + '\n');
    }
  } else {
    zerollamaLogLines.push(msg);
    if (zerollamaLogBox) {
      zerollamaLogBox.log(msg);
      scheduleRender();
    } else {
      process.stdout.write(msg + '\n');
    }
  }
}

let logWrap = false;

function rebuildLogBox(box: blessed.Widgets.Log, lines: string[]): void {
  box.setContent('');
  (box as any)._clines = [];
  (box as any)._clines.fake = [];
  (box as any)._clines.ftor = [];
  (box as any)._clines.rtof = [];
  for (const line of lines) {
    box.log(line);
  }
}

export function toggleLogWrap(): void {
  logWrap = !logWrap;
  const wrapTag = logWrap
    ? '{green-fg}wrap{/green-fg}'
    : '{gray-fg}nowrap{/gray-fg}';
  if (zerollamaLogBox) {
    (zerollamaLogBox as any).options.wrap = logWrap;
    zerollamaLogBox.setLabel(` {bold}Zerollama{/bold} ${wrapTag} `);
    rebuildLogBox(zerollamaLogBox, zerollamaLogLines);
  }
  if (ollamaLogBox) {
    (ollamaLogBox as any).options.wrap = logWrap;
    ollamaLogBox.setLabel(` {bold}Ollama{/bold} ${wrapTag} `);
    rebuildLogBox(ollamaLogBox, ollamaLogLines);
  }
  if (screen) screen.render();
}

let truncateResponses = true;

interface ResponseEntry {
  model: string;
  prompt: string;
  response: string;
  rawJson: string;
  ts: string;
}
const responseHistory: ResponseEntry[] = [];

let rawResponseMode = false;

function formatResponse(entry: ResponseEntry, truncate: boolean): string[] {
  if (rawResponseMode) {
    return [
      `{cyan-fg}${entry.ts}{/cyan-fg} {bold}${entry.model}{/bold}`,
      entry.rawJson,
      '',
    ];
  }

  const displayPrompt = truncate
    ? entry.prompt.length > 80
      ? entry.prompt.slice(0, 77) + '\u2026'
      : entry.prompt
    : entry.prompt;

  const displayResp = truncate
    ? (entry.response.length > MAX_RESPONSE_LEN
        ? entry.response.slice(0, MAX_RESPONSE_LEN - 1) + '\u2026'
        : entry.response
      )
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : entry.response;

  return [
    `{cyan-fg}${entry.ts}{/cyan-fg} {bold}${entry.model}{/bold}`,
    `  {yellow-fg}Q:{/yellow-fg} ${displayPrompt}`,
    `  {green-fg}A:{/green-fg} ${displayResp}`,
    '',
  ];
}

export function toggleTruncation(): void {
  truncateResponses = !truncateResponses;
  if (responsesBox) {
    const tag = truncateResponses
      ? '{gray-fg}truncated{/gray-fg}'
      : '{green-fg}full{/green-fg}';
    responsesBox.setLabel(` {bold}Responses{/bold} ${tag} `);
    // Re-render all stored responses
    responsesBox.setContent('');
    (responsesBox as any)._clines = [];
    (responsesBox as any)._clines.fake = [];
    (responsesBox as any)._clines.ftor = [];
    (responsesBox as any)._clines.rtof = [];
    for (const entry of responseHistory) {
      for (const line of formatResponse(entry, truncateResponses)) {
        responsesBox.log(line);
      }
    }
    if (screen) screen.render();
  }
  log(
    `[${new Date().toISOString()}] Response truncation: ${truncateResponses ? 'on' : 'off'}`,
  );
}

export function toggleRawResponses(): void {
  rawResponseMode = !rawResponseMode;
  if (responsesBox) {
    const tag = rawResponseMode ? '{green-fg}raw{/green-fg}' : '{gray-fg}formatted{/gray-fg}';
    responsesBox.setLabel(` {bold}Responses{/bold} ${tag} `);
    responsesBox.setContent('');
    (responsesBox as any)._clines = [];
    (responsesBox as any)._clines.fake = [];
    (responsesBox as any)._clines.ftor = [];
    (responsesBox as any)._clines.rtof = [];
    for (const entry of responseHistory) {
      for (const line of formatResponse(entry, truncateResponses)) {
        responsesBox.log(line);
      }
    }
    if (screen) screen.render();
  }
  log(`[${new Date().toISOString()}] Raw response mode: ${rawResponseMode ? 'on' : 'off'}`);
}

export function showHelp(): void {
  if (modelPickerActive) return;
  modelPickerActive = true;

  const helpLines = [
    '',
    '  {bold}{cyan-fg}ZEROLLAMA{/cyan-fg}{/bold} — Ollama middleware proxy with TUI dashboard',
    '',
    '  {bold}Ollama Control{/bold}',
    '    {cyan-fg}s{/cyan-fg}   Start Ollama server',
    '    {cyan-fg}x{/cyan-fg}   Stop Ollama (kills all processes)',
    '    {cyan-fg}r{/cyan-fg}   Restart Ollama server',
    '    {cyan-fg}u{/cyan-fg}   Update Ollama to latest release from GitHub',
    '',
    '  {bold}Model Management{/bold}',
    '    {cyan-fg}m{/cyan-fg}   Open model picker — browse, install, delete, set default',
    '        {gray-fg}In picker: ↵ select, d delete, f favorite, + install, ⌕ HuggingFace{/gray-fg}',
    '',
    '  {bold}Configuration{/bold}',
    '    {cyan-fg}c{/cyan-fg}   Edit Ollama config (env vars like context, GPU layers, KV cache)',
    '        {gray-fg}In editor: ↵ edit value, p apply hardware preset{/gray-fg}',
    '',
    '  {bold}Debugging & Testing{/bold}',
    '    {cyan-fg}d{/cyan-fg}   Toggle debug chat — interactive prompt to test the current model',
    '        {gray-fg}Also enables OLLAMA_DEBUG=1 for verbose Ollama logging{/gray-fg}',
    '    {cyan-fg}b{/cyan-fg}   Run benchmark — 3 predefined prompts, scored by tokens/sec',
    '',
    '  {bold}Display{/bold}',
    '    {cyan-fg}w{/cyan-fg}   Toggle log wrap — nowrap shows one line per entry, wrap shows full text',
    '    {cyan-fg}t{/cyan-fg}   Toggle truncation — truncated limits response preview to 300 chars',
    '    {cyan-fg}R{/cyan-fg}   Toggle raw mode — show full JSON response instead of Q/A format',
    '    {cyan-fg}e{/cyan-fg}   Show API endpoints with copyable curl commands',
    '',
    '  {bold}Other{/bold}',
    '    {cyan-fg}h{/cyan-fg}   Show this help',
    '    {cyan-fg}q{/cyan-fg}   Quit Zerollama',
    '',
    '  {gray-fg}Proxy listens on PORT (default 3001). Point clients at this{/gray-fg}',
    '  {gray-fg}address instead of Ollama directly (localhost:11434).{/gray-fg}',
    '',
  ];

  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: helpLines.length + 2,
    border: { type: 'line' },
    label: ' {bold}Help{/bold}  {gray-fg}Esc to close{/gray-fg} ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    content: helpLines.join('\n'),
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'white', bold: true },
    },
  });

  box.focus();
  scheduleRender();

  box.key('escape', () => {
    box.destroy();
    modelPickerActive = false;
    scheduleRender();
  });

  box.key('q', () => {
    box.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

let updateInProgress = false;

export async function runUpdateOllama(): Promise<void> {
  if (updateInProgress) {
    log('Update already in progress');
    return;
  }
  updateInProgress = true;
  try {
    const ok = await updateOllama((msg) => {
      log(`[update] ${msg}`);
    });
    setOllamaStatus(ok);
  } finally {
    updateInProgress = false;
  }
}

const MAX_RESPONSE_LEN = 300;

export function logResponse(
  model: string,
  prompt: string,
  response: string,
  rawJson?: string,
): void {
  sessionResponseCount++;
  if (!responsesBox) return;
  const ts = new Date().toISOString().slice(11, 19);
  const entry: ResponseEntry = { model, prompt, response, rawJson: rawJson ?? '', ts };
  responseHistory.push(entry);

  for (const line of formatResponse(entry, truncateResponses)) {
    responsesBox.log(line);
  }
  scheduleRender();
}

function getLocalIPs(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface?.family === 'IPv4' && !iface.internal)
    .map((iface) => iface!.address);
}

let bannerNetAddrs = '';

function buildBannerContent(netAddrs?: string): string {
  if (netAddrs !== undefined) bannerNetAddrs = netAddrs;
  const isDefault = selectedModel && selectedModel === defaultModel;
  const modelTag = selectedModel
    ? `{magenta-fg}${selectedModel}{/magenta-fg}${isDefault ? ' {yellow-fg}★{/yellow-fg}' : ''}`
    : detectedModel
      ? `{magenta-fg}${detectedModel}{/magenta-fg} {gray-fg}(auto){/gray-fg}`
      : '{gray-fg}no model{/gray-fg}';

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const usedGB = (usedMem / 1073741824).toFixed(1);
  const totalGB = (totalMem / 1073741824).toFixed(1);
  const pct = Math.round((usedMem / totalMem) * 100);
  const color = pct > 85 ? 'red-fg' : pct > 60 ? 'yellow-fg' : 'green-fg';
  const ramTag = `{${color}}RAM ${usedGB}/${totalGB} GB (${pct}%){/${color}}`;

  return (
    ' {bold}{cyan-fg}ZEROLLAMA{/cyan-fg}{/bold}  ' +
    `{gray-fg}│{/gray-fg}  ${bannerNetAddrs}  {gray-fg}│{/gray-fg}  ${modelTag}  {gray-fg}│{/gray-fg}  ${ramTag}`
  );
}

export function trackRequest(): void {
  sessionConnections++;
  refreshUI();
}

export function trackError(): void {
  sessionErrors++;
  refreshUI();
}

export function trackResponse(): void {
  sessionResponseCount++;
  refreshUI();
}

function buildInfoContent(): string {
  const lines: string[] = [
    '',
    '  {bold}Commands{/bold}  {gray-fg}h help{/gray-fg}',
    '    {cyan-fg}s{/cyan-fg} start    {cyan-fg}x{/cyan-fg} stop',
    '    {cyan-fg}r{/cyan-fg} restart  {cyan-fg}c{/cyan-fg} config',
    '    {cyan-fg}d{/cyan-fg} debug    {cyan-fg}m{/cyan-fg} model',
    '    {cyan-fg}e{/cyan-fg} api      {cyan-fg}b{/cyan-fg} bench',
    '    {cyan-fg}w{/cyan-fg} wrap     {cyan-fg}u{/cyan-fg} update',
    '    {cyan-fg}t{/cyan-fg} trunc    {cyan-fg}R{/cyan-fg} raw',
    '    {cyan-fg}h{/cyan-fg} help     {cyan-fg}q{/cyan-fg} quit',
    '',
    '  {bold}Ollama Config{/bold}  {gray-fg}c{/gray-fg}',
    `    Models     {cyan-fg}${ollamaConfig.maxLoadedModels.padEnd(5)}{/cyan-fg} Parallel  {cyan-fg}${ollamaConfig.numParallel}{/cyan-fg}`,
    `    FlashAttn  {cyan-fg}${(ollamaConfig.flashAttention === '1' ? 'on' : 'off').padEnd(5)}{/cyan-fg} GPU       {cyan-fg}${ollamaConfig.numGpu}{/cyan-fg}`,
    `    KeepAlive  {cyan-fg}${ollamaConfig.keepAlive.padEnd(5)}{/cyan-fg} Timeout   {cyan-fg}${ollamaConfig.loadTimeout}{/cyan-fg}`,
    `    Context    {cyan-fg}${(ollamaConfig.contextLength || 'auto').padEnd(5)}{/cyan-fg} KVCache   {cyan-fg}${ollamaConfig.kvCacheType || 'f16'}{/cyan-fg}`,
    `    MaxQueue   {cyan-fg}${ollamaConfig.maxQueue.padEnd(5)}{/cyan-fg} Debug     {cyan-fg}${ollamaConfig.debug === '1' ? 'on' : 'off'}{/cyan-fg}`,
    '',
    '  {bold}Session{/bold}',
    `    Requests   {bold}${sessionConnections}{/bold}`,
    `    Responses  {bold}${sessionResponseCount}{/bold}`,
    `    Errors     {bold}${sessionErrors}{/bold}`,
    `    Tokens     {bold}${(sessionPromptTokens + sessionCompletionTokens).toLocaleString()}{/bold}`,
    `      in       ${sessionPromptTokens.toLocaleString()}`,
    `      out      ${sessionCompletionTokens.toLocaleString()}`,
  ];
  return lines.join('\n');
}

function updateInfoContent(): void {
  if (!infoBox) return;
  infoBox.setContent(buildInfoContent());
}

function refreshUI(): void {
  updateInfoContent();
  updateStatusLine();
  if (bannerBox) bannerBox.setContent(buildBannerContent());
  if (screen) {
    screen.render();
  }
}

function formatUptime(): string {
  const diff = Date.now() - sessionStartTime.getTime();
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  return h > 0
    ? `${h}h${String(m).padStart(2, '0')}m`
    : `${m}m${String(s).padStart(2, '0')}s`;
}

function updateStatusLine(): void {
  if (!statusLine) return;
  const ollamaLabel = ollamaStatus
    ? '{green-fg}● reachable{/green-fg}'
    : '{red-fg}● unreachable{/red-fg}';
  const total = sessionPromptTokens + sessionCompletionTokens;
  const tokensLabel = `Tokens: ${total.toLocaleString()} (${sessionPromptTokens.toLocaleString()} in / ${sessionCompletionTokens.toLocaleString()} out) | Reqs: ${sessionRequests}`;
  const startLabel = sessionStartTime.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  statusLine.setContent(
    ` ${OLLAMA_URL}:${PORT}  ${ollamaLabel}  │  ${tokensLabel}  │  ▲ ${startLabel} (${formatUptime()})`,
  );
}

export function setOllamaStatus(reachable: boolean): void {
  ollamaStatus = reachable;
  refreshUI();
}

export function createDashboard(onQuit: () => void): void {
  // Ghostty terminal advertises Setulc which blessed can't parse — fall back to xterm-256color
  if (process.env.TERM?.includes('ghostty')) {
    process.env.TERM = 'xterm-256color';
  }

  screen = blessed.screen({
    smartCSR: true,
    title: 'Zerollama',
    fullUnicode: true,
    warnings: false,
  });

  // ─── Top banner ───────────────────────────────────────────────────────────
  const localIPs = getLocalIPs();
  const netAddrs = localIPs.map((ip) => `http://${ip}:${PORT}`).join('  │  ');
  bannerBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    style: { bg: 'black', fg: 'white' },
    content: buildBannerContent(netAddrs),
    border: { type: 'line' },
  });
  (bannerBox as any).style.border = { fg: 'cyan' };

  // ─── Left pane: info ──────────────────────────────────────────────────────
  infoBox = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: '25%',
    height: '100%-4',
    border: { type: 'line' },
    label: ' {bold}Info{/bold} ',
    tags: true,
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'white', bold: true },
    },
    content: buildInfoContent(),
  });

  // ─── Debug chat (hidden by default) ───────────────────────────────────────
  debugBox = blessed.log({
    parent: screen,
    top: '40%',
    left: 0,
    width: '25%',
    height: '60%-4',
    border: { type: 'line' },
    label: ' {bold}Debug Chat{/bold} ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: 'yellow' } },
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
    },
    mouse: true,
    hidden: true,
  });

  debugInput = blessed.textbox({
    parent: screen,
    top: '100%-4',
    left: 0,
    width: '25%',
    height: 3,
    border: { type: 'line' },
    label: ' {bold}Ask ↵{/bold} ',
    tags: true,
    inputOnFocus: true,
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
      focus: { border: { fg: 'white' } },
    },
    hidden: true,
  });

  debugInput.on('focus', () => {
    debugFocused = true;
  });
  debugInput.on('blur', () => {
    debugFocused = false;
  });

  debugInput.on('submit', (value: string) => {
    debugInput.clearValue();
    scheduleRender();
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
      debugInput.readInput();
      return;
    }
    if (trimmed === ':q') {
      toggleDebug();
      return;
    }
    // Run query then always re-enable input
    runDebugQuery(trimmed).finally(() => {
      if (debugVisible) debugInput.readInput();
    });
  });

  debugInput.key('escape', () => {
    debugInput.cancel();
    toggleDebug();
  });

  // ─── Middle pane: Zerollama logs (top half) ──────────────────────────────
  zerollamaLogBox = blessed.log({
    parent: screen,
    top: 3,
    left: '25%',
    width: '40%',
    height: '50%-2',
    border: { type: 'line' },
    label: ' {bold}Zerollama{/bold} {gray-fg}nowrap{/gray-fg} ',
    tags: true,
    wrap: false,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'cyan' },
    },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'white', bold: true },
    },
    mouse: true,
  });

  // ─── Middle pane: Ollama logs (bottom half) ───────────────────────────────
  ollamaLogBox = blessed.log({
    parent: screen,
    top: '50%+1',
    left: '25%',
    width: '40%',
    height: '50%-2',
    border: { type: 'line' },
    label: ' {bold}Ollama{/bold} {gray-fg}nowrap{/gray-fg} ',
    tags: true,
    wrap: false,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'yellow' },
    },
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'white', bold: true },
    },
    mouse: true,
  });

  // ─── Right pane: responses ────────────────────────────────────────────────
  responsesBox = blessed.log({
    parent: screen,
    top: 3,
    left: '65%',
    width: '35%',
    height: '100%-4',
    border: { type: 'line' },
    label: ' {bold}Responses{/bold} {gray-fg}truncated{/gray-fg} ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'cyan' },
    },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'white', bold: true },
    },
    mouse: true,
  });

  // ─── Bottom status bar ────────────────────────────────────────────────────
  statusLine = blessed.text({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: {
      bg: 'black',
      fg: 'white',
    },
    content: ' … checking Ollama ',
  });

  // ─── Key bindings (handled by blessed, not raw stdin) ─────────────────────
  screen.key(['q', 'C-c'], () => onQuit());

  screen.render();
}

export function startStatusMonitor(initialStatus: boolean): NodeJS.Timeout {
  setOllamaStatus(initialStatus);

  // Immediately detect first model on startup
  if (initialStatus && !selectedModel) {
    fetch(`${OLLAMA_URL}/api/tags`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data) {
          detectedModel = data.models?.[0]?.name ?? null;
          refreshUI();
        }
      })
      .catch(() => {});
  }

  let lastStatus = initialStatus;
  const interval = setInterval(async () => {
    const reachable = await checkConnection();
    if (reachable !== lastStatus) {
      const ts = new Date().toISOString();
      const label = reachable ? '● reachable' : '● unreachable';
      log(`[${ts}] Ollama is now ${label}`);
      lastStatus = reachable;
      setOllamaStatus(reachable);
    } else {
      refreshUI();
    }
    // Auto-detect first model when none selected
    if (reachable && !selectedModel) {
      try {
        const resp = await fetch(`${OLLAMA_URL}/api/tags`);
        if (resp.ok) {
          const data = (await resp.json()) as any;
          const first = data.models?.[0]?.name ?? null;
          if (first !== detectedModel) {
            detectedModel = first;
            refreshUI();
          }
        }
      } catch {}
    }
  }, 5_000);
  interval.unref();
  return interval;
}

export function getScreen(): blessed.Widgets.Screen | undefined {
  return screen;
}

// ─── Debug chat ────────────────────────────────────────────────────────────
export function toggleDebug(): void {
  debugVisible = !debugVisible;
  if (debugVisible) {
    // Enable Ollama debug logging
    setOllamaConfig({ debug: '1' });
    log(
      `[${new Date().toISOString()}] Debug mode ON — OLLAMA_DEBUG=1 (restart Ollama to apply)`,
    );
    infoBox.height = '40%-3';
    debugBox.show();
    debugInput.show();
    scheduleRender();
    debugInput.readInput();
  } else {
    setOllamaConfig({ debug: '0' });
    log(`[${new Date().toISOString()}] Debug mode OFF — OLLAMA_DEBUG=0`);
    debugFocused = false;
    infoBox.height = '100%-4';
    debugBox.hide();
    debugInput.hide();
    debugInput.cancel();
    screen.realloc();
    scheduleRender();
  }
}

export function isDebugFocused(): boolean {
  return debugFocused;
}

export function isDebugVisible(): boolean {
  return debugVisible;
}

export function isModelPickerActive(): boolean {
  return modelPickerActive;
}

// ─── Model picker ──────────────────────────────────────────────────────────
interface OllamaModel {
  name: string;
  size: number;
  parameterSize: string;
  quantization: string;
  family: string;
}

async function fetchModels(): Promise<OllamaModel[]> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    return (data.models ?? []).map((m: any) => ({
      name: m.name,
      size: m.size ?? 0,
      parameterSize: m.details?.parameter_size ?? '?',
      quantization: m.details?.quantization_level ?? '?',
      family: m.details?.family ?? '?',
    }));
  } catch {
    return [];
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return bytes + ' B';
}

export async function showModelPicker(): Promise<void> {
  if (modelPickerActive) return;
  modelPickerActive = true;

  const models = await fetchModels();
  const items = [
    ...models.map((m) => {
      const sel = m.name === selectedModel ? '{green-fg}● {/green-fg}' : '  ';
      const star = m.name === defaultModel ? ' {yellow-fg}★{/yellow-fg}' : '';
      return `${sel}${m.name}${star}  {gray-fg}${m.parameterSize} │ ${m.quantization} │ ${formatSize(m.size)}{/gray-fg}`;
    }),
    '{green-fg}+ Install new model…{/green-fg}',
    '{yellow-fg}⌕ Search HuggingFace…{/yellow-fg}',
  ];

  const list = blessed.list({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '60%',
    height: Math.min(items.length + 2, 20),
    border: { type: 'line' },
    label:
      ' {bold}Select Model{/bold}  {gray-fg}f{/gray-fg} default  {gray-fg}d{/gray-fg} delete ',
    tags: true,
    keys: false,
    vi: false,
    mouse: true,
    items,
    style: {
      border: { fg: 'magenta' },
      selected: { bg: 'magenta', fg: 'white' },
      item: { fg: 'white' },
    },
  });

  const current = models.findIndex((m) => m.name === selectedModel);
  if (current >= 0) list.select(current);

  list.focus();
  scheduleRender();

  // Navigate with j/k or up/down
  list.key(['j', 'down'], () => {
    list.down(1);
    scheduleRender();
  });
  list.key(['k', 'up'], () => {
    list.up(1);
    scheduleRender();
  });

  const handleModelSelect = (index: number) => {
    list.destroy();

    if (index === models.length) {
      modelPickerActive = false;
      showModelInstaller();
    } else if (index === models.length + 1) {
      showHFSearch();
    } else {
      modelPickerActive = false;
      const chosen = models[index].name;
      setSelectedModel(chosen);
      log(`[${new Date().toISOString()}] Model selected: ${chosen}`);
    }
    scheduleRender();
  };

  list.key(['enter', 'return'], () => {
    handleModelSelect((list as any).selected as number);
  });

  list.on('select', (_item: any, index: number) => {
    handleModelSelect(index);
  });

  // Set as default with 'f'
  list.key('f', () => {
    const idx = (list as any).selected as number;
    if (idx >= models.length) return;
    const model = models[idx];
    defaultModel = model.name;
    selectedModel = model.name;
    saveDefaultModel(model.name);
    log(`[${new Date().toISOString()}] Default model set: ${model.name}`);
    list.destroy();
    modelPickerActive = false;
    refreshUI();
  });

  // Delete model with 'd'
  list.key('d', () => {
    const idx = (list as any).selected as number;
    if (idx >= models.length) return; // can't delete action rows
    const model = models[idx];
    list.destroy();
    scheduleRender();
    confirmDeleteModel(model.name);
  });

  list.key('escape', () => {
    list.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

async function deleteModel(name: string): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function confirmDeleteModel(name: string): void {
  const dialog = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '50%',
    height: 7,
    border: { type: 'line' },
    tags: true,
    content: [
      '',
      `  Delete {bold}{red-fg}${name}{/red-fg}{/bold}?`,
      '',
      '  {red-fg}{bold}↵ Confirm{/bold}{/red-fg}  ·  {gray-fg}Esc Cancel{/gray-fg}',
    ].join('\n'),
    style: {
      border: { fg: 'red' },
    },
  });

  dialog.focus();
  scheduleRender();

  dialog.key('enter', async () => {
    dialog.destroy();
    scheduleRender();
    log(`[${new Date().toISOString()}] Deleting model: ${name}…`);
    const ok = await deleteModel(name);
    if (ok) {
      log(`[${new Date().toISOString()}] ✓ Deleted ${name}`);
      if (selectedModel === name) {
        selectedModel = null;
      }
      if (detectedModel === name) {
        detectedModel = null;
      }
      refreshUI();
    } else {
      log(`[${new Date().toISOString()}] ✗ Failed to delete ${name}`);
    }
    modelPickerActive = false;
    scheduleRender();
  });

  dialog.key('escape', () => {
    dialog.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

async function showModelInstaller(): Promise<void> {
  modelPickerActive = true;

  const input = blessed.textbox({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '50%',
    height: 3,
    border: { type: 'line' },
    label: ' {bold}Model name (e.g. llama3.2, gemma2){/bold} ',
    tags: true,
    inputOnFocus: true,
    style: {
      border: { fg: 'green' },
      label: { fg: 'green', bold: true },
      focus: { border: { fg: 'white' } },
    },
  });

  scheduleRender();
  input.readInput();

  input.on('submit', async (value: string) => {
    input.destroy();
    scheduleRender();
    const name = (value ?? '').trim();
    if (!name) {
      modelPickerActive = false;
      return;
    }
    await showModelConfirm(name);
  });

  input.key('escape', () => {
    input.cancel();
    input.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

async function fetchModelInfo(name: string): Promise<any | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function showModelConfirm(name: string): Promise<void> {
  const info = await fetchModelInfo(name);

  const lines: string[] = [];
  if (info) {
    const d = info.details ?? {};
    const mi = info.model_info ?? {};
    const family = d.family ?? '?';
    const params = d.parameter_size ?? '?';
    const quant = d.quantization_level ?? '?';
    const ctxKey = Object.keys(mi).find((k) => k.endsWith('.context_length'));
    const ctx = ctxKey ? mi[ctxKey] : null;
    const caps = (info.capabilities ?? []).join(', ') || '?';

    lines.push(`  {bold}${name}{/bold}  {green-fg}(installed){/green-fg}`);
    lines.push('');
    lines.push(`  Family        ${family}`);
    lines.push(`  Parameters    ${params}`);
    lines.push(`  Quantization  ${quant}`);
    if (ctx) lines.push(`  Context       ${ctx.toLocaleString()}`);
    lines.push(`  Capabilities  ${caps}`);
    lines.push('');
    lines.push('  {yellow-fg}Re-pull / update this model?{/yellow-fg}');
  } else {
    lines.push(`  {bold}${name}{/bold}  {gray-fg}(not installed){/gray-fg}`);
    lines.push('');
    lines.push(
      '  {yellow-fg}Download this model from the registry?{/yellow-fg}',
    );
  }
  lines.push('');
  lines.push(
    '  {green-fg}[Enter]{/green-fg} Confirm    {red-fg}[Esc]{/red-fg} Cancel',
  );

  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '55%',
    height: lines.length + 2,
    border: { type: 'line' },
    label: ' {bold}Model Info{/bold} ',
    tags: true,
    keys: true,
    content: lines.join('\n'),
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
    },
  });
  box.focus();
  scheduleRender();

  // Build pull info from fetched model details
  const pullInfo: PullModelInfo | undefined = info
    ? {
        name,
        architecture: info.details?.family ?? undefined,
        params: info.details?.parameter_size ?? undefined,
        quant: info.details?.quantization_level ?? undefined,
        context: (() => {
          const mi = info.model_info ?? {};
          const ctxKey = Object.keys(mi).find((k: string) =>
            k.endsWith('.context_length'),
          );
          return ctxKey ? String(mi[ctxKey]) : undefined;
        })(),
      }
    : undefined;

  box.key('return', async () => {
    box.destroy();
    scheduleRender();
    await pullModel(name, pullInfo);
    modelPickerActive = false;
  });

  box.key('escape', () => {
    box.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

interface PullModelInfo {
  name: string;
  size?: string;
  architecture?: string;
  context?: string;
  params?: string;
  quant?: string;
}

async function pullModel(name: string, info?: PullModelInfo): Promise<void> {
  const ts = () => new Date().toISOString().slice(11, 19);
  log(`[${ts()}] Pulling model: ${name}…`);

  const abortCtrl = new AbortController();
  let cancelled = false;

  // Build info header lines
  const infoLines: string[] = [];
  if (info) {
    const parts: string[] = [];
    if (info.architecture) parts.push(`{bold}Arch{/bold} ${info.architecture}`);
    if (info.params) parts.push(`{bold}Params{/bold} ${info.params}`);
    if (info.quant) parts.push(`{bold}Quant{/bold} ${info.quant}`);
    if (info.context) parts.push(`{bold}Ctx{/bold} ${info.context}`);
    if (info.size) parts.push(`{bold}Size{/bold} ${info.size}`);
    if (parts.length > 0) {
      infoLines.push(`  {cyan-fg}${parts.join('  │  ')}{/cyan-fg}`);
      infoLines.push('');
    }
  }
  const infoHeader = infoLines.join('\n');

  const progressBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: info ? 9 : 7,
    border: { type: 'line' },
    label: ` {bold}Installing ${name}{/bold}  {gray-fg}Esc cancel{/gray-fg} `,
    tags: true,
    keys: true,
    style: {
      border: { fg: 'green' },
      label: { fg: 'green', bold: true },
    },
    content: `${infoHeader}  Connecting to Ollama…`,
  });
  progressBox.focus();
  progressBox.key('escape', () => {
    cancelled = true;
    abortCtrl.abort();
    progressBox.setContent('  {yellow-fg}Cancelling…{/yellow-fg}');
    scheduleRender();
  });
  scheduleRender();

  try {
    log(`[${ts()}] POST ${OLLAMA_URL}/api/pull  name=${name}`);
    const resp = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: abortCtrl.signal,
    });

    log(`[${ts()}] Pull response: HTTP ${resp.status}`);

    if (!resp.ok || !resp.body) {
      const body = resp.body ? await resp.text() : '(no body)';
      log(`[${ts()}] Pull HTTP error: ${resp.status} — ${body}`);
      progressBox.setContent(`  {red-fg}Error: HTTP ${resp.status}{/red-fg}`);
      scheduleRender();
      await new Promise((r) => setTimeout(r, 2000));
      progressBox.destroy();
      scheduleRender();
      return;
    }

    const reader = (resp.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let pullError = '';
    let lastLoggedStatus = '';
    let lineCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        lineCount++;
        try {
          const j = JSON.parse(line);

          if (j.error) {
            pullError = j.error;
            log(`[${ts()}] Pull error in stream: ${j.error}`);
            break;
          }

          const status = j.status ?? '';
          const digest = j.digest ? j.digest.slice(0, 12) : '';
          const completed = j.completed ?? 0;
          const total = j.total ?? 0;

          // Log every distinct status change + periodic progress
          const statusKey = `${status}:${digest}`;
          if (statusKey !== lastLoggedStatus) {
            const sizeInfo = total > 0 ? ` (${formatSize(total)})` : '';
            log(`[${ts()}] Pull: ${status} ${digest}${sizeInfo}`);
            lastLoggedStatus = statusKey;
          }

          // Build detailed progress display
          const progressLines: string[] = [];
          if (total > 0 && completed > 0) {
            const pct = Math.round((completed / total) * 100);
            const bar =
              '█'.repeat(Math.floor(pct / 4)) +
              '░'.repeat(25 - Math.floor(pct / 4));
            progressLines.push(`  ${status} ${digest}`);
            progressLines.push(
              `  [${bar}] ${pct}%  ${formatSize(completed)} / ${formatSize(total)}`,
            );
          } else if (total > 0) {
            progressLines.push(`  ${status} ${digest}`);
            progressLines.push(`  waiting… (${formatSize(total)})`);
          } else {
            progressLines.push(`  ${status}`);
          }

          const safe = progressLines
            .map((l) => l.replace(/\{/g, '{{').replace(/\}/g, '}}'))
            .join('\n');
          progressBox.setContent(`${infoHeader}${safe}`);
          scheduleRender();
        } catch (parseErr) {
          log(
            `[${ts()}] Pull: unparseable line #${lineCount}: ${line.slice(0, 120)}`,
          );
        }
      }
      if (pullError) break;
    }

    log(`[${ts()}] Pull stream ended after ${lineCount} lines`);

    if (pullError) {
      const safeErr = pullError.replace(/\{/g, '{{').replace(/\}/g, '}}');
      progressBox.setContent(`  {red-fg}Error: ${safeErr}{/red-fg}`);
      log(`[${ts()}] Pull failed: ${pullError}`);
      scheduleRender();
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      progressBox.setContent('  {green-fg}✓ Installed successfully{/green-fg}');
      scheduleRender();
      setSelectedModel(name);
      log(`[${ts()}] Model installed: ${name}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err: any) {
    if (cancelled) {
      progressBox.setContent('  {yellow-fg}Pull cancelled{/yellow-fg}');
      log(`[${ts()}] Pull cancelled: ${name}`);
    } else {
      const msg = (err.message ?? '').replace(/\{/g, '{{').replace(/\}/g, '}}');
      progressBox.setContent(`  {red-fg}Error: ${msg}{/red-fg}`);
      log(`[${ts()}] Pull failed: ${err.message}`);
    }
    scheduleRender();
    await new Promise((r) => setTimeout(r, 2000));
  }
  progressBox.destroy();
  scheduleRender();
}

async function getDefaultModel(): Promise<string | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    return data.models?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

async function runDebugQuery(prompt: string): Promise<void> {
  const ts = () => new Date().toISOString().slice(11, 19);
  const truncPrompt = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
  const safePrompt = truncPrompt.replace(/\{/g, '{{').replace(/\}/g, '}}');
  debugBox.log(`{yellow-fg}${ts()}  Q:{/yellow-fg} ${safePrompt}`);
  log(`[${ts()}] Debug: "${truncPrompt}"`);
  scheduleRender();

  // Use selected model or auto-detect
  const model = selectedModel ?? (await getDefaultModel());
  if (!model) {
    debugBox.log(`{red-fg}  No models found on Ollama{/red-fg}`);
    log(`[${ts()}] Debug: no models found`);
    debugBox.log('');
    scheduleRender();
    return;
  }

  // Loading indicator (static — no interval to avoid render conflicts)
  debugInput.setLabel(' {bold}⠹ thinking…{/bold} ');
  scheduleRender();

  const start = performance.now();
  try {
    log(`[${ts()}] Debug: querying ${model}…`);
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
    });
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const safeErr = errBody
        .replace(/\{/g, '{{')
        .replace(/\}/g, '}}')
        .slice(0, 300);
      debugBox.log(`{red-fg}  Error: HTTP ${resp.status}{/red-fg}`);
      if (safeErr) {
        debugBox.log(`{red-fg}  ${safeErr}{/red-fg}`);
      }
      debugBox.log('');
      log(`[${ts()}] Debug: HTTP ${resp.status} — ${errBody.slice(0, 500)}`);
      scheduleRender();
      return;
    }

    const data = (await resp.json()) as any;
    const answer = (data.message?.content ?? '')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const truncAnswer =
      answer.length > 200 ? answer.slice(0, 197) + '…' : answer;
    const safeAnswer = truncAnswer.replace(/\{/g, '{{').replace(/\}/g, '}}');
    const promptTk = data.prompt_eval_count ?? 0;
    const completionTk = data.eval_count ?? 0;

    debugBox.log(`{green-fg}  A:{/green-fg} ${safeAnswer}`);
    debugBox.log(
      `  {cyan-fg}${elapsed}s{/cyan-fg}  tok: {bold}${promptTk}{/bold} in / {bold}${completionTk}{/bold} out  total {bold}${promptTk + completionTk}{/bold}`,
    );
    debugBox.log('');
    log(
      `[${ts()}] Debug: done in ${elapsed}s (${promptTk + completionTk} tokens)`,
    );
  } catch (err: any) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    debugBox.log(`{red-fg}  Error (${elapsed}s): ${err.message}{/red-fg}`);
    debugBox.log('');
    log(`[${ts()}] Debug error: ${err.message}`);
  } finally {
    debugInput.setLabel(' {bold}Ask ↵{/bold} ');
    scheduleRender();
  }
}

// ─── HuggingFace search ─────────────────────────────────────────────────────
interface HFModel {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  pipelineTag: string;
  sizeBytes: number;
}

interface HFModelDetail {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  pipelineTag: string;
  license: string;
  language: string[];
  architecture: string;
  contextLength: number;
  totalSize: number;
  baseModel: string;
  lastModified: string;
  ggufFiles: string[];
}

async function searchHuggingFace(query: string): Promise<HFModel[]> {
  try {
    const params = new URLSearchParams({
      search: query,
      filter: 'gguf',
      pipeline_tag: 'text-generation',
      sort: 'downloads',
      direction: '-1',
      limit: '20',
    });
    const url = `https://huggingface.co/api/models?${params}&expand[]=gguf`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    return data.map((m) => ({
      id: m.id ?? m.modelId ?? '?',
      author: m.author ?? '?',
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      pipelineTag: m.pipeline_tag ?? '',
      sizeBytes: m.gguf?.total ?? 0,
    }));
  } catch {
    return [];
  }
}

async function fetchHFModelDetail(
  modelId: string,
): Promise<HFModelDetail | null> {
  try {
    const resp = await fetch(`https://huggingface.co/api/models/${modelId}`);
    if (!resp.ok) return null;
    const d = (await resp.json()) as any;
    const gguf = d.gguf ?? {};
    const card = d.cardData ?? {};
    const siblings = (d.siblings ?? []) as any[];
    const ggufFiles = siblings
      .map((s: any) => s.rfilename ?? '')
      .filter((f: string) => f.endsWith('.gguf'));
    return {
      id: d.id ?? modelId,
      author: d.author ?? '?',
      downloads: d.downloads ?? 0,
      likes: d.likes ?? 0,
      pipelineTag: d.pipeline_tag ?? '',
      license: card.license ?? d.license ?? '?',
      language: card.language ?? [],
      architecture: gguf.architecture ?? d.config?.model_type ?? '?',
      contextLength: gguf.context_length ?? 0,
      totalSize: gguf.total ?? 0,
      baseModel: card.base_model ?? '',
      lastModified: d.lastModified ?? '',
      ggufFiles,
    };
  } catch {
    return null;
  }
}

function formatCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

async function showHFSearch(): Promise<void> {
  modelPickerActive = true;

  const input = blessed.textbox({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '50%',
    height: 3,
    border: { type: 'line' },
    label: ' {bold}Search HuggingFace (GGUF){/bold} ',
    tags: true,
    inputOnFocus: true,
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
      focus: { border: { fg: 'white' } },
    },
  });

  scheduleRender();
  input.readInput();

  input.on('submit', async (value: string) => {
    input.destroy();
    scheduleRender();
    const query = (value ?? '').trim();
    if (!query) {
      modelPickerActive = false;
      return;
    }
    await showHFResults(query);
  });

  input.key('escape', () => {
    input.cancel();
    input.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

async function showHFResults(query: string): Promise<void> {
  const loadingBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '60%',
    height: 3,
    border: { type: 'line' },
    tags: true,
    content: '  Searching HuggingFace…',
    style: { border: { fg: 'yellow' } },
  });
  scheduleRender();

  const models = await searchHuggingFace(query);
  loadingBox.destroy();

  if (models.length === 0) {
    const errBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '40%',
      height: 3,
      border: { type: 'line' },
      tags: true,
      content: '  {red-fg}No GGUF models found{/red-fg}',
      style: { border: { fg: 'red' } },
    });
    scheduleRender();
    await new Promise((r) => setTimeout(r, 1500));
    errBox.destroy();
    modelPickerActive = false;
    scheduleRender();
    return;
  }

  const items = models.map((m) => {
    const tag = m.pipelineTag ? `{blue-fg}${m.pipelineTag}{/blue-fg} ` : '';
    const size =
      m.sizeBytes > 0
        ? `{yellow-fg}${formatSize(m.sizeBytes)}{/yellow-fg} `
        : '';
    return `  ${m.id}  ${tag}${size}{gray-fg}↓${formatCount(m.downloads)} ♥${m.likes}{/gray-fg}`;
  });

  const list = blessed.list({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: Math.min(items.length + 2, 22),
    border: { type: 'line' },
    label: ` {bold}HuggingFace GGUF: "${query}"{/bold} `,
    tags: true,
    keys: false,
    vi: false,
    mouse: true,
    items,
    style: {
      border: { fg: 'yellow' },
      selected: { bg: 'yellow', fg: 'black' },
      item: { fg: 'white' },
    },
  });

  list.focus();
  scheduleRender();

  list.key(['j', 'down'], () => {
    list.down(1);
    scheduleRender();
  });
  list.key(['k', 'up'], () => {
    list.up(1);
    scheduleRender();
  });

  const handleHFSelect = async (index: number) => {
    list.destroy();
    scheduleRender();
    const chosen = models[index];
    await showHFModelDetail(chosen);
  };

  list.key(['enter', 'return'], () => {
    handleHFSelect((list as any).selected as number);
  });

  list.on('select', (_item: any, index: number) => {
    handleHFSelect(index);
  });

  list.key('escape', () => {
    list.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

async function showHFModelDetail(model: HFModel): Promise<void> {
  const loadingBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '60%',
    height: 3,
    border: { type: 'line' },
    tags: true,
    content: `  Loading info for {bold}${model.id}{/bold}…`,
    style: { border: { fg: 'yellow' } },
  });
  scheduleRender();

  const detail = await fetchHFModelDetail(model.id);
  loadingBox.destroy();

  if (!detail) {
    const errBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '40%',
      height: 3,
      border: { type: 'line' },
      tags: true,
      content: '  {red-fg}Failed to fetch model details{/red-fg}',
      style: { border: { fg: 'red' } },
    });
    scheduleRender();
    await new Promise((r) => setTimeout(r, 1500));
    errBox.destroy();
    modelPickerActive = false;
    scheduleRender();
    return;
  }

  const lines: string[] = [
    '',
    `  {bold}{yellow-fg}${detail.id}{/yellow-fg}{/bold}`,
    `  by {cyan-fg}${detail.author}{/cyan-fg}`,
    '',
    `  {bold}Architecture{/bold}   ${detail.architecture}`,
    `  {bold}Pipeline{/bold}       ${detail.pipelineTag || '?'}`,
    `  {bold}Context{/bold}        ${detail.contextLength > 0 ? detail.contextLength.toLocaleString() : '?'}`,
    `  {bold}Size{/bold}           ${detail.totalSize > 0 ? formatSize(detail.totalSize) : '?'}`,
    `  {bold}License{/bold}        ${detail.license}`,
    `  {bold}Language{/bold}       ${detail.language.length ? detail.language.join(', ') : '?'}`,
    `  {bold}Base model{/bold}     ${detail.baseModel || '—'}`,
    `  {bold}Downloads{/bold}      ${formatCount(detail.downloads)}`,
    `  {bold}Likes{/bold}          ${detail.likes}`,
    `  {bold}Updated{/bold}        ${detail.lastModified ? detail.lastModified.split('T')[0] : '?'}`,
    '',
    `  {bold}GGUF files ({yellow-fg}${detail.ggufFiles.length}{/yellow-fg}){/bold}`,
  ];

  const maxFiles = 8;
  for (let i = 0; i < Math.min(detail.ggufFiles.length, maxFiles); i++) {
    lines.push(`    {gray-fg}${detail.ggufFiles[i]}{/gray-fg}`);
  }
  if (detail.ggufFiles.length > maxFiles) {
    lines.push(
      `    {gray-fg}… and ${detail.ggufFiles.length - maxFiles} more{/gray-fg}`,
    );
  }

  lines.push('');
  lines.push(
    '  {green-fg}{bold}↵ Pull{/bold}{/green-fg}  ·  {gray-fg}Esc Cancel{/gray-fg}',
  );
  lines.push('');

  const boxHeight = Math.min(lines.length + 2, 28);

  const infoDialog = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '65%',
    height: boxHeight,
    border: { type: 'line' },
    label: ' {bold}Model Info{/bold} ',
    tags: true,
    scrollable: true,
    keys: true,
    vi: true,
    mouse: true,
    content: lines.join('\n'),
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
    },
  });

  infoDialog.focus();
  scheduleRender();

  infoDialog.key('enter', async () => {
    infoDialog.destroy();
    scheduleRender();
    const pullName = `hf.co/${detail.id}`;
    const pullInfo: PullModelInfo = {
      name: detail.id,
      size: detail.totalSize > 0 ? formatSize(detail.totalSize) : undefined,
      architecture:
        detail.architecture !== '?' ? detail.architecture : undefined,
      context:
        detail.contextLength > 0
          ? detail.contextLength.toLocaleString()
          : undefined,
    };
    log(`[${new Date().toISOString()}] Pulling HF model: ${pullName}`);
    await pullModel(pullName, pullInfo);
    modelPickerActive = false;
  });

  infoDialog.key('escape', () => {
    infoDialog.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

// ─── Config editor ────────────────────────────────────────────────────────────
interface ConfigField {
  key: keyof OllamaConfig;
  label: string;
  desc: string;
}

const CONFIG_FIELDS: ConfigField[] = [
  {
    key: 'maxLoadedModels',
    label: 'Max Loaded Models',
    desc: 'Models kept in memory (0 = auto)',
  },
  { key: 'numParallel', label: 'Num Parallel', desc: 'Parallel request slots' },
  { key: 'flashAttention', label: 'Flash Attention', desc: '1 = on, 0 = off' },
  { key: 'numGpu', label: 'Num GPU', desc: 'GPU layers (999 = all)' },
  { key: 'keepAlive', label: 'Keep Alive', desc: 'e.g. 5m, 24h, -1 (forever)' },
  {
    key: 'contextLength',
    label: 'Context Length',
    desc: 'empty = auto (4k/32k/256k based on VRAM)',
  },
  {
    key: 'kvCacheType',
    label: 'KV Cache Type',
    desc: 'f16, q8_0, q4_0 (empty = f16)',
  },
  {
    key: 'gpuOverhead',
    label: 'GPU Overhead',
    desc: 'Reserved VRAM per GPU (bytes)',
  },
  {
    key: 'loadTimeout',
    label: 'Load Timeout',
    desc: 'Stall timeout for model loads (e.g. 5m)',
  },
  { key: 'maxQueue', label: 'Max Queue', desc: 'Max queued requests' },
  { key: 'debug', label: 'Debug', desc: '1 = verbose Ollama logging' },
  {
    key: 'schedSpread',
    label: 'Sched Spread',
    desc: '1 = spread model across all GPUs',
  },
  {
    key: 'multiuserCache',
    label: 'Multiuser Cache',
    desc: '1 = optimize prompt cache for multi-user',
  },
];

interface ConfigPreset {
  name: string;
  desc: string;
  platform: 'apple' | 'nvidia' | 'any';
  config: Partial<OllamaConfig>;
}

function detectPlatform(): 'apple' | 'nvidia' | 'unknown' {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'arm'))
    return 'apple';
  // Check for NVIDIA GPU on Linux/Windows
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null',
      { encoding: 'utf-8', timeout: 3000 },
    );
    if (out.trim()) return 'nvidia';
  } catch {}
  return 'unknown';
}

const detectedPlatform = detectPlatform();

const CONFIG_PRESETS: ConfigPreset[] = [
  {
    name: 'Apple Silicon M4 Pro 48GB',
    desc: 'Optimized for M4 Pro with 48GB unified memory',
    platform: 'apple',
    config: {
      maxLoadedModels: '2',
      numParallel: '4',
      flashAttention: '1',
      numGpu: '999',
      keepAlive: '24h',
      contextLength: '32768',
      kvCacheType: 'q8_0',
      gpuOverhead: '0',
      loadTimeout: '5m',
      maxQueue: '512',
      debug: '0',
      schedSpread: '0',
      multiuserCache: '0',
    },
  },
  {
    name: 'Apple Silicon M4 Pro 24GB',
    desc: 'Balanced for M4 Pro with 24GB unified memory',
    platform: 'apple',
    config: {
      maxLoadedModels: '1',
      numParallel: '2',
      flashAttention: '1',
      numGpu: '999',
      keepAlive: '24h',
      contextLength: '8192',
      kvCacheType: 'q4_0',
      gpuOverhead: '0',
      loadTimeout: '5m',
      maxQueue: '512',
      debug: '0',
      schedSpread: '0',
      multiuserCache: '0',
    },
  },
  {
    name: 'NVIDIA RTX 5090 (32GB)',
    desc: 'Max performance for RTX 5090 32GB VRAM',
    platform: 'nvidia',
    config: {
      maxLoadedModels: '2',
      numParallel: '4',
      flashAttention: '1',
      numGpu: '999',
      keepAlive: '24h',
      contextLength: '32768',
      kvCacheType: 'q8_0',
      gpuOverhead: '524288000',
      loadTimeout: '5m',
      maxQueue: '512',
      debug: '0',
      schedSpread: '0',
      multiuserCache: '0',
    },
  },
  {
    name: 'NVIDIA RTX 5070 (12GB)',
    desc: 'Balanced for RTX 5070 12GB VRAM',
    platform: 'nvidia',
    config: {
      maxLoadedModels: '1',
      numParallel: '2',
      flashAttention: '1',
      numGpu: '999',
      keepAlive: '24h',
      contextLength: '8192',
      kvCacheType: 'q4_0',
      gpuOverhead: '524288000',
      loadTimeout: '5m',
      maxQueue: '512',
      debug: '0',
      schedSpread: '0',
      multiuserCache: '0',
    },
  },
  {
    name: 'NVIDIA RTX 3070 (8GB)',
    desc: 'Conservative for RTX 3070 8GB VRAM',
    platform: 'nvidia',
    config: {
      maxLoadedModels: '1',
      numParallel: '1',
      flashAttention: '1',
      numGpu: '999',
      keepAlive: '5m',
      contextLength: '4096',
      kvCacheType: 'q4_0',
      gpuOverhead: '524288000',
      loadTimeout: '5m',
      maxQueue: '256',
      debug: '0',
      schedSpread: '0',
      multiuserCache: '0',
    },
  },
  {
    name: 'Low Memory (8-16GB)',
    desc: 'Conservative settings for limited memory',
    platform: 'any',
    config: {
      maxLoadedModels: '1',
      numParallel: '1',
      flashAttention: '1',
      numGpu: '999',
      keepAlive: '5m',
      contextLength: '4096',
      kvCacheType: 'q4_0',
      gpuOverhead: '0',
      loadTimeout: '5m',
      maxQueue: '256',
      debug: '0',
      schedSpread: '0',
      multiuserCache: '0',
    },
  },
  {
    name: 'Server / Multi-user',
    desc: 'High throughput for multiple concurrent users',
    platform: 'any',
    config: {
      maxLoadedModels: '2',
      numParallel: '8',
      flashAttention: '1',
      numGpu: '999',
      keepAlive: '-1',
      contextLength: '8192',
      kvCacheType: 'q8_0',
      gpuOverhead: '0',
      loadTimeout: '10m',
      maxQueue: '1024',
      debug: '0',
      schedSpread: '0',
      multiuserCache: '1',
    },
  },
];

export function showConfigEditor(): void {
  if (modelPickerActive) return;
  modelPickerActive = true;

  const cfg = getOllamaConfig();
  const items = CONFIG_FIELDS.map(
    (f) =>
      `  {bold}${f.label}{/bold}  {cyan-fg}${cfg[f.key]}{/cyan-fg}  {gray-fg}${f.desc}{/gray-fg}`,
  );

  const list = blessed.list({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '60%',
    height: items.length + 2,
    border: { type: 'line' },
    label: ' {bold}Ollama Config{/bold}  {gray-fg}↵ edit  p preset{/gray-fg} ',
    tags: true,
    keys: false,
    vi: false,
    mouse: true,
    items,
    style: {
      border: { fg: 'cyan' },
      selected: { bg: 'cyan', fg: 'black' },
      item: { fg: 'white' },
    },
  });

  list.focus();
  scheduleRender();

  list.key(['j', 'down'], () => {
    list.down(1);
    scheduleRender();
  });
  list.key(['k', 'up'], () => {
    list.up(1);
    scheduleRender();
  });

  const handleEdit = (index: number) => {
    const field = CONFIG_FIELDS[index];
    list.destroy();
    scheduleRender();
    editConfigField(field);
  };

  list.key(['enter', 'return'], () => {
    handleEdit((list as any).selected as number);
  });

  list.on('select', (_item: any, index: number) => {
    handleEdit(index);
  });

  list.key('escape', () => {
    list.destroy();
    modelPickerActive = false;
    scheduleRender();
  });

  list.key('p', () => {
    list.destroy();
    scheduleRender();
    showPresetPicker();
  });
}

function showPresetPicker(): void {
  const items = CONFIG_PRESETS.map((p) => {
    const compatible = p.platform === 'any' || p.platform === detectedPlatform;
    if (compatible) {
      return `  {bold}${p.name}{/bold}  {gray-fg}${p.desc}{/gray-fg}`;
    }
    return `  {gray-fg}${p.name}  ${p.desc}{/gray-fg}`;
  });

  const list = blessed.list({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '60%',
    height: items.length + 2,
    border: { type: 'line' },
    label: ` {bold}Presets{/bold}  {gray-fg}↵ apply  (${detectedPlatform}){/gray-fg} `,
    tags: true,
    keys: false,
    vi: false,
    mouse: true,
    items,
    style: {
      border: { fg: 'green' },
      selected: { bg: 'green', fg: 'black' },
      item: { fg: 'white' },
    },
  });

  list.focus();
  scheduleRender();

  list.key(['j', 'down'], () => {
    list.down(1);
    scheduleRender();
  });
  list.key(['k', 'up'], () => {
    list.up(1);
    scheduleRender();
  });

  const applyPreset = (index: number) => {
    const preset = CONFIG_PRESETS[index];
    const compatible =
      preset.platform === 'any' || preset.platform === detectedPlatform;
    if (!compatible) {
      log(
        `[${new Date().toISOString()}] Preset "${preset.name}" is not compatible with this device (${detectedPlatform})`,
      );
      return;
    }
    list.destroy();
    setOllamaConfig(preset.config);
    log(
      `[${new Date().toISOString()}] Preset applied: ${preset.name} (restart Ollama to apply)`,
    );
    modelPickerActive = false;
    refreshUI();
  };

  list.key(['enter', 'return'], () => {
    applyPreset((list as any).selected as number);
  });

  list.on('select', (_item: any, index: number) => {
    applyPreset(index);
  });

  list.key('escape', () => {
    list.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

function editConfigField(field: ConfigField): void {
  const cfg = getOllamaConfig();
  const input = blessed.textbox({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '50%',
    height: 3,
    border: { type: 'line' },
    label: ` {bold}${field.label}{/bold}  {gray-fg}${field.desc}{/gray-fg} `,
    tags: true,
    inputOnFocus: true,
    value: cfg[field.key],
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
      focus: { border: { fg: 'white' } },
    },
  });

  scheduleRender();
  input.readInput();

  input.on('submit', (value: string) => {
    input.destroy();
    const val = (value ?? '').trim();
    if (val) {
      setOllamaConfig({ [field.key]: val });
      log(
        `[${new Date().toISOString()}] Config: ${field.label} = ${val} (restart Ollama to apply)`,
      );
    }
    modelPickerActive = false;
    scheduleRender();
  });

  input.key('escape', () => {
    input.cancel();
    input.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

// ─── Benchmark ────────────────────────────────────────────────────────────────
const BENCH_QUESTIONS = [
  'Explain quantum computing in 2 sentences.',
  'Write a JavaScript function to reverse a string.',
  'What are the three laws of thermodynamics? Be brief.',
];

interface BenchResult {
  question: string;
  timeSec: number;
  promptTokens: number;
  completionTokens: number;
  tokPerSec: number;
}

interface BenchRun {
  model: string;
  date: string;
  results: BenchResult[];
  avgTime: number;
  avgTokPerSec: number;
  totalTokens: number;
}

const benchScoreboard: BenchRun[] = [];

async function runBenchQuestion(
  model: string,
  question: string,
): Promise<BenchResult | null> {
  try {
    const start = performance.now();
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: question }],
        stream: false,
      }),
    });
    const elapsed = (performance.now() - start) / 1000;
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const promptTk = data.prompt_eval_count ?? 0;
    const completionTk = data.eval_count ?? 0;
    const tokPerSec = elapsed > 0 ? completionTk / elapsed : 0;
    return {
      question,
      timeSec: parseFloat(elapsed.toFixed(2)),
      promptTokens: promptTk,
      completionTokens: completionTk,
      tokPerSec: parseFloat(tokPerSec.toFixed(1)),
    };
  } catch {
    return null;
  }
}

export async function runBenchmark(): Promise<void> {
  if (modelPickerActive) return;
  modelPickerActive = true;

  const model = selectedModel ?? detectedModel ?? (await getDefaultModel());
  if (!model) {
    log(`[${new Date().toISOString()}] Benchmark: no model available`);
    modelPickerActive = false;
    return;
  }

  const progressBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: BENCH_QUESTIONS.length + 6,
    border: { type: 'line' },
    label: ` {bold}Benchmark: ${model}{/bold}  {gray-fg}Esc cancel{/gray-fg} `,
    tags: true,
    keys: true,
    scrollable: true,
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
    },
    content: '  Warming up…',
  });
  progressBox.focus();

  let cancelled = false;
  progressBox.key('escape', () => {
    cancelled = true;
  });
  scheduleRender();

  log(`[${new Date().toISOString()}] Benchmark started: ${model}`);

  // Flush all loaded models to get a clean benchmark
  try {
    const models = await fetchModels();
    for (const m of models) {
      log(`[${new Date().toISOString()}] Flushing ${m.name}…`);
      await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
      }).catch(() => {});
    }
    if (models.length > 0) {
      log(`[${new Date().toISOString()}] Flushed ${models.length} model(s)`);
    }
  } catch {
    log(`[${new Date().toISOString()}] Could not flush models`);
  }

  if (cancelled) {
    progressBox.destroy();
    modelPickerActive = false;
    scheduleRender();
    return;
  }

  const results: BenchResult[] = [];
  for (let i = 0; i < BENCH_QUESTIONS.length; i++) {
    if (cancelled) break;
    const q = BENCH_QUESTIONS[i];

    const pLines: string[] = [''];
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const sq =
        BENCH_QUESTIONS[j].length > 40
          ? BENCH_QUESTIONS[j].slice(0, 37) + '…'
          : BENCH_QUESTIONS[j];
      const safeSQ = sq.replace(/\{/g, '{{').replace(/\}/g, '}}');
      pLines.push(
        `  {green-fg}✓{/green-fg} ${safeSQ}  {cyan-fg}${r.timeSec}s{/cyan-fg}  {gray-fg}${r.tokPerSec} tok/s{/gray-fg}`,
      );
    }
    const shortQ = q.length > 40 ? q.slice(0, 37) + '…' : q;
    const safeQ = shortQ.replace(/\{/g, '{{').replace(/\}/g, '}}');
    pLines.push(
      `  {yellow-fg}⠹{/yellow-fg} ${safeQ}  {gray-fg}running…{/gray-fg}`,
    );
    for (let j = i + 1; j < BENCH_QUESTIONS.length; j++) {
      const sq =
        BENCH_QUESTIONS[j].length > 40
          ? BENCH_QUESTIONS[j].slice(0, 37) + '…'
          : BENCH_QUESTIONS[j];
      const safeSQ = sq.replace(/\{/g, '{{').replace(/\}/g, '}}');
      pLines.push(`  {gray-fg}○ ${safeSQ}{/gray-fg}`);
    }
    progressBox.setContent(pLines.join('\n'));
    scheduleRender();

    const result = await runBenchQuestion(model, q);
    if (!result) {
      log(`[${new Date().toISOString()}] Benchmark Q${i + 1} failed`);
      progressBox.setContent(
        progressBox.getContent() +
          '\n  {red-fg}Question failed — aborting{/red-fg}',
      );
      scheduleRender();
      await new Promise((r) => setTimeout(r, 2000));
      progressBox.destroy();
      modelPickerActive = false;
      scheduleRender();
      return;
    }
    results.push(result);
    log(
      `[${new Date().toISOString()}] Bench Q${i + 1}: ${result.timeSec}s, ${result.tokPerSec} tok/s (${result.completionTokens} tok)`,
    );
  }

  progressBox.destroy();
  scheduleRender();

  if (cancelled || results.length === 0) {
    log(`[${new Date().toISOString()}] Benchmark cancelled`);
    modelPickerActive = false;
    scheduleRender();
    return;
  }

  const avgTime = parseFloat(
    (results.reduce((s, r) => s + r.timeSec, 0) / results.length).toFixed(2),
  );
  const avgTokPerSec = parseFloat(
    (results.reduce((s, r) => s + r.tokPerSec, 0) / results.length).toFixed(1),
  );
  const totalTokens = results.reduce(
    (s, r) => s + r.promptTokens + r.completionTokens,
    0,
  );

  const run: BenchRun = {
    model,
    date: new Date().toISOString().slice(0, 19).replace('T', ' '),
    results,
    avgTime,
    avgTokPerSec,
    totalTokens,
  };
  benchScoreboard.unshift(run);
  log(
    `[${new Date().toISOString()}] Benchmark done: avg ${avgTime}s, ${avgTokPerSec} tok/s`,
  );
  showBenchResults(run);
}

function showBenchResults(run: BenchRun): void {
  const lines: string[] = [
    '',
    `  {bold}{yellow-fg}${run.model}{/yellow-fg}{/bold}  ${run.date}`,
    '',
  ];
  for (let i = 0; i < run.results.length; i++) {
    const r = run.results[i];
    const q =
      r.question.length > 45 ? r.question.slice(0, 42) + '…' : r.question;
    const safeQ = q.replace(/\{/g, '{{').replace(/\}/g, '}}');
    lines.push(`  {bold}Q${i + 1}{/bold} ${safeQ}`);
    lines.push(
      `     {cyan-fg}${r.timeSec}s{/cyan-fg}  │  {bold}${r.tokPerSec}{/bold} tok/s  │  ${r.completionTokens} tokens out`,
    );
  }
  lines.push('');
  lines.push(
    `  {bold}Average{/bold}   {cyan-fg}${run.avgTime}s{/cyan-fg}  │  {bold}${run.avgTokPerSec}{/bold} tok/s  │  ${run.totalTokens} total tokens`,
  );
  lines.push('');
  lines.push(
    '  {green-fg}↵ Scoreboard{/green-fg}  ·  {gray-fg}Esc Close{/gray-fg}',
  );
  lines.push('');

  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: Math.min(lines.length + 2, 22),
    border: { type: 'line' },
    label: ' {bold}Benchmark Results{/bold} ',
    tags: true,
    keys: true,
    scrollable: true,
    mouse: true,
    content: lines.join('\n'),
    style: { border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true } },
  });
  box.focus();
  scheduleRender();

  box.key(['enter', 'return'], () => {
    box.destroy();
    scheduleRender();
    showScoreboard();
  });

  box.key('escape', () => {
    box.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

function showScoreboard(): void {
  if (benchScoreboard.length === 0) {
    modelPickerActive = false;
    return;
  }

  const sorted = [...benchScoreboard].sort(
    (a, b) => b.avgTokPerSec - a.avgTokPerSec,
  );
  const lines: string[] = [
    '',
    '  {bold}#   Model                         Avg Time   Tok/s   Tokens   Date{/bold}',
    '',
  ];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const rank = String(i + 1).padStart(2);
    const m = r.model.length > 28 ? r.model.slice(0, 25) + '…' : r.model;
    const safeM = m.replace(/\{/g, '{{').replace(/\}/g, '}}').padEnd(28);
    const time = `${r.avgTime}s`.padStart(8);
    const tps = `${r.avgTokPerSec}`.padStart(7);
    const tok = String(r.totalTokens).padStart(8);
    const date = r.date.slice(5, 16);
    const color = i === 0 ? '{green-fg}' : '{cyan-fg}';
    const colorEnd = i === 0 ? '{/green-fg}' : '{/cyan-fg}';
    const medal = i === 0 ? ' 🏆' : '';
    lines.push(
      `  ${rank}  ${safeM}  ${color}${time}${colorEnd}  ${color}${tps}${colorEnd}  ${tok}   ${date}${medal}`,
    );
  }
  lines.push('');
  lines.push('  {gray-fg}Esc Close{/gray-fg}');
  lines.push('');

  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '75%',
    height: Math.min(lines.length + 2, 24),
    border: { type: 'line' },
    label: ` {bold}Scoreboard (${sorted.length} runs){/bold} `,
    tags: true,
    keys: true,
    scrollable: true,
    mouse: true,
    content: lines.join('\n'),
    style: { border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true } },
  });
  box.focus();
  scheduleRender();

  box.key('escape', () => {
    box.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}

// ─── API Endpoints ────────────────────────────────────────────────────────────
interface Endpoint {
  method: string;
  path: string;
  desc: string;
  curl: string;
}

function getEndpoints(): Endpoint[] {
  const ips = getLocalIPs();
  const host = ips.length > 0 ? ips[0] : 'localhost';
  const base = `http://${host}:${PORT}`;
  return [
    {
      method: 'GET',
      path: '/health',
      desc: 'Health check',
      curl: `curl ${base}/health`,
    },
    {
      method: 'GET',
      path: '/api/models',
      desc: 'List models',
      curl: `curl ${base}/api/models`,
    },
    {
      method: 'GET',
      path: '/api/tags',
      desc: 'List models (alias)',
      curl: `curl ${base}/api/tags`,
    },
    {
      method: 'POST',
      path: '/api/chat',
      desc: 'Chat completion (streaming)',
      curl: `curl -X POST ${base}/api/chat -H 'Content-Type: application/json' -d '{"model":"llama3","messages":[{"role":"user","content":"hello"}]}'`,
    },
    {
      method: 'POST',
      path: '/api/pull',
      desc: 'Pull / download a model',
      curl: `curl -X POST ${base}/api/pull -H 'Content-Type: application/json' -d '{"name":"llama3"}'`,
    },
    {
      method: 'DELETE',
      path: '/api/models/:name',
      desc: 'Delete a model',
      curl: `curl -X DELETE ${base}/api/models/llama3`,
    },
    {
      method: 'POST',
      path: '/api/ollama/start',
      desc: 'Start Ollama',
      curl: `curl -X POST ${base}/api/ollama/start`,
    },
    {
      method: 'POST',
      path: '/api/ollama/stop',
      desc: 'Stop Ollama',
      curl: `curl -X POST ${base}/api/ollama/stop`,
    },
    {
      method: 'POST',
      path: '/api/ollama/restart',
      desc: 'Restart Ollama',
      curl: `curl -X POST ${base}/api/ollama/restart`,
    },
  ];
}

export function showEndpoints(): void {
  if (modelPickerActive) return;
  modelPickerActive = true;

  const endpoints = getEndpoints();
  let selected = 0;

  function buildContent(): string {
    const lines: string[] = [
      '',
      '  {bold}API Endpoints{/bold}  {gray-fg}↑↓ navigate  ↵ copy curl  Esc close{/gray-fg}',
      '',
    ];
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      const methodColor =
        ep.method === 'GET'
          ? 'green'
          : ep.method === 'DELETE'
            ? 'red'
            : 'yellow';
      const prefix =
        i === selected ? '{bold}{white-fg}▸{/white-fg}{/bold}' : ' ';
      const bg = i === selected ? '{inverse}' : '';
      const bgEnd = i === selected ? '{/inverse}' : '';
      const num = String(i + 1).padStart(2);
      const safeCurl = ep.curl.replace(/\{/g, '{{').replace(/\}/g, '}}');
      lines.push(
        `  ${prefix} ${bg}{gray-fg}${num}{/gray-fg} {${methodColor}-fg}${ep.method.padEnd(6)}{/${methodColor}-fg} {bold}${ep.path}{/bold}${bgEnd}`,
      );
      lines.push(`       {gray-fg}${ep.desc}{/gray-fg}`);
      if (i === selected) {
        lines.push(`       {cyan-fg}$ ${safeCurl}{/cyan-fg}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '80%',
    height: '80%',
    border: { type: 'line' },
    label: ` {bold}API Documentation (${endpoints.length} endpoints){/bold} `,
    tags: true,
    keys: true,
    scrollable: true,
    mouse: true,
    content: buildContent(),
    style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
  });
  box.focus();
  scheduleRender();

  const refresh = () => {
    box.setContent(buildContent());
    scheduleRender();
  };

  box.key(['up', 'k'], () => {
    selected = (selected - 1 + endpoints.length) % endpoints.length;
    refresh();
  });

  box.key(['down', 'j'], () => {
    selected = (selected + 1) % endpoints.length;
    refresh();
  });

  box.key(['enter', 'return'], () => {
    const curl = endpoints[selected].curl;
    try {
      const { execSync } = require('child_process');
      execSync('pbcopy', { input: curl });
      box.setLabel(
        ` {bold}Copied!{/bold} {green-fg}${endpoints[selected].path}{/green-fg} `,
      );
      scheduleRender();
      setTimeout(() => {
        box.setLabel(
          ` {bold}API Documentation (${endpoints.length} endpoints){/bold} `,
        );
        scheduleRender();
      }, 1500);
    } catch {
      log(`[${new Date().toISOString()}] Failed to copy to clipboard`);
    }
  });

  // Number keys 1-9 to jump and copy
  for (let n = 1; n <= Math.min(9, endpoints.length); n++) {
    box.key(String(n), () => {
      selected = n - 1;
      const curl = endpoints[selected].curl;
      try {
        const { execSync } = require('child_process');
        execSync('pbcopy', { input: curl });
        box.setLabel(
          ` {bold}Copied!{/bold} {green-fg}${endpoints[selected].path}{/green-fg} `,
        );
        refresh();
        setTimeout(() => {
          box.setLabel(
            ` {bold}API Documentation (${endpoints.length} endpoints){/bold} `,
          );
          scheduleRender();
        }, 1500);
      } catch {
        log(`[${new Date().toISOString()}] Failed to copy to clipboard`);
      }
    });
  }

  box.key('escape', () => {
    box.destroy();
    modelPickerActive = false;
    scheduleRender();
  });
}
