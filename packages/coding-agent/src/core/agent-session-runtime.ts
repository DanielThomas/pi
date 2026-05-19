import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Transport } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	ModelCycleResult,
	PromptOptions,
	SessionStats,
} from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type { BashResult } from "./bash-executor.ts";
import type { CompactionResult } from "./compaction/index.ts";
import type {
	ContextUsage,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import type { Session } from "./session.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import type { SessionExtensionRunner } from "./session-extensions.ts";
import { type SessionInfo, type SessionListProgress, SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SourceInfo } from "./source-info.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 * Implements Session by delegating to the inner AgentSession.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime implements Session {
	private _rebindCallback?: (session: Session) => Promise<void>;
	private _beforeInvalidateCallback?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	// =========================================================================
	// Session: Event subscription
	// =========================================================================

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		return this._session.subscribe(listener);
	}

	// =========================================================================
	// Session: Agent commands
	// =========================================================================

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await this._session.prompt(text, options);
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		await this._session.steer(text, images);
	}

	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		await this._session.followUp(text, images);
	}

	async abort(): Promise<void> {
		await this._session.abort();
	}

	// =========================================================================
	// Session: Model
	// =========================================================================

	async setModel(model: Model<any>): Promise<void> {
		await this._session.setModel(model);
	}

	async cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		return this._session.cycleModel(direction);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this._session.setThinkingLevel(level);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this._session.cycleThinkingLevel();
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._session.getAvailableThinkingLevels();
	}

	// =========================================================================
	// Session: Compaction
	// =========================================================================

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this._session.compact(customInstructions);
	}

	abortCompaction(): void {
		this._session.abortCompaction();
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this._session.setAutoCompactionEnabled(enabled);
	}

	// =========================================================================
	// Session: Retry
	// =========================================================================

	setAutoRetryEnabled(enabled: boolean): void {
		this._session.setAutoRetryEnabled(enabled);
	}

	abortRetry(): void {
		this._session.abortRetry();
	}

	// =========================================================================
	// Session: Bash
	// =========================================================================

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: unknown },
	): Promise<BashResult> {
		return this._session.executeBash(command, onChunk, options as any);
	}

	abortBash(): void {
		this._session.abortBash();
	}

	recordBashResult(command: string, result: BashResult, options: { excludeFromContext: boolean }): void {
		this._session.recordBashResult(command, result, options);
	}

	// =========================================================================
	// Session: Queue
	// =========================================================================

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._session.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._session.setFollowUpMode(mode);
	}

	getSteeringMessages(): readonly string[] {
		return this._session.getSteeringMessages();
	}

	getFollowUpMessages(): readonly string[] {
		return this._session.getFollowUpMessages();
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		return this._session.clearQueue();
	}

	// =========================================================================
	// Session: Session management (lifecycle — delegates to runtime)
	// =========================================================================

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this._session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this._session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		await emitSessionShutdownEvent(this._session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this._beforeInvalidateCallback?.();
		this._session.dispose();
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this._rebindCallback) {
			await this._rebindCallback(this);
		}
		if (withSession) {
			await withSession(this._session.createReplacedSessionContext());
		}
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this._session.sessionFile;
		const sessionDir = this._session.sessionManager.getSessionDir();
		const sessionManager = SessionManager.create(this.cwd, sessionDir);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		if (options?.setup) {
			await options.setup(this._session.sessionManager);
			this._session.agent.state.messages = this._session.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async switchSession(
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this._session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this._session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this._session.sessionFile;
		if (this._session.sessionManager.isPersisted()) {
			const currentSessionFile = this._session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this._session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sourceManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			const sessionManager = SessionManager.open(forkedSessionPath, sessionDir);
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this._session.sessionManager;
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this._session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this._session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this._session.sessionFile;
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }> {
		return this._session.navigateTree(targetId, options);
	}

	abortBranchSummary(): void {
		this._session.abortBranchSummary();
	}

	setLabel(entryId: string, label: string | undefined): void {
		this._session.sessionManager.appendLabelChange(entryId, label);
	}

	setSessionName(name: string): void {
		this._session.setSessionName(name);
	}

	async reload(): Promise<void> {
		await this._session.reload();
	}

	// =========================================================================
	// Session: Scoped models
	// =========================================================================

	setScopedModels(models: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._session.setScopedModels(models);
	}

	// =========================================================================
	// Session: Tools
	// =========================================================================

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._session.getToolDefinition(name);
	}

	getActiveToolNames(): string[] {
		return this._session.getActiveToolNames();
	}

	getAllTools(): ReadonlyArray<{
		name: string;
		description: string;
		parameters: unknown;
		sourceInfo: SourceInfo;
	}> {
		return this._session.getAllTools();
	}

	setActiveToolsByName(toolNames: string[]): void {
		this._session.setActiveToolsByName(toolNames);
	}

	// =========================================================================
	// Session: Data queries
	// =========================================================================

	getSessionStats(): SessionStats {
		return this._session.getSessionStats();
	}

	getLastAssistantText(): string | undefined {
		return this._session.getLastAssistantText();
	}

	getContextUsage(): ContextUsage | undefined {
		return this._session.getContextUsage();
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		return this._session.getUserMessagesForForking();
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		return this._session.exportToHtml(outputPath);
	}

	exportToJsonl(outputPath?: string): string {
		return this._session.exportToJsonl(outputPath);
	}

	async listSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		return SessionManager.list(
			this._session.sessionManager.getCwd(),
			this._session.sessionManager.getSessionDir(),
			onProgress,
		);
	}

	async listAllSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		return SessionManager.listAll(onProgress);
	}

	// =========================================================================
	// Session: Scalar state
	// =========================================================================

	get model(): Model<any> | undefined {
		return this._session.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this._session.thinkingLevel;
	}

	get isStreaming(): boolean {
		return this._session.isStreaming;
	}

	get isCompacting(): boolean {
		return this._session.isCompacting;
	}

	get isBashRunning(): boolean {
		return this._session.isBashRunning;
	}

	get retryAttempt(): number {
		return this._session.retryAttempt;
	}

	get messages(): AgentMessage[] {
		return this._session.messages;
	}

	get sessionFile(): string | undefined {
		return this._session.sessionFile;
	}

	get sessionId(): string {
		return this._session.sessionId;
	}

	get sessionName(): string | undefined {
		return this._session.sessionName;
	}

	get autoCompactionEnabled(): boolean {
		return this._session.autoCompactionEnabled;
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this._session.steeringMode;
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this._session.followUpMode;
	}

	get pendingMessageCount(): number {
		return this._session.pendingMessageCount;
	}

	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._session.scopedModels;
	}

	get systemPrompt(): string {
		return this._session.systemPrompt;
	}

	get state(): AgentState {
		return this._session.state;
	}

	// =========================================================================
	// Session: Sub-object access
	// =========================================================================

	get sessionManager(): Session["sessionManager"] {
		return this._session.sessionManager;
	}

	get settingsManager(): SettingsManager {
		return this._session.settingsManager;
	}

	get modelRegistry(): ModelRegistry {
		return this._session.modelRegistry;
	}

	get resourceLoader(): ResourceLoader {
		return this._session.resourceLoader;
	}

	get extensionRunner(): SessionExtensionRunner {
		return this._session.extensionRunner;
	}

	get transport(): Transport {
		return this._session.agent.transport;
	}

	set transport(value: Transport) {
		this._session.agent.transport = value;
	}

	get signal(): AbortSignal | undefined {
		return this._session.agent.signal;
	}

	get promptTemplates(): AgentSession["promptTemplates"] {
		return this._session.promptTemplates;
	}

	// =========================================================================
	// Session: Extension binding
	// =========================================================================

	async bindExtensions(bindings: Parameters<AgentSession["bindExtensions"]>[0]): Promise<void> {
		await this._session.bindExtensions(bindings);
	}

	async waitForIdle(): Promise<void> {
		await this._session.agent.waitForIdle();
	}

	// =========================================================================
	// Session: Lifecycle
	// =========================================================================

	setBeforeSessionInvalidate(callback: (() => void) | undefined): void {
		this._beforeInvalidateCallback = callback;
	}

	setRebindSession(callback: ((session: Session) => Promise<void>) | undefined): void {
		this._rebindCallback = callback;
	}

	async dispose(): Promise<void> {
		await emitSessionShutdownEvent(this._session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this._beforeInvalidateCallback?.();
		this._session.dispose();
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
