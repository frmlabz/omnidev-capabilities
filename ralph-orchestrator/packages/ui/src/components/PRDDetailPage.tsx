/**
 * PRD Detail Page Component
 *
 * Shows detailed PRD information with real-time logs and state-appropriate actions:
 * - pending: Start (creates worktree)
 * - in_progress: Start (resume)
 * - testing: Test
 * - completed: Merge
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createDaemonClient } from "../lib/daemon-client";
import { usePrdLogs } from "../hooks/usePrdLogs";
import { ConnectionStatus } from "./ConnectionStatus";
import { LogViewer } from "./LogViewer";
import { CollapsibleSection } from "./CollapsibleSection";
import type { PRDSummary, PRDDisplayState, Story, StoryStatus } from "../lib/schemas";

interface PRDDetailPageProps {
	prd: PRDSummary;
	daemonHost: string;
	daemonPort: number;
	daemonName: string;
	onBack: () => void;
}

/**
 * Get display info for a PRD state
 */
function getStateDisplay(state: PRDDisplayState): {
	label: string;
	color: string;
	bgColor: string;
} {
	switch (state) {
		case "pending":
			return {
				label: "Pending",
				color: "text-gray-700 dark:text-gray-300",
				bgColor: "bg-gray-100 dark:bg-gray-700",
			};
		case "in_progress":
			return {
				label: "In Progress",
				color: "text-blue-700 dark:text-blue-300",
				bgColor: "bg-blue-100 dark:bg-blue-900/50",
			};
		case "testing":
			return {
				label: "Testing",
				color: "text-yellow-700 dark:text-yellow-300",
				bgColor: "bg-yellow-100 dark:bg-yellow-900/50",
			};
		case "completed":
			return {
				label: "Completed",
				color: "text-green-700 dark:text-green-300",
				bgColor: "bg-green-100 dark:bg-green-900/50",
			};
	}
}

/**
 * Get display info for a story status
 */
function getStoryStatusDisplay(status: StoryStatus): {
	label: string;
	color: string;
	bgColor: string;
	icon: string;
} {
	switch (status) {
		case "pending":
			return {
				label: "Pending",
				color: "text-gray-600 dark:text-gray-400",
				bgColor: "bg-gray-100 dark:bg-gray-700",
				icon: "○",
			};
		case "in_progress":
			return {
				label: "In Progress",
				color: "text-blue-600 dark:text-blue-400",
				bgColor: "bg-blue-100 dark:bg-blue-900/50",
				icon: "◐",
			};
		case "completed":
			return {
				label: "Completed",
				color: "text-green-600 dark:text-green-400",
				bgColor: "bg-green-100 dark:bg-green-900/50",
				icon: "●",
			};
		case "blocked":
			return {
				label: "Blocked",
				color: "text-red-600 dark:text-red-400",
				bgColor: "bg-red-100 dark:bg-red-900/50",
				icon: "⊘",
			};
	}
}

/**
 * Get action button config for a PRD state
 */
function getActionConfig(
	state: PRDDisplayState,
	isRunning: boolean,
): {
	action: "start" | "test" | "merge" | "stop";
	label: string;
	loadingLabel: string;
	color: string;
} | null {
	if (isRunning) {
		return {
			action: "stop",
			label: "Stop",
			loadingLabel: "Stopping...",
			color: "bg-red-600 hover:bg-red-700",
		};
	}

	switch (state) {
		case "pending":
			return {
				action: "start",
				label: "Start Development",
				loadingLabel: "Creating worktree...",
				color: "bg-green-600 hover:bg-green-700",
			};
		case "in_progress":
			return {
				action: "start",
				label: "Resume Development",
				loadingLabel: "Starting...",
				color: "bg-green-600 hover:bg-green-700",
			};
		case "testing":
			return {
				action: "test",
				label: "Run Tests",
				loadingLabel: "Starting tests...",
				color: "bg-blue-600 hover:bg-blue-700",
			};
		case "completed":
			return {
				action: "merge",
				label: "Merge to Main",
				loadingLabel: "Merging...",
				color: "bg-purple-600 hover:bg-purple-700",
			};
	}
}

