/**
 * `pi connect` subcommand: connect the TUI to a remote pi --mode rpc process.
 *
 * Usage:
 *   pi connect <socket-path>        Connect via Unix domain socket
 *   pi connect --stdio              Connect via stdin/stdout (for piping)
 *   pi connect --exec <command...>  Spawn a command and connect to its stdio
 *
 * Examples:
 *   pi connect /tmp/pi.sock
 *   pi connect --exec ssh remote pi --mode rpc
 *   ssh remote pi --mode rpc | pi connect --stdio
 */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { RpcAgentSession } from "../core/rpc-agent-session.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { InteractiveMode } from "../modes/interactive/interactive-mode.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";

interface ConnectOptions {
	socketPath?: string;
	stdio?: boolean;
	exec?: string[];
}

function parseConnectArgs(args: string[]): ConnectOptions | undefined {
	if (args[0] !== "connect") return undefined;

	const options: ConnectOptions = {};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--stdio") {
			options.stdio = true;
		} else if (arg === "--exec") {
			options.exec = args.slice(i + 1);
			break;
		} else if (arg === "--help" || arg === "-h") {
			printConnectHelp();
			process.exit(0);
		} else if (!arg.startsWith("-")) {
			options.socketPath = arg;
		} else {
			console.error(chalk.red(`Unknown option: ${arg}`));
			printConnectHelp();
			process.exit(1);
		}
	}

	return options;
}

function printConnectHelp(): void {
	console.log(`
${chalk.bold("Usage:")} ${APP_NAME} connect <socket-path>
       ${APP_NAME} connect --exec <command...>

${chalk.bold(`Connect the TUI to a remote ${APP_NAME} --mode rpc process.`)}

${chalk.bold("Options:")}
  <socket-path>        Unix domain socket path
  --exec <command...>  Spawn command and connect to its stdio
  -h, --help           Show this help

${chalk.bold("Examples:")}
  ${chalk.dim("# Connect to a domain socket")}
  ${APP_NAME} connect /tmp/pi.sock

  ${chalk.dim("# Spawn and connect to a remote agent over SSH")}
  ${APP_NAME} connect --exec ssh remote ${APP_NAME} --mode rpc

  ${chalk.dim("# Forward a socket and connect")}
  ssh -L /tmp/pi.sock:/run/pi.sock remote &
  ${APP_NAME} connect /tmp/pi.sock
`);
}

export async function handleConnectCommand(args: string[]): Promise<boolean> {
	const options = parseConnectArgs(args);
	if (!options) return false;

	if (!options.socketPath && !options.stdio && !options.exec) {
		console.error(chalk.red("Must specify a socket path, --stdio, or --exec <command>"));
		printConnectHelp();
		process.exitCode = 1;
		return true;
	}

	let input: NodeJS.ReadableStream;
	let output: NodeJS.WritableStream;
	let cleanup: () => void = () => {};

	if (options.socketPath) {
		const socket = createConnection(options.socketPath);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", (err) => {
				reject(new Error(`Failed to connect to ${options.socketPath}: ${err.message}`));
			});
		});
		input = socket;
		output = socket;
		cleanup = () => socket.destroy();
	} else if (options.exec && options.exec.length > 0) {
		const [cmd, ...cmdArgs] = options.exec;
		const child = spawn(cmd!, cmdArgs, {
			stdio: ["pipe", "pipe", "inherit"],
		});
		child.on("exit", (code) => {
			console.error(chalk.dim(`Remote process exited with code ${code}`));
			process.exit(code ?? 1);
		});
		input = child.stdout!;
		output = child.stdin!;
		cleanup = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// already exited
			}
		};
	} else {
		// --stdio: use process stdin/stdout (for piping)
		input = process.stdin;
		output = process.stdout;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const backend = new RpcAgentSession({
		input: input as any,
		output: output as any,
		settingsManager,
	});

	try {
		await backend.syncState();
	} catch (err) {
		console.error(chalk.red(`Failed to sync with remote agent: ${err instanceof Error ? err.message : err}`));
		cleanup();
		process.exitCode = 1;
		return true;
	}

	initTheme(settingsManager.getTheme(), true);

	const mode = new InteractiveMode(backend, { resourceLoader });

	backend.onDisconnect(() => {
		mode.stop();
		stopThemeWatcher();
		console.error(chalk.red("\nRemote agent disconnected."));
		cleanup();
		process.exit(1);
	});

	try {
		await mode.run();
	} finally {
		stopThemeWatcher();
		await backend.dispose();
		cleanup();
	}

	return true;
}
