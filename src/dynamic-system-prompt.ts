import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { renderSystemPromptTemplate, type Config } from "./state.ts";

export function createDynamicSystemPromptExtension(config: Config): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", async (event) => ({
			systemPrompt: await renderSystemPromptTemplate(config, event.systemPrompt),
		}));
	};
}
