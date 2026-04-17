import { checkConnection, startOllama, stopOllama, restartOllama } from '../services/ollama';
import {
  log,
  setOllamaStatus,
  getScreen,
  toggleDebug,
  isDebugVisible,
  isDebugFocused,
  showModelPicker,
  isModelPickerActive,
  showConfigEditor,
  runBenchmark,
  showEndpoints,
  toggleLogWrap,
  toggleTruncation,
  toggleRawResponses,
  toggleWebSearch,
  toggleReasoning,
  showHelp,
  showHistoryViewer,
  resizePanes,
  showPresetPicker,
  showSessionPicker,
  newSession,
  showRunningModels,
} from './dashboard';

export function setupKeyboardShortcuts(shutdown: () => void): void {
  const screen = getScreen();
  if (!screen) return;

  // Guard: skip shortcuts when debug input or model picker is focused
  const guard = (): boolean => isDebugFocused() || isModelPickerActive();

  screen.key('s', async () => {
    if (guard()) return;
    const ts = () => new Date().toISOString();
    log(`[${ts()}] Starting Ollama…`);
    const already = await checkConnection();
    if (already) {
      log(`[${ts()}] Ollama is already running`);
      return;
    }
    const ok = await startOllama();
    log(
      ok ? `[${ts()}] ● Ollama started` : `[${ts()}] ⚠ Could not start Ollama — is it installed?`,
    );
    setOllamaStatus(ok);
  });

  screen.key('x', async () => {
    if (guard()) return;
    const ts = () => new Date().toISOString();
    log(`[${ts()}] Stopping Ollama…`);
    const stopped = await stopOllama();
    log(stopped ? `[${ts()}] Ollama stopped` : `[${ts()}] ● Ollama still responding`);
    setOllamaStatus(!stopped);
  });

  screen.key('r', async () => {
    if (guard()) return;
    const ts = () => new Date().toISOString();
    log(`[${ts()}] Restarting Ollama…`);
    const ok = await restartOllama();
    log(ok ? `[${ts()}] ● Ollama restarted` : `[${ts()}] ⚠ Ollama did not respond after restart`);
    setOllamaStatus(ok);
  });

  screen.key('c', () => {
    if (guard()) return;
    showConfigEditor();
  });

  screen.key('d', () => {
    if (guard()) return;
    if (!isDebugVisible()) {
      toggleDebug();
    }
  });

  screen.key('m', () => {
    if (guard()) return;
    showModelPicker();
  });

  screen.key('b', () => {
    if (guard()) return;
    runBenchmark();
  });

  screen.key('e', () => {
    if (guard()) return;
    showEndpoints();
  });

  screen.key('w', () => {
    if (guard()) return;
    toggleLogWrap();
  });

  screen.key('t', () => {
    if (guard()) return;
    toggleTruncation();
  });

  screen.key('S-r', () => {
    if (guard()) return;
    toggleRawResponses();
  });

  screen.key('h', () => {
    if (guard()) return;
    showHelp();
  });

  screen.key('i', () => {
    if (guard()) return;
    toggleWebSearch();
  });

  screen.key('n', () => {
    if (guard()) return;
    toggleReasoning();
  });

  screen.key('S-h', () => {
    if (guard()) return;
    showHistoryViewer();
  });

  screen.key('p', () => {
    if (guard()) return;
    showPresetPicker();
  });

  screen.key('S-s', () => {
    if (guard()) return;
    showSessionPicker();
  });

  screen.key('S-n', () => {
    if (guard()) return;
    newSession();
  });

  screen.key('l', () => {
    if (guard()) return;
    showRunningModels();
  });

  // Resizable panes: [ / ] shrink/grow left info pane; { / } shrink/grow middle logs pane
  screen.key('[', () => {
    if (!guard()) resizePanes('left', -1);
  });
  screen.key(']', () => {
    if (!guard()) resizePanes('left', 1);
  });
  screen.key('{', () => {
    if (!guard()) resizePanes('mid', -1);
  });
  screen.key('}', () => {
    if (!guard()) resizePanes('mid', 1);
  });
}
