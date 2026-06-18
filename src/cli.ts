#!/usr/bin/env node

import { Command } from "commander";
import type { CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";

import { createDynamicSystemPromptExtension } from "./dynamic-system-prompt.ts";
import { getConfig, getConfiguredResources, getSkillsDir, renderSystemPromptTemplate, scaffold, type Config } from "./state.ts";

const VERSION = "0.1.2";

interface ParsedArgs {
}

function parseArgs(argv: string[]): ParsedArgs {
	const program = new Command();
	program
		.name("pino")
		.description("Minimal Pi-based agent harness")
		.version(VERSION, "-v, --version")
		.helpOption("-h, --help")
		.addHelpText(
			"after",
			`
Environment:
  PINO_STATE_DIR          Pino state/config directory (default: ~/.pino)
  PINO_WORKSPACE          Directory where the agent works (default: current directory)

Pino starts the Pi coding-agent interactive interface with Pino's state directory and bundled extension set.`,
		)
		.action(() => undefined);

	program.allowExcessArguments(false);
	program.allowUnknownOption(false);
	program.parse(argv, { from: "user" });
	return {};
}

async function createPinoRuntime(config: Config) {
	process.env.PI_CODING_AGENT_DIR = config.stateDir;
	process.env.PI_SKIP_VERSION_CHECK = "1";

	await scaffold(config);
	const pinoResources = await getConfiguredResources(config);

	const {
		createAgentSessionFromServices,
		createAgentSessionRuntime,
		createAgentSessionServices,
		SessionManager,
	} = await import("@earendil-works/pi-coding-agent");

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const pinoSkillsDir = getSkillsDir(config);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				noSkills: true,
				additionalSkillPaths: [pinoSkillsDir],
				noPromptTemplates: true,
				extensionFactories: [createDynamicSystemPromptExtension(config)],
				agentsFilesOverride: () => ({ agentsFiles: pinoResources.agentsFiles }),
				systemPromptOverride: () => pinoResources.systemPromptTemplate,
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};

	return createAgentSessionRuntime(createRuntime, {
		cwd: config.workspace,
		agentDir: config.stateDir,
		sessionManager: SessionManager.continueRecent(config.workspace),
	});
}

async function dumpRuntime(config: Config): Promise<void> {
	const runtime = await createPinoRuntime(config);
	const resourceLoader = runtime.services.resourceLoader;
	const extensions = resourceLoader.getExtensions();
	const skills = resourceLoader.getSkills();
	const agentsFiles = resourceLoader.getAgentsFiles();

	console.log(JSON.stringify({
		stateDir: config.stateDir,
		workspace: config.workspace,
		env: {
			PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
		},
		systemPrompt: await renderSystemPromptTemplate(config, resourceLoader.getSystemPrompt() ?? ""),
		systemPromptTemplate: resourceLoader.getSystemPrompt(),
		extensions: extensions.extensions.map((extension) => ({ path: extension.path, sourceInfo: extension.sourceInfo })),
		commands: extensions.extensions.flatMap((extension) =>
			Array.from(extension.commands.entries()).map(([name, command]) => ({ name, description: command.description, extensionPath: extension.path })),
		),
		extensionErrors: extensions.errors,
		skills: skills.skills.map((skill) => ({ name: skill.name, filePath: skill.filePath, sourceInfo: skill.sourceInfo })),
		diagnostics: skills.diagnostics,
		agentsFiles: agentsFiles.agentsFiles.map((file) => ({ path: file.path, content: file.content })),
	}, null, "\t"));
}

async function runInteractive(config: Config, _args: ParsedArgs): Promise<void> {
	const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
	const runtime = await createPinoRuntime(config);
	const mode = new InteractiveMode(runtime, {
		initialImages: [],
		initialMessages: [],
	});

	await mode.run();
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const config = getConfig();
	if (process.env.PINO_INTERNAL_DUMP_RUNTIME === "1") {
		await dumpRuntime(config);
		return;
	}

	await runInteractive(config, args);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
});
