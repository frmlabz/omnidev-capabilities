/**
 * PRD Detail Page Component
 *
 * Shows detailed PRD information with real-time logs and action controls.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createDaemonClient } from "../lib/daemon-client";
import { usePrdLogs } from "../hooks/usePrdLogs";
import { ConnectionStatus } from "./ConnectionStatus";
import { LogViewer } from "./LogViewer";
import { StatusBadge } from "./StatusBadge";
import type { PRDSummary } from "../lib/schemas";

interface PRDDetailPageProps {
	prd: PRDSummary;
	daemonHost: string;
	daemonPort: number;
	daemonName: string;
	onBack: () => void;
}

/**
 * PRD Detail Page
 *
 * Features:
 * - Back button to return to dashboard
 * - PRD name, description, status badge
 * - Progress bar showing completed/total stories
 * - Start/Stop/Test action buttons
 * - Embedded LogViewer with real-time logs
 */
export function PRDDetailPage({
	prd,
	daemonHost,
	daemonPort,
	daemonName,
	onBack,
}: PRDDetailPageProps) {
	const queryClient = useQueryClient();
	const client = createDaemonClient(daemonHost, daemonPort);

	// Fetch initial logs
	const { data: initialLogs = [] } = useQuery({
		queryKey: ["logs", daemonHost, daemonPort, prd.name],
		queryFn: () => client.getLogs(prd.name, 100),
	});

	// Real-time logs via WebSocket
	const { logs, clearLogs } = usePrdLogs({
		prdName: prd.name,
		initialLogs,
	});

	// Start mutation
	const startMutation = useMutation({
		mutationFn: () => client.startPRD(prd.name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["daemons"] });
		},
	});

	// Stop mutation
	const stopMutation = useMutation({
		mutationFn: () => client.stopPRD(prd.name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["daemons"] });
		},
	});

	// Test mutation
	const testMutation = useMutation({
		mutationFn: () => client.testPRD(prd.name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["daemons"] });
		},
	});

	const progressPercent =
		prd.progress.total > 0 ? Math.round((prd.progress.completed / prd.progress.total) * 100) : 0;

	const isRunning = prd.isRunning;
	const isMutating = startMutation.isPending || stopMutation.isPending || testMutation.isPending;

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
						<h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100">
							{prd.name}
						</h1>
						<p className="text-sm text-gray-500 dark:text-gray-400">{daemonName}</p>
					</div>
				</div>
				<ConnectionStatus />
			</div>

			{/* Status and info card */}
			<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
				<div className="flex items-start justify-between mb-4">
					<div className="flex-1">
						<p className="text-gray-600 dark:text-gray-300">{prd.description}</p>
					</div>
					<div className="flex gap-2 ml-4">
						<StatusBadge status={prd.status} />
						{isRunning && <StatusBadge status="running" />}
					</div>
				</div>

				{/* Progress bar */}
				<div className="mb-6">
					<div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 mb-2">
						<span>
							{prd.progress.completed}/{prd.progress.total} stories completed
						</span>
						<span>{progressPercent}%</span>
					</div>
					<div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
						<div
							className="bg-green-500 h-3 rounded-full transition-all"
							style={{ width: `${progressPercent}%` }}
						/>
					</div>
					{prd.hasBlockedStories && (
						<p className="mt-2 text-sm text-red-600 dark:text-red-400">
							{prd.progress.blocked} blocked stories
						</p>
					)}
				</div>

				{/* Action buttons */}
				<div className="flex flex-col sm:flex-row gap-3">
					{isRunning ? (
						<button
							type="button"
							onClick={() => stopMutation.mutate()}
							disabled={isMutating}
							className="px-4 py-3 sm:py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							{stopMutation.isPending ? "Stopping..." : "Stop"}
						</button>
					) : (
						<>
							<button
								type="button"
								onClick={() => startMutation.mutate()}
								disabled={isMutating || !prd.canStart}
								className="px-4 py-3 sm:py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							>
								{startMutation.isPending ? "Starting..." : "Start Development"}
							</button>
							<button
								type="button"
								onClick={() => testMutation.mutate()}
								disabled={isMutating}
								className="px-4 py-3 sm:py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							>
								{testMutation.isPending ? "Starting..." : "Run Tests"}
							</button>
						</>
					)}
				</div>

				{/* Error display */}
				{(startMutation.error || stopMutation.error || testMutation.error) && (
					<div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-red-700 dark:text-red-400 text-sm">
						{(startMutation.error || stopMutation.error || testMutation.error)?.message ||
							"An error occurred"}
					</div>
				)}

				{/* Unmet dependencies warning */}
				{prd.unmetDependencies.length > 0 && (
					<div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md text-yellow-800 dark:text-yellow-300 text-sm">
						<strong>Unmet dependencies:</strong> {prd.unmetDependencies.join(", ")}
					</div>
				)}
			</div>

			{/* Logs section */}
			<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
				<div className="flex items-center justify-between mb-4">
					<h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100">
						Logs
					</h2>
					{logs.length > 0 && (
						<span className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">
							{logs.length} entries
						</span>
					)}
				</div>
				<LogViewer logs={logs} maxHeight="60vh" onClear={clearLogs} />
			</div>
		</div>
	);
}
