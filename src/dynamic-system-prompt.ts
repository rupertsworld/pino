import type { ExtensionFactory, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

import { getConfiguredResources, renderSystemPromptTemplate, type Config } from "./state.ts";

export function createDynamicSystemPromptExtension(config: Config): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", async (event) => ({
			systemPrompt: await refreshSystemPrompt(config, event),
		}));
	};
}

async function refreshSystemPrompt(config: Config, event: Pick<BeforeAgentStartEvent, "systemPrompt" | "systemPromptOptions">): Promise<string> {
	const resources = await getConfiguredResources(config);
	const previousCustomPrompt = event.systemPromptOptions?.customPrompt;
	const customPromptTemplate = resources.systemPromptTemplate || previousCustomPrompt || "";
	const customPrompt = await renderSystemPromptTemplate(config, customPromptTemplate);
	let prompt = event.systemPrompt;

	if (previousCustomPrompt) {
		const renderedPreviousCustomPrompt = await renderSystemPromptTemplate(config, previousCustomPrompt);
		if (prompt.startsWith(renderedPreviousCustomPrompt)) {
			prompt = `${customPrompt}${prompt.slice(renderedPreviousCustomPrompt.length)}`;
		} else if (prompt.startsWith(previousCustomPrompt)) {
			prompt = `${customPrompt}${prompt.slice(previousCustomPrompt.length)}`;
		}
	} else {
		prompt = await renderSystemPromptTemplate(config, prompt);
	}

	return replaceProjectContext(prompt, formatProjectContext(resources.agentsFiles));
}

function formatProjectContext(agentsFiles: Array<{ path: string; content: string }>): string {
	if (agentsFiles.length === 0) return "";

	let section = "<project_context>\n\n";
	section += "Project-specific instructions and guidelines:\n\n";
	for (const { path, content } of agentsFiles) {
		section += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
	}
	section += "</project_context>\n";
	return section;
}

function replaceProjectContext(prompt: string, projectContext: string): string {
	const projectContextPattern = /\n*<project_context>\n[\s\S]*?<\/project_context>\n?/;
	if (projectContextPattern.test(prompt)) {
		return prompt.replace(projectContextPattern, projectContext ? `\n\n${projectContext}` : "");
	}
	if (!projectContext) return prompt;

	const skillsIndex = prompt.indexOf("\n<available_skills>");
	if (skillsIndex !== -1) {
		return `${prompt.slice(0, skillsIndex)}\n\n${projectContext}${prompt.slice(skillsIndex)}`;
	}

	const currentDateIndex = prompt.indexOf("\nCurrent date:");
	if (currentDateIndex !== -1) {
		return `${prompt.slice(0, currentDateIndex)}\n\n${projectContext}${prompt.slice(currentDateIndex)}`;
	}

	return `${prompt}\n\n${projectContext}`;
}
