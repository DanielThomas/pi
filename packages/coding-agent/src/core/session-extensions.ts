/**
 * Extension surface exposed by in-process sessions.
 *
 * Not part of Session — extensions are local infrastructure that runs
 * in the same process as the agent. Consumers that need extension
 * support (e.g. InteractiveMode) accept this as a separate dependency.
 */

import type { AutocompleteItem, KeybindingsConfig, KeyId } from "@earendil-works/pi-tui";
import type { AgentSession } from "./agent-session.ts";
import type { ExtensionCommandContext, ExtensionContext } from "./extensions/index.ts";
import type { ResourceDiagnostic, ResourceLoader } from "./resource-loader.ts";
import type { SourceInfo } from "./source-info.ts";

/** The subset of ExtensionRunner that consumers need. */
export interface SessionExtensionRunner {
	getRegisteredCommands(): ReadonlyArray<{
		name: string;
		invocationName: string;
		sourceInfo: SourceInfo;
		description?: string;
		getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	}>;

	getCommand(name: string):
		| {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		  }
		| undefined;

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<
		KeyId,
		{
			description?: string;
			extensionPath?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		}
	>;

	getMessageRenderer(customType: string): ((message: any, options: any, theme: any) => any) | undefined;

	getCommandDiagnostics(): ResourceDiagnostic[];
	getShortcutDiagnostics(): ResourceDiagnostic[];

	emitUserBash(event: { type: "user_bash"; command: string; excludeFromContext: boolean; cwd: string }): Promise<any>;

	hasHandlers(eventType: string): boolean;
}

/**
 * In-process extension capabilities.
 *
 * AgentSessionRuntime satisfies this structurally — pass it directly
 * to consumers that need extension support.
 */
export interface SessionExtensions {
	readonly extensionRunner: SessionExtensionRunner;
	readonly promptTemplates: ReadonlyArray<{
		name: string;
		description: string;
		argumentHint?: string;
		content: string;
		sourceInfo: SourceInfo;
		filePath: string;
	}>;
	bindExtensions(bindings: Parameters<AgentSession["bindExtensions"]>[0]): Promise<void>;
}

/** No-op ResourceLoader for sessions without local resources. */
export const EMPTY_RESOURCE_LOADER: ResourceLoader = Object.freeze({
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => undefined,
	getAppendSystemPrompt: () => [],
	reload: async () => {},
	extendResources: () => {},
}) as unknown as ResourceLoader;

/** No-op implementation for sessions without in-process extensions. */
export const EMPTY_SESSION_EXTENSIONS: SessionExtensions = {
	extensionRunner: {
		getRegisteredCommands: () => [],
		getCommand: () => undefined,
		getShortcuts: () => new Map(),
		getMessageRenderer: () => undefined,
		getCommandDiagnostics: () => [],
		getShortcutDiagnostics: () => [],
		emitUserBash: async () => undefined,
		hasHandlers: () => false,
	},

	promptTemplates: [],
	bindExtensions: async () => {},
};
