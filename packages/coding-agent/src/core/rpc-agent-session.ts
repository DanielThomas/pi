/**
 * RpcAgentSession: implements Session over a Readable/Writable pair
 * speaking the existing RPC JSONL protocol.
 *
 * Works with domain sockets, child process stdio, piped streams, etc.
 * Maintains local state from the event stream and forwards commands as RPC.
 */

import type { Readable, Writable } from "node:stream";
import type { AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Transport } from "@earendil-works/pi-ai";
import { attachJsonlLineReader, serializeJsonLine } from "../modes/rpc/jsonl.ts";
import type { RpcResponse, RpcSessionState } from "../modes/rpc/rpc-types.ts";
import type { AgentSessionEvent, ModelCycleResult, PromptOptions, SessionStats } from "./agent-session.ts";
import type { BashResult } from "./bash-executor.ts";
import type { CompactionResult } from "./compaction/index.ts";
import type { ContextUsage, ToolDefinition } from "./extensions/index.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { Session } from "./session.ts";
import type { SessionInfo } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SourceInfo } from "./source-info.ts";

// ============================================================================
// Types
// ============================================================================

export interface RpcAgentSessionOptions {
	/** Readable stream carrying JSONL events/responses from the remote agent. */
	input: Readable;
	/** Writable stream for sending JSONL commands to the remote agent. */
	output: Writable;
	/** Settings manager (local — not proxied to the remote). */
	settingsManager: SettingsManager;
}

