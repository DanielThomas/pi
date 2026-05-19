/**
 * Session: the contract between a consumer and the agent.
 *
 * Implementations:
 * - AgentSessionRuntime: in-process, delegates to AgentSession.
 * - RpcAgentSession: RPC over a Readable/Writable stream pair.
 */

import type { AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Transport } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ModelCycleResult, PromptOptions, SessionStats } from "./agent-session.ts";
import type { BashResult } from "./bash-executor.ts";
import type { CompactionResult } from "./compaction/index.ts";
import type { ContextUsage, ReplacedSessionContext, ToolDefinition } from "./extensions/index.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { SessionInfo, SessionListProgress, SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SourceInfo } from "./source-info.ts";

// =============================================================================
// Session interface
// =============================================================================

/**
 * Unified interface for interacting with an agent session.
 *
 * Covers prompting, model/tool management, session lifecycle (new, switch, fork),
 * compaction, bash execution, and extension binding.
 */
export interface Session {
	// =========================================================================
	// Event subscription
	// =========================================================================

	/** Subscribe to agent session events. Returns unsubscribe function. */
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;

	// =========================================================================
	// Agent commands
	// =========================================================================

	/** Send a user prompt. */
	prompt(text: string, options?: PromptOptions): Promise<void>;

	/** Queue a steering message (delivered after current tool execution). */
	steer(text: string, images?: ImageContent[]): Promise<void>;

	/** Queue a follow-up message (delivered when agent finishes). */
	followUp(text: string, images?: ImageContent[]): Promise<void>;

	/** Abort the current agent operation. */
	abort(): Promise<void>;

	// =========================================================================
	// Model
	// =========================================================================

	/** Set the model. Throws if no API key is configured. */
	setModel(model: Model<any>): Promise<void>;

	/** Cycle to next/previous model. */
	cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>;

	/** Set thinking level. */
	setThinkingLevel(level: ThinkingLevel): void;

	/** Cycle thinking level. Returns new level or undefined if not supported. */
	cycleThinkingLevel(): ThinkingLevel | undefined;

	/** Get available thinking levels for current model. */
	getAvailableThinkingLevels(): ThinkingLevel[];

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Compact conversation context. */
	compact(customInstructions?: string): Promise<CompactionResult>;

	/** Abort in-progress compaction. */
	abortCompaction(): void;

	/** Set auto-compaction enabled/disabled. */
	setAutoCompactionEnabled(enabled: boolean): void;

	// =========================================================================
	// Retry
	// =========================================================================

	/** Set auto-retry enabled/disabled. */
	setAutoRetryEnabled(enabled: boolean): void;

	/** Abort in-progress retry. */
	abortRetry(): void;

	// =========================================================================
	// Bash
	// =========================================================================

	/** Execute a bash command. */
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: unknown },
	): Promise<BashResult>;

	/** Abort running bash command. */
	abortBash(): void;

	/** Record bash result into session context. */
	recordBashResult(command: string, result: BashResult, options: { excludeFromContext: boolean }): void;

	// =========================================================================
	// Queue
	// =========================================================================

	/** Set steering message delivery mode. */
	setSteeringMode(mode: "all" | "one-at-a-time"): void;

	/** Set follow-up message delivery mode. */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;

	/** Get pending steering messages. */
	getSteeringMessages(): readonly string[];

	/** Get pending follow-up messages. */
	getFollowUpMessages(): readonly string[];

	/** Clear all queued messages. Returns what was cleared. */
	clearQueue(): { steering: string[]; followUp: string[] };

	// =========================================================================
	// Session management
	// =========================================================================

	/** Start a new session. */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** Switch to a different session file. */
	switchSession(
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** Fork from a specific entry. */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }>;

	/** Import a session from a JSONL file. */
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;

	/** Navigate to a different point in the session tree. */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }>;

	/** Abort in-progress branch summarization. */
	abortBranchSummary(): void;

	/** Set a label on an entry. */
	setLabel(entryId: string, label: string | undefined): void;

	/** Set the session display name. */
	setSessionName(name: string): void;

	/** Reload extensions, skills, prompts, themes, and context files. */
	reload(): Promise<void>;

	// =========================================================================
	// Scoped models
	// =========================================================================

	/** Set the scoped models for cycling. */
	setScopedModels(models: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void;

	// =========================================================================
	// Tools
	// =========================================================================

	/** Get tool definition by name. */
	getToolDefinition(name: string): ToolDefinition | undefined;

	/** Get active tool names. */
	getActiveToolNames(): string[];

	/** Get all registered tools with metadata. */
	getAllTools(): ReadonlyArray<{
		name: string;
		description: string;
		parameters: unknown;
		sourceInfo: SourceInfo;
	}>;

	/** Set active tools by name. */
	setActiveToolsByName(toolNames: string[]): void;

	// =========================================================================
	// Data queries
	// =========================================================================

	/** Get session statistics. */
	getSessionStats(): SessionStats;

	/** Get text of last assistant message. */
	getLastAssistantText(): string | undefined;

	/** Get current context usage. */
	getContextUsage(): ContextUsage | undefined;

	/** Get user messages available for forking. */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }>;

	/** Export session to HTML. */
	exportToHtml(outputPath?: string): Promise<string>;

	/** Export session to JSONL. */
	exportToJsonl(outputPath?: string): string;

	/** List sessions for current project. */
	listSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]>;

	/** List all sessions across all projects. */
	listAllSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]>;

	// =========================================================================
	// Scalar state (readonly)
	// =========================================================================

	readonly model: Model<any> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly isBashRunning: boolean;
	readonly retryAttempt: number;
	readonly messages: AgentMessage[];
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly sessionName: string | undefined;
	readonly autoCompactionEnabled: boolean;
	readonly steeringMode: "all" | "one-at-a-time";
	readonly followUpMode: "all" | "one-at-a-time";
	readonly pendingMessageCount: number;
	readonly scopedModels: ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	readonly systemPrompt: string;
	readonly state: AgentState;

	// =========================================================================
	// Sub-object access
	// =========================================================================

	/** Session manager for tree, entries, labels, cwd, paths. */
	readonly sessionManager: Pick<
		SessionManager,
		| "getCwd"
		| "getSessionDir"
		| "getSessionId"
		| "getSessionFile"
		| "getSessionName"
		| "getLeafId"
		| "getLeafEntry"
		| "getEntry"
		| "getLabel"
		| "getBranch"
		| "getEntries"
		| "getTree"
		| "getHeader"
		| "buildSessionContext"
		| "appendLabelChange"
	>;

	/** Settings manager. */
	readonly settingsManager: SettingsManager;

	/** Model registry for model discovery and auth. */
	readonly modelRegistry: ModelRegistry;

	/** Transport preference (http, sse, auto). */
	transport: Transport;

	/** Abort signal for the current operation, undefined when idle. */
	readonly signal: AbortSignal | undefined;

	/** Wait for agent to become idle. */
	waitForIdle(): Promise<void>;

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/** Set callback invoked before session is invalidated during replacement. */
	setBeforeSessionInvalidate(callback: (() => void) | undefined): void;

	/** Set callback invoked after session replacement. */
	setRebindSession(callback: ((session: Session) => Promise<void>) | undefined): void;

	/** Dispose the session and release resources. */
	dispose(): Promise<void>;
}
