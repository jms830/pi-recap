import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logError } from "../util/log.js";

export interface GlobalConfig {
	modelOverride?: string;
	/** Defaults to true. False keeps the widget goal but stops renaming the host session. */
	autoRenameSession?: boolean;
	/** Defaults to false. True restricts automatic recap/goal fallback chains to free models. */
	freeOnlyAutoPick?: boolean;
}

function resolveConfigPath(): string {
	const envHome = process.env.PI_RECAP_HOME;
	if (envHome && envHome.length > 0) {
		return resolve(envHome, "state", "config.json");
	}
	const cwd = process.cwd();
	const cwdCandidate = resolve(cwd, "state", "config.json");
	if (existsSync(resolve(cwd, "package.json")) && cwd.endsWith("pi-recap")) {
		return cwdCandidate;
	}
	const xdg = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
		? process.env.XDG_STATE_HOME
		: resolve(process.env.HOME || "", ".local", "state");
	const xdgCandidate = resolve(xdg, "pi-recap", "state", "config.json");
	if (existsSync(xdgCandidate)) {
		return xdgCandidate;
	}
	const legacy = resolve(process.env.HOME || "", ".pi", "agent", "extensions", "pi-recap", "state", "config.json");
	if (existsSync(legacy)) {
		return legacy;
	}
	return xdgCandidate;
}

const CONFIG_PATH = resolveConfigPath();

let cache: GlobalConfig | undefined;

function ensureDir(): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	} catch {
		// best effort
	}
}

export function loadConfig(): GlobalConfig {
	if (cache) return cache;
	if (!existsSync(CONFIG_PATH)) {
		cache = {};
		return cache;
	}
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		cache = JSON.parse(raw) as GlobalConfig;
	} catch (err) {
		logError("config.json read failed; ignoring", err);
		cache = {};
	}
	return cache;
}

function writeConfig(config: GlobalConfig): void {
	ensureDir();
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
	} catch (err) {
		logError("config.json write failed", err);
	}
}

export function setGlobalModelOverride(id: string | undefined): void {
	const config = loadConfig();
	if (config.modelOverride === id) return;
	config.modelOverride = id;
	writeConfig(config);
}

export function getGlobalModelOverride(): string | undefined {
	return loadConfig().modelOverride;
}

export function getAutoRenameSession(): boolean {
	return loadConfig().autoRenameSession !== false;
}

export function setAutoRenameSession(enabled: boolean): void {
	const config = loadConfig();
	if (getAutoRenameSession() === enabled) return;
	config.autoRenameSession = enabled ? undefined : false;
	writeConfig(config);
}

export function getFreeOnlyAutoPick(): boolean {
	return loadConfig().freeOnlyAutoPick === true;
}

export function setFreeOnlyAutoPick(enabled: boolean): void {
	const config = loadConfig();
	if (getFreeOnlyAutoPick() === enabled) return;
	config.freeOnlyAutoPick = enabled ? true : undefined;
	writeConfig(config);
}
