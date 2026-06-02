import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
	workspace: string;
	stateDir: string;
	packageRoot: string;
}

interface Settings {
	path: string;
	dir: string;
	systemPrompt?: string;
	contextFiles?: string[];
	timeZone?: string;
}

export function getConfig(): Config {
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	return {
		workspace: resolve(process.env.PINO_WORKSPACE ?? process.cwd()),
		stateDir: resolve(process.env.PINO_STATE_DIR ?? join(homedir(), ".pino")),
		packageRoot,
	};
}

export function getSkillsDir(config: Config): string {
	return join(config.stateDir, "skills");
}

export async function scaffold(config: Config): Promise<void> {
	await mkdir(config.stateDir, { recursive: true });
	await copyMissingEntries(join(config.packageRoot, "default-state"), config.stateDir);
}

export async function getSystemPrompt(config: Config): Promise<string> {
	const resources = await getConfiguredResources(config);
	return renderSystemPromptTemplate(config, resources.systemPromptTemplate);
}

export async function getAgentsFiles(config: Config): Promise<Array<{ path: string; content: string }>> {
	const resources = await getConfiguredResources(config);
	return resources.agentsFiles;
}

export async function getConfiguredResources(config: Config): Promise<{ systemPromptTemplate: string; agentsFiles: Array<{ path: string; content: string }> }> {
	const settings = await getSettings(config);
	return {
		systemPromptTemplate: await readSystemPromptTemplate(settings),
		agentsFiles: await readContextFiles(settings),
	};
}

export async function renderSystemPromptTemplate(config: Config, template: string): Promise<string> {
	const settings = await getSettings(config);
	return renderTemplate(template, getSystemPromptVariables(config, settings));
}

async function readSystemPromptTemplate(settings: Settings): Promise<string> {
	if (!settings.systemPrompt) return "";

	const templatePath = resolveSettingsPath(settings.systemPrompt, settings.dir);
	return readSystemPromptFile(templatePath);
}

async function readContextFiles(settings: Settings): Promise<Array<{ path: string; content: string }>> {
	const contextFiles = settings.contextFiles ?? [];
	const agentsFiles: Array<{ path: string; content: string }> = [];

	for (const contextFile of contextFiles) {
		const filePath = resolveSettingsPath(contextFile, settings.dir);
		const content = await readOptionalFile(filePath, "context file");
		if (content === undefined) continue;
		agentsFiles.push({ path: filePath, content });
	}

	return agentsFiles;
}

async function getSettings(config: Config): Promise<Settings> {
	const settingsPath = join(config.stateDir, "settings.json");
	const raw = await readFile(settingsPath, "utf8");
	const settings = JSON.parse(raw) as Record<string, unknown>;
	const result: Settings = { path: settingsPath, dir: dirname(settingsPath) };

	if (settings.systemPrompt !== undefined) {
		if (typeof settings.systemPrompt !== "string") throw new Error("settings.systemPrompt must be a string");
		result.systemPrompt = settings.systemPrompt;
	}

	if (settings.contextFiles !== undefined) {
		if (!Array.isArray(settings.contextFiles) || settings.contextFiles.some((entry) => typeof entry !== "string")) {
			throw new Error("settings.contextFiles must be an array of strings");
		}
		result.contextFiles = settings.contextFiles as string[];
	}

	if (settings.timeZone !== undefined) {
		if (typeof settings.timeZone !== "string") throw new Error("settings.timeZone must be a string");
		validateTimeZone(settings.timeZone);
		result.timeZone = settings.timeZone;
	}

	return result;
}

function resolveSettingsPath(path: string, baseDir: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	if (isAbsolute(path)) return path;
	return resolve(baseDir, path);
}

async function copyMissingEntries(sourceDir: string, targetDir: string): Promise<void> {
	const entries = await readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		if (await exists(targetPath)) continue;
		await cp(sourcePath, targetPath, { recursive: entry.isDirectory() });
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function readSystemPromptFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			console.warn(`Warning: systemPrompt file not found: ${path}. Using an empty system prompt.`);
			return "";
		}
		throw error;
	}
}

async function readOptionalFile(path: string, label: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			console.warn(`Warning: ${label} file not found: ${path}. Skipping it.`);
			return undefined;
		}
		throw error;
	}
}

function getSystemPromptVariables(config: Config, settings: Settings, now = new Date()): Record<string, string> {
	const timeZone = settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const dateTime = formatDateTime(now, timeZone);
	return {
		STATE_DIR: config.stateDir,
		WORKSPACE_DIR: config.workspace,
		DATE: dateTime.date,
		TIME: dateTime.time,
		TZ: timeZone || formatTimezoneOffset(now),
	};
}

function formatDateTime(date: Date, timeZone: string | undefined): { date: string; time: string } {
	if (!timeZone) return { date: formatLocalDate(date), time: formatLocalTime(date) };
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
	return {
		date: `${value("year")}-${value("month")}-${value("day")}`,
		time: `${value("hour")}:${value("minute")}:${value("second")}`,
	};
}

function formatLocalDate(date: Date): string {
	return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("-");
}

function formatLocalTime(date: Date): string {
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad2).join(":");
}

function formatTimezoneOffset(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteMinutes = Math.abs(offsetMinutes);
	return `UTC${sign}${pad2(Math.floor(absoluteMinutes / 60))}:${pad2(absoluteMinutes % 60)}`;
}

function validateTimeZone(timeZone: string): void {
	try {
		Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date());
	} catch {
		throw new Error(`settings.timeZone must be a valid IANA time zone: ${timeZone}`);
	}
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function renderTemplate(template: string, variables: Record<string, string>): string {
	return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => {
		const value = variables[name];
		if (value === undefined) throw new Error(`Unknown SYSTEM.md template variable: ${match}`);
		return value;
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
