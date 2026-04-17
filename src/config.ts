import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
export const PORT = parseInt(process.env.PORT ?? '3001', 10);

interface RuntimeSettings {
	webSearchEnabled?: boolean;
	ollamaConfig?: { [key: string]: string };
}

const SETTINGS_DIR = path.join(os.homedir(), '.zerollama');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

export function readRuntimeSettings(): RuntimeSettings {
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as RuntimeSettings;
	} catch {
		return {};
	}
}

export function writeRuntimeSettings(
	patch: Partial<RuntimeSettings>,
): RuntimeSettings {
	const current = readRuntimeSettings();
	const next: RuntimeSettings = {
		...current,
		...patch,
		ollamaConfig:
			patch.ollamaConfig !== undefined
				? patch.ollamaConfig
				: current.ollamaConfig,
	};
	fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8');
	return next;
}

const persistedSettings = readRuntimeSettings();
let webSearchEnabled =
	persistedSettings.webSearchEnabled ?? process.env.WEB_SEARCH_ENABLED !== '0';
export const WEB_SEARCH_MAX_RESULTS = parseInt(
	process.env.WEB_SEARCH_MAX_RESULTS ?? '5',
	10,
);

export function isWebSearchEnabled(): boolean {
	return webSearchEnabled;
}

export function setWebSearchEnabled(enabled: boolean): boolean {
	webSearchEnabled = enabled;
	writeRuntimeSettings({ webSearchEnabled });
	return webSearchEnabled;
}

export function toggleWebSearchEnabled(): boolean {
	webSearchEnabled = !webSearchEnabled;
	writeRuntimeSettings({ webSearchEnabled });
	return webSearchEnabled;
}