type PendingRequest = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class RpcAgentSession implements Session {
	private readonly input: Readable;
	private readonly output: Writable;
	private readonly _settingsManager: SettingsManager;
	private detachInput: (() => void) | undefined;

	// Request/response correlation
	private pendingRequests = new Map<string, PendingRequest>();
	private requestId = 0;

	// Event listeners
	private eventListeners: Array<(event: AgentSessionEvent) => void> = [];

	// State mirror, kept in sync via events and syncState()
	private _state: RpcSessionState = {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionId: "",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	};
	private _messages: AgentMessage[] = [];
	private _steeringMessages: string[] = [];
	private _followUpMessages: string[] = [];
	private _isBashRunning = false;
	private _retryAttempt = 0;
	private _modelRegistry: ModelRegistry | undefined;
	private _sessionManager: Session["sessionManager"] | undefined;
	private _cachedModels: Model<any>[] = [];

	// Lifecycle callbacks
	private _beforeInvalidateCallback: (() => void) | undefined = undefined;
	private _rebindCallback: ((backend: Session) => Promise<void>) | undefined = undefined;

	private _disconnected = false;
	private _onDisconnect?: () => void;

	constructor(options: RpcAgentSessionOptions) {
		this.input = options.input;
		this.output = options.output;
		this._settingsManager = options.settingsManager;

		this.detachInput = attachJsonlLineReader(this.input, (line) => {
			this.handleLine(line);
		});

		const handleDisconnect = () => {
			if (this._disconnected) return;
			this._disconnected = true;

			// Reject all pending requests
			for (const [id, pending] of this.pendingRequests) {
				clearTimeout(pending.timer);
				pending.reject(new Error("Remote agent disconnected"));
				this.pendingRequests.delete(id);
			}

			this._onDisconnect?.();
		};

		this.input.on("end", handleDisconnect);
		this.input.on("error", handleDisconnect);
		this.input.on("close", handleDisconnect);
	}

	/** Register a disconnect callback. */
	onDisconnect(callback: () => void): void {
		this._onDisconnect = callback;
	}

	get disconnected(): boolean {
		return this._disconnected;
	}

	// =========================================================================
	// JSONL transport
	// =========================================================================

	private handleLine(line: string): void {
		let data: any;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}

		if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			pending.resolve(data as RpcResponse);
			return;
		}

		const event = data as AgentSessionEvent;
		this.updateStateFromEvent(event);
		for (const listener of this.eventListeners) {
			listener(event);
		}
	}

	private static readonly LONG_TIMEOUT_COMMANDS = new Set(["prompt", "compact", "bash", "export_html"]);

	private send(command: Record<string, unknown>): Promise<RpcResponse> {
		if (this._disconnected) {
			return Promise.reject(new Error("Remote agent disconnected"));
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id };
		const timeoutMs = RpcAgentSession.LONG_TIMEOUT_COMMANDS.has(String(command.type)) ? 600_000 : 30_000;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${String(command.type)}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				timer,
			});

			this.output.write(serializeJsonLine(fullCommand));
		});
	}

	private async sendVoid(command: Record<string, unknown>): Promise<void> {
		const response = await this.send(command);
		if (!response.success) {
			const err = response as Extract<RpcResponse, { success: false }>;
			throw new Error(err.error);
		}
	}

	private async sendData<T>(command: Record<string, unknown>): Promise<T> {
		const response = await this.send(command);
		if (!response.success) {
			const err = response as Extract<RpcResponse, { success: false }>;
			throw new Error(err.error);
		}
		return (response as any).data as T;
	}

	// =========================================================================
	// State tracking from events
	// =========================================================================

	private updateStateFromEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this._state.isStreaming = true;
				this._retryAttempt = 0;
				break;
			case "agent_end":
				this._state.isStreaming = false;
				this._messages = [...this._messages, ...event.messages];
				this._state.messageCount = this._messages.length;
				break;
			case "message_start":
				break;
			case "message_end":
				break;
			case "queue_update":
				this._steeringMessages = [...event.steering];
				this._followUpMessages = [...event.followUp];
				this._state.pendingMessageCount = this._steeringMessages.length + this._followUpMessages.length;
				break;
			case "compaction_start":
				this._state.isCompacting = true;
				break;
			case "compaction_end":
				this._state.isCompacting = false;
				break;
			case "session_info_changed":
				this._state.sessionName = event.name;
				break;
			case "thinking_level_changed":
				this._state.thinkingLevel = event.level;
				break;
			case "auto_retry_start":
				this._retryAttempt = event.attempt;
				break;
			case "auto_retry_end":
				if (event.success) this._retryAttempt = 0;
				break;
		}
	}

	/** Fetch full state from the remote. Call once after connecting. */
	async syncState(): Promise<void> {
		this._state = await this.sendData<RpcSessionState>({ type: "get_state" });
		const { messages } = await this.sendData<{ messages: AgentMessage[] }>({ type: "get_messages" });
		this._messages = messages;
		try {
			const { models } = await this.sendData<{ models: Model<any>[] }>({ type: "get_available_models" });
			this._cachedModels = models;
		} catch {
			// Server may not support get_available_models
		}
	}

	// =========================================================================
	// Session: Event subscription
	// =========================================================================

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx !== -1) this.eventListeners.splice(idx, 1);
		};
	}

	// =========================================================================
	// Session: Agent commands
	// =========================================================================

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await this.sendVoid({
			type: "prompt",
			message: text,
			images: options?.images,
			streamingBehavior: options?.streamingBehavior,
		});
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		await this.sendVoid({ type: "steer", message: text, images });
	}

	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		await this.sendVoid({ type: "follow_up", message: text, images });
	}

	async abort(): Promise<void> {
		await this.sendVoid({ type: "abort" });
	}

	// =========================================================================
	// Session: Model
	// =========================================================================

	async setModel(model: Model<any>): Promise<void> {
		await this.sendVoid({ type: "set_model", provider: model.provider, modelId: model.id });
		this._state.model = model;
	}

	async cycleModel(_direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		// RPC protocol does not support direction yet — always cycles forward
		const data = await this.sendData<{ model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null>({
			type: "cycle_model",
		});
		if (!data) return undefined;
		this._state.model = data.model;
		this._state.thinkingLevel = data.thinkingLevel;
		return data;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		void this.sendVoid({ type: "set_thinking_level", level });
		this._state.thinkingLevel = level;
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		// Synchronous return — fire RPC and update optimistically from the response event
		void this.sendData<{ level: ThinkingLevel } | null>({ type: "cycle_thinking_level" }).then((data) => {
			if (data) this._state.thinkingLevel = data.level;
		});
		return this._state.thinkingLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		// Not available from RPC state yet — return standard set
		return ["off", "low", "medium", "high"];
	}

	// =========================================================================
	// Session: Compaction
	// =========================================================================

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this.sendData<CompactionResult>({ type: "compact", customInstructions });
	}

	abortCompaction(): void {
		void this.sendVoid({ type: "abort" });
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		void this.sendVoid({ type: "set_auto_compaction", enabled });
		this._state.autoCompactionEnabled = enabled;
	}

	// =========================================================================
	// Session: Retry
	// =========================================================================

	setAutoRetryEnabled(enabled: boolean): void {
		void this.sendVoid({ type: "set_auto_retry", enabled });
	}

	abortRetry(): void {
		void this.sendVoid({ type: "abort_retry" });
	}

	// =========================================================================
	// Session: Bash
	// =========================================================================

	async executeBash(command: string, onChunk?: (chunk: string) => void): Promise<BashResult> {
		this._isBashRunning = true;
		try {
			const result = await this.sendData<BashResult>({ type: "bash", command });
			if (onChunk && result.output) {
				onChunk(result.output);
			}
			return result;
		} finally {
			this._isBashRunning = false;
		}
	}

	abortBash(): void {
		void this.sendVoid({ type: "abort_bash" });
	}

	recordBashResult(): void {
		// No-op: bash commands sent via executeBash are recorded in the remote
		// session automatically. This method exists for local mode where bash
		// execution and recording are separate steps.
	}

	// =========================================================================
	// Session: Queue
	// =========================================================================

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		void this.sendVoid({ type: "set_steering_mode", mode });
		this._state.steeringMode = mode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		void this.sendVoid({ type: "set_follow_up_mode", mode });
		this._state.followUpMode = mode;
	}

	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const result = { steering: [...this._steeringMessages], followUp: [...this._followUpMessages] };
		this._steeringMessages = [];
		this._followUpMessages = [];
		// No dedicated clear_queue RPC command — abort clears server-side queues
		void this.sendVoid({ type: "abort" });
		return result;
	}

	// =========================================================================
	// Session: Session management
	// =========================================================================

	async newSession(options?: { parentSession?: string }): Promise<{ cancelled: boolean }> {
		const result = await this.sendData<{ cancelled: boolean }>({
			type: "new_session",
			parentSession: options?.parentSession,
		});
		if (!result.cancelled) {
			await this.syncState();
			await this._rebindCallback?.(this);
		}
		return result;
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const result = await this.sendData<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
		if (!result.cancelled) {
			await this.syncState();
			await this._rebindCallback?.(this);
		}
		return result;
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at" },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		if (options?.position === "at") {
			const result = await this.sendData<{ cancelled: boolean }>({ type: "clone" });
			if (!result.cancelled) await this.syncState();
			return result;
		}
		const result = await this.sendData<{ text: string; cancelled: boolean }>({ type: "fork", entryId });
		if (!result.cancelled) await this.syncState();
		return { cancelled: result.cancelled, selectedText: result.text };
	}

	async importFromJsonl(): Promise<{ cancelled: boolean }> {
		throw new Error("importFromJsonl is not supported in remote mode");
	}

	async navigateTree(): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }> {
		throw new Error("navigateTree is not yet supported in remote mode");
	}

	abortBranchSummary(): void {}

	setLabel(): void {}

	setSessionName(name: string): void {
		void this.sendVoid({ type: "set_session_name", name });
		this._state.sessionName = name;
	}

	async reload(): Promise<void> {
		await this.prompt("/reload");
	}

	// =========================================================================
	// Session: Scoped models
	// =========================================================================

	setScopedModels(): void {}

	// =========================================================================
	// Session: Tools
	// =========================================================================

	getToolDefinition(): ToolDefinition | undefined {
		return undefined;
	}

	getActiveToolNames(): string[] {
		return [];
	}

	getAllTools(): ReadonlyArray<{ name: string; description: string; parameters: unknown; sourceInfo: SourceInfo }> {
		return [];
	}

	setActiveToolsByName(): void {}

	// =========================================================================
	// Session: Data queries
	// =========================================================================

	getSessionStats(): SessionStats {
		return {
			sessionFile: this._state.sessionFile,
			sessionId: this._state.sessionId,
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: this._state.messageCount,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		};
	}

	getLastAssistantText(): string | undefined {
		for (let i = this._messages.length - 1; i >= 0; i--) {
			const msg = this._messages[i];
			if (msg && msg.role === "assistant") {
				for (const block of (msg as any).content ?? []) {
					if (block.type === "text") return block.text;
				}
			}
		}
		return undefined;
	}

	getContextUsage(): ContextUsage | undefined {
		return undefined;
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		return [];
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		const { path } = await this.sendData<{ path: string }>({ type: "export_html", outputPath });
		return path;
	}

	exportToJsonl(): string {
		throw new Error("exportToJsonl is not supported in remote mode");
	}

	async listSessions(): Promise<SessionInfo[]> {
		return [];
	}

	async listAllSessions(): Promise<SessionInfo[]> {
		return [];
	}

	// =========================================================================
	// Session: Scalar state
	// =========================================================================

	get model(): Model<any> | undefined {
		return this._state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this._state.thinkingLevel;
	}

	get isStreaming(): boolean {
		return this._state.isStreaming;
	}

	get isCompacting(): boolean {
		return this._state.isCompacting;
	}

	get isBashRunning(): boolean {
		return this._isBashRunning;
	}

	get retryAttempt(): number {
		return this._retryAttempt;
	}

	get messages(): AgentMessage[] {
		return this._messages;
	}

	get sessionFile(): string | undefined {
		return this._state.sessionFile;
	}

	get sessionId(): string {
		return this._state.sessionId;
	}

	get sessionName(): string | undefined {
		return this._state.sessionName;
	}

	get autoCompactionEnabled(): boolean {
		return this._state.autoCompactionEnabled;
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this._state.steeringMode;
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this._state.followUpMode;
	}

	get pendingMessageCount(): number {
		return this._state.pendingMessageCount;
	}

	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return [];
	}

	get systemPrompt(): string {
		return "";
	}

	get state(): AgentState {
		return {
			systemPrompt: "",
			model: this._state.model ?? {
				id: "unknown",
				name: "unknown",
				api: "unknown",
				provider: "unknown",
				baseUrl: "",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
			thinkingLevel: this._state.thinkingLevel,
			tools: [],
			messages: this._messages,
			isStreaming: this._state.isStreaming,
			streamingMessage: undefined,
			pendingToolCalls: new Set(),
			errorMessage: undefined,
		};
	}

	// =========================================================================
	// Session: Sub-objects (stubs — degrade gracefully in remote mode)
	// =========================================================================

	get sessionManager(): Session["sessionManager"] {
		if (!this._sessionManager) {
			this._sessionManager = {
				getCwd: () => "",
				getSessionDir: () => "",
				getSessionId: () => this._state.sessionId,
				getSessionFile: () => this._state.sessionFile,
				getSessionName: () => this._state.sessionName,
				getLeafId: () => null,
				getLeafEntry: () => undefined,
				getEntry: () => undefined,
				getLabel: () => undefined,
				getBranch: () =>
					this._messages.map((m, i) => ({
						id: String(i),
						parentId: i > 0 ? String(i - 1) : null,
						type: "message" as const,
						message: m,
						timestamp: Date.now(),
					})) as any,
				getEntries: () => [],
				getTree: () => [],
				getHeader: () => null,
				buildSessionContext: () => ({
					messages: this._messages,
					thinkingLevel: this._state.thinkingLevel,
					model: null,
				}),
				appendLabelChange: () => "",
			};
		}
		return this._sessionManager;
	}

	get settingsManager(): SettingsManager {
		return this._settingsManager;
	}

	get modelRegistry(): ModelRegistry {
		if (!this._modelRegistry) {
			this._modelRegistry = {
				getAvailable: () => this._cachedModels,
				getAll: () => this._cachedModels,
				find: (provider: string, id: string) =>
					this._cachedModels.find((m) => m.provider === provider && m.id === id),
				refresh: () => {
					void this.sendData<{ models: Model<any>[] }>({ type: "get_available_models" })
						.then(({ models }) => {
							this._cachedModels = models;
						})
						.catch(() => {});
				},
				getError: () => undefined,
				getApiKeyForProvider: async () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: false, error: "Remote mode" }),
				isUsingOAuth: () => false,
				getProviderDisplayName: (id: string) => id,
				getProviderAuthStatus: () => "none",
				authStorage: {
					get: () => undefined,
					set: () => {},
					login: async () => {},
					logout: () => {},
					getOAuthProviders: () => [],
				},
			} as any;
		}
		return this._modelRegistry!;
	}

	get transport(): Transport {
		return "auto";
	}

	set transport(_value: Transport) {}

	get signal(): AbortSignal | undefined {
		return undefined;
	}

	async waitForIdle(): Promise<void> {
		if (!this._state.isStreaming) return;
		return new Promise((resolve) => {
			const unsub = this.subscribe((event) => {
				if (event.type === "agent_end") {
					unsub();
					resolve();
				}
			});
			// Guard against stale isStreaming — if state changed between
			// the check above and the subscribe, resolve immediately
			if (!this._state.isStreaming) {
				unsub();
				resolve();
			}
		});
	}

	// =========================================================================
	// Session: Lifecycle
	// =========================================================================

	setBeforeSessionInvalidate(callback: (() => void) | undefined): void {
		this._beforeInvalidateCallback = callback;
	}

	setRebindSession(callback: ((backend: Session) => Promise<void>) | undefined): void {
		this._rebindCallback = callback;
	}

	async dispose(): Promise<void> {
		this._beforeInvalidateCallback?.();
		this._beforeInvalidateCallback = undefined;
		this._rebindCallback = undefined;
		this.detachInput?.();
		this.detachInput = undefined;
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Backend disposed"));
		}
		this.pendingRequests.clear();
		this.eventListeners = [];
	}
}
