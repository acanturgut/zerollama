import * as os from 'os';
import { OLLAMA_URL, PORT } from '../config';
import { checkConnection } from '../services/ollama';

export async function printBanner(): Promise<boolean> {
  const localIPs = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface?.family === 'IPv4' && !iface.internal)
    .map((iface) => iface!.address);

  const ollamaOk = await checkConnection();

  const dim = '\x1b[2m';
  const bold = '\x1b[1m';
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const r = '\x1b[0m';

  const W = 46;
  const hr = '─'.repeat(W);
  const pad = (s: string, len: number) => s + ' '.repeat(Math.max(0, len - s.length));
  const row = (label: string, value: string) =>
    `│  ${dim}${pad(label, 10)}${r}${pad(value, W - 12)}│`;
  const status = ollamaOk ? `${green}● reachable${r}` : `${red}● unreachable${r}`;
  const statusVisLen = ollamaOk ? 11 : 13;

  const lines = [
    `╭${hr}╮`,
    `│${pad('', Math.floor((W - 24) / 2))}${bold}Zerollama Server${r}${pad('', Math.ceil((W - 24) / 2))}│`,
    `├${hr}┤`,
    row('Target', OLLAMA_URL),
    `│  ${dim}${pad('Status', 10)}${r}${status}${' '.repeat(Math.max(0, W - 12 - statusVisLen))}│`,
    row('Port', String(PORT)),
    `├${hr}┤`,
    `│  ${bold}Network addresses${r}${' '.repeat(W - 19)}│`,
    ...localIPs.map((ip) => {
      const addr = `http://${ip}:${PORT}`;
      return `│  ▸ ${pad(addr, W - 4)}│`;
    }),
    `├${hr}┤`,
    `│  ${bold}Keyboard shortcuts${r}${' '.repeat(W - 20)}│`,
    `│  ${dim}s${r}${pad(' ─ start Ollama', W - 2)}│`,
    `│  ${dim}x${r}${pad(' ─ stop Ollama', W - 2)}│`,
    `│  ${dim}r${r}${pad(' ─ restart Ollama', W - 2)}│`,
    `│  ${dim}q${r}${pad(' ─ quit server', W - 2)}│`,
    `╰${hr}╯`,
  ];

  console.log('\n' + lines.join('\n') + '\n');

  return ollamaOk;
}

export function startStatusMonitor(initialStatus: boolean): NodeJS.Timeout {
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const r = '\x1b[0m';

  let lastStatus = initialStatus;
  const interval = setInterval(async () => {
    const reachable = await checkConnection();
    if (reachable !== lastStatus) {
      const ts = new Date().toISOString();
      const msg = reachable
        ? `${green}● Ollama is now reachable${r}`
        : `${red}● Ollama is now unreachable${r}`;
      console.log(`[${ts}] ${msg}`);
      lastStatus = reachable;
    }
  }, 10_000);
  interval.unref();
  return interval;
}