/**
 * Story Card Component
 */
function StoryCard({ story }: { story: Story }) {
	const statusDisplay = getStoryStatusDisplay(story.status);

	return (
		<div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-900/50">
			{/* Header */}
			<div className="flex items-start justify-between gap-3 mb-2">
				<div className="flex items-center gap-2">
					<span className="text-sm font-mono text-gray-500 dark:text-gray-400">{story.id}</span>
					<span
						className={`px-2 py-0.5 rounded text-xs font-medium ${statusDisplay.color} ${statusDisplay.bgColor}`}
					>
						{statusDisplay.icon} {statusDisplay.label}
					</span>
				</div>
				<span className="text-xs text-gray-500 dark:text-gray-400">Priority: {story.priority}</span>
			</div>

			{/* Title */}
			<h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">{story.title}</h4>

			{/* Acceptance Criteria */}
			{story.acceptanceCriteria.length > 0 && (
				<div className="mb-2">
					<p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Acceptance Criteria:</p>
					<ul className="list-disc list-inside text-xs text-gray-600 dark:text-gray-300 space-y-0.5">
						{story.acceptanceCriteria.map((criteria) => (
							<li key={criteria} className="break-words">
								{criteria}
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Questions (if blocked) */}
			{story.status === "blocked" && story.questions.length > 0 && (
				<div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
					<p className="text-xs font-medium text-red-700 dark:text-red-300 mb-1">Questions:</p>
					<ul className="list-decimal list-inside text-xs text-red-600 dark:text-red-400 space-y-0.5">
						{story.questions.map((q) => (
							<li key={q}>{q}</li>
						))}
					</ul>
					{story.answers && story.answers.length > 0 && (
						<>
							<p className="text-xs font-medium text-green-700 dark:text-green-300 mt-2 mb-1">
								Answers:
							</p>
							<ul className="list-decimal list-inside text-xs text-green-600 dark:text-green-400 space-y-0.5">
								{story.answers.map((a) => (
									<li key={a}>{a}</li>
								))}
							</ul>
						</>
					)}
				</div>
			)}

			{/* Iteration count */}
			{story.iterationCount !== undefined && story.iterationCount > 0 && (
				<p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
					Iterations: {story.iterationCount}
				</p>
			)}
		</div>
	);
}

export function PRDDetailPage({
	prd,
	daemonHost,
	daemonPort,
	daemonName,
	onBack,
}: PRDDetailPageProps) {
	const queryClient = useQueryClient();
	const client = createDaemonClient(daemonHost, daemonPort);

	// Fetch full PRD details including stories and spec
	const { data: prdDetails } = useQuery({
		queryKey: ["prd-details", daemonHost, daemonPort, prd.name],
		queryFn: () => client.getPRD(prd.name),
	});

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

	// Start mutation (creates worktree if needed)
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

	// Merge mutation
	const mergeMutation = useMutation({
		mutationFn: () => client.mergePRD(prd.name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["daemons"] });
			// Go back after successful merge
			onBack();
		},
	});

	const progressPercent =
		prd.storyCount > 0 ? Math.round((prd.completedStories / prd.storyCount) * 100) : 0;

	const isRunning = prd.isRunning;
	const isMutating =
		startMutation.isPending ||
		stopMutation.isPending ||
		testMutation.isPending ||
		mergeMutation.isPending;

	const stateDisplay = getStateDisplay(prd.displayState);
	const actionConfig = getActionConfig(prd.displayState, isRunning);

	const handleAction = () => {
		if (!actionConfig) return;

		switch (actionConfig.action) {
			case "start":
				startMutation.mutate();
				break;
			case "stop":
				stopMutation.mutate();
				break;
			case "test":
				testMutation.mutate();
				break;
			case "merge":
				mergeMutation.mutate();
				break;
		}
	};

	const getIsActionPending = () => {
		if (!actionConfig) return false;
		switch (actionConfig.action) {
			case "start":
				return startMutation.isPending;
			case "stop":
				return stopMutation.isPending;
			case "test":
				return testMutation.isPending;
			case "merge":
				return mergeMutation.isPending;
		}
	};

	// Group stories by status for summary
	const stories = prdDetails?.stories ?? [];
	const storyCountByStatus = stories.reduce(
		(acc, story) => {
			acc[story.status] = (acc[story.status] || 0) + 1;
			return acc;
		},
		{} as Record<StoryStatus, number>,
	);

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
						<span
							className={`px-2 py-1 rounded text-xs font-medium ${stateDisplay.color} ${stateDisplay.bgColor}`}
						>
							{stateDisplay.label}
						</span>
						{isRunning && (
							<span className="px-2 py-1 rounded text-xs font-medium text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/50 animate-pulse">
								Running
							</span>
						)}
					</div>
				</div>

				{/* Progress bar */}
				<div className="mb-6">
					<div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 mb-2">
						<span>
							{prd.completedStories}/{prd.storyCount} stories completed
						</span>
						<span>{progressPercent}%</span>
					</div>
					<div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
						<div
							className="bg-green-500 h-3 rounded-full transition-all"
							style={{ width: `${progressPercent}%` }}
						/>
					</div>
					{prd.blockedStories > 0 && (
						<p className="mt-2 text-sm text-red-600 dark:text-red-400">
							{prd.blockedStories} blocked stories
						</p>
					)}
				</div>

				{/* Worktree info */}
				{prd.worktree && (
					<div className="mb-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-md text-sm text-gray-600 dark:text-gray-400">
						<span className="font-medium">Worktree:</span> {prd.worktree}
					</div>
				)}

				{/* Action button */}
				{actionConfig && (
					<div className="flex flex-col sm:flex-row gap-3">
						<button
							type="button"
							onClick={handleAction}
							disabled={isMutating}
							className={`px-4 py-3 sm:py-2 text-sm font-medium text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${actionConfig.color}`}
						>
							{getIsActionPending() ? actionConfig.loadingLabel : actionConfig.label}
						</button>
					</div>
				)}

				{/* Error display */}
				{(startMutation.error ||
					stopMutation.error ||
					testMutation.error ||
					mergeMutation.error) && (
					<div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-red-700 dark:text-red-400 text-sm">
						{(
							startMutation.error ||
							stopMutation.error ||
							testMutation.error ||
							mergeMutation.error
						)?.message || "An error occurred"}
					</div>
				)}
			</div>

			{/* User Stories Section */}
			<CollapsibleSection
				title="User Stories"
				badge={`${prd.completedStories}/${prd.storyCount}`}
				defaultCollapsed={false}
			>
				{/* Status summary */}
				<div className="flex flex-wrap gap-2 mb-4">
					{(["completed", "in_progress", "pending", "blocked"] as StoryStatus[]).map((status) => {
						const count = storyCountByStatus[status] || 0;
						if (count === 0) return null;
						const display = getStoryStatusDisplay(status);
						return (
							<span
								key={status}
								className={`px-2 py-1 rounded text-xs font-medium ${display.color} ${display.bgColor}`}
							>
								{display.icon} {count} {display.label}
							</span>
						);
					})}
				</div>

				{/* Story list */}
				{stories.length > 0 ? (
					<div className="space-y-3">
						{stories.map((story) => (
							<StoryCard key={story.id} story={story} />
						))}
					</div>
				) : (
					<p className="text-sm text-gray-500 dark:text-gray-400">Loading stories...</p>
				)}
			</CollapsibleSection>

			{/* Spec Section */}
			{prdDetails?.spec && (
				<CollapsibleSection title="Spec" defaultCollapsed={true}>
					<div className="prose prose-sm dark:prose-invert max-w-none">
						<pre className="whitespace-pre-wrap text-xs bg-gray-50 dark:bg-gray-900 p-4 rounded-lg overflow-x-auto">
							{prdDetails.spec}
						</pre>
					</div>
				</CollapsibleSection>
			)}

			{/* Logs section */}
			<CollapsibleSection
				title="Logs"
				badge={logs.length > 0 ? logs.length : undefined}
				defaultCollapsed={false}
			>
				<LogViewer logs={logs} maxHeight="60vh" onClear={clearLogs} />
			</CollapsibleSection>
		</div>
	);
}
