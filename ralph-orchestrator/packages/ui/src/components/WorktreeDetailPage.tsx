/**
 * Worktree Detail Page Component
 *
 * Shows worktree info with command execution and real-time output.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useCallback, useRef } from "react";
import { createDaemonClient } from "../lib/daemon-client";
import { useWebSocket } from "../lib/websocket";
import { ConnectionStatus } from "./ConnectionStatus";
import { LogViewer } from "./LogViewer";
import type { WorktreeSummary, CommandStatus } from "../lib/schemas";

interface WorktreeDetailPageProps {
	worktree: WorktreeSummary;
	daemonHost: string;
	daemonPort: number;
	onBack: () => void;
}

interface CommandLog {
	timestamp: string;
	line: string;
}

export function WorktreeDetailPage({
	worktree,
	daemonHost,
	daemonPort,
	onBack,
}: WorktreeDetailPageProps) {
	const queryClient = useQueryClient();
	const client = createDaemonClient(daemonHost, daemonPort);
	const { subscribe, unsubscribe, addCommandLogListener, addCommandEndListener } = useWebSocket();

	const [logs, setLogs] = useState<CommandLog[]>([]);
	const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
	const [commandStatus, setCommandStatus] = useState<CommandStatus | null>(null);
	const mountedRef = useRef(true);

	// Fetch config for available commands
	const { data: config } = useQuery({
		queryKey: ["config", daemonHost, daemonPort],
		queryFn: () => client.getConfig(),
	});

	// Subscribe to worktree on mount
	useEffect(() => {
		subscribe([worktree.name], "worktree");

		return () => {
			unsubscribe([worktree.name], "worktree");
			mountedRef.current = false;
		};
	}, [worktree.name, subscribe, unsubscribe]);

	// Listen for command logs
	useEffect(() => {
		const unsubLog = addCommandLogListener((wt, cmdId, line, timestamp) => {
			if (wt === worktree.name && cmdId === activeCommandId && mountedRef.current) {
				setLogs((prev) => [...prev, { timestamp, line }]);
			}
		});

		const unsubEnd = addCommandEndListener((wt, cmdId, status) => {
			if (wt === worktree.name && cmdId === activeCommandId && mountedRef.current) {
				setCommandStatus(status);
			}
		});

		return () => {
			unsubLog();
			unsubEnd();
		};
	}, [worktree.name, activeCommandId, addCommandLogListener, addCommandEndListener]);

	// Run command mutation
	const runMutation = useMutation({
		mutationFn: (commandKey: string) => client.runCommand(worktree.name, commandKey),
		onSuccess: (data) => {
			setActiveCommandId(data.commandId);
			setCommandStatus("running");
			setLogs([]);
			queryClient.invalidateQueries({ queryKey: ["worktrees"] });
		},
	});

	// Stop command mutation
	const stopMutation = useMutation({
		mutationFn: () => {
			if (!activeCommandId) throw new Error("No active command");
			return client.stopCommand(worktree.name, activeCommandId);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["worktrees"] });
		},
	});

	const clearLogs = useCallback(() => {
		setLogs([]);
		setActiveCommandId(null);
		setCommandStatus(null);
	}, []);

	const isRunning = commandStatus === "running";
	const isMutating = runMutation.isPending || stopMutation.isPending;

	return (
		<div className="space-y-6">
			{/* Header with back button */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
				<div className="flex items-center gap-3 sm:gap-4">
					<button
						type="button"
						onClick={onBack}
						className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors touch-manipulation"
						aria-label="Go back"
					>
						<svg
							className="w-6 h-6 sm:w-5 sm:h-5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M15 19l-7-7 7-7"
							/>
						</svg>
					</button>
					<div>
						<div className="flex items-center gap-2">
							<h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100">
								{worktree.name}
							</h1>
							{worktree.isMain && (
								<span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 px-1.5 py-0.5 rounded">
									main
								</span>
							)}
						</div>
						<p className="text-sm text-gray-500 dark:text-gray-400">{worktree.branch}</p>
					</div>
				</div>
				<ConnectionStatus />
			</div>

			{/* Info card */}
			<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
				<div className="grid gap-4 sm:grid-cols-2">
					<div>
						<dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Path</dt>
						<dd className="mt-1 text-sm text-gray-900 dark:text-gray-100 font-mono truncate">
							{worktree.path}
						</dd>
					</div>
					<div>
						<dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Branch</dt>
						<dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{worktree.branch}</dd>
					</div>
					{worktree.prdName && (
						<div>
							<dt className="text-sm font-medium text-gray-500 dark:text-gray-400">PRD</dt>
							<dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{worktree.prdName}</dd>
						</div>
					)}
				</div>
			</div>

			{/* Command buttons */}
			<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
				<h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
					Commands
				</h2>

				<div className="flex flex-wrap gap-3">
					{config?.commands &&
						Object.entries(config.commands).map(([key, cmd]) => (
							<button
								key={key}
								type="button"
								onClick={() => runMutation.mutate(key)}
								disabled={isMutating || isRunning}
								className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							>
								{cmd.label}
							</button>
						))}

					{isRunning && (
						<button
							type="button"
							onClick={() => stopMutation.mutate()}
							disabled={isMutating}
							className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							Stop
						</button>
					)}
				</div>

				{/* Status indicator */}
				{commandStatus && (
					<div className="mt-4">
						<span
							className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
								commandStatus === "running"
									? "bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300"
									: commandStatus === "success"
										? "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300"
										: "bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300"
							}`}
						>
							{commandStatus === "running"
								? "Running..."
								: commandStatus === "success"
									? "Completed"
									: "Failed"}
						</span>
					</div>
				)}

				{/* Error display */}
				{runMutation.error && (
					<div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-red-700 dark:text-red-400 text-sm">
						{runMutation.error.message}
					</div>
				)}
			</div>

			{/* Output section */}
			<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
				<div className="flex items-center justify-between mb-4">
					<h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
						Output
					</h2>
					{logs.length > 0 && (
						<span className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">
							{logs.length} lines
						</span>
					)}
				</div>
				<LogViewer logs={logs} maxHeight="60vh" onClear={clearLogs} />
			</div>
		</div>
	);
}
