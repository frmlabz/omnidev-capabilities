/**
 * PRD Card Component
 *
 * Displays PRD info with state-appropriate actions:
 * - pending: Start (creates worktree)
 * - in_progress: Start (resume)
 * - testing: Test
 * - completed: Merge
 */

import type { PRDSummary, PRDDisplayState } from "../lib/schemas";

interface PRDCardProps {
	prd: PRDSummary;
	daemonName: string;
	daemonHost?: string;
	daemonPort?: number;
	onClick?: () => void;
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

export function PRDCard({ prd, daemonName, onClick }: PRDCardProps) {
	const progressPercent =
		prd.storyCount > 0 ? Math.round((prd.completedStories / prd.storyCount) * 100) : 0;

	const stateDisplay = getStateDisplay(prd.displayState);

	const cardClasses = onClick
		? "bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all cursor-pointer"
		: "bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm transition-all";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: role="button" is conditionally applied with onClick
		<div
			className={cardClasses}
			onClick={onClick}
			onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
			role={onClick ? "button" : undefined}
			tabIndex={onClick ? 0 : undefined}
		>
			<div className="flex items-start justify-between">
				<div className="flex-1 min-w-0">
					<h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
						{prd.name}
					</h3>
					<p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
						{prd.description}
					</p>
				</div>
				<div className="flex flex-col items-end gap-1 ml-4">
					<span
						className={`px-2 py-1 rounded text-xs font-medium ${stateDisplay.color} ${stateDisplay.bgColor}`}
					>
						{stateDisplay.label}
					</span>
					{prd.isRunning && (
						<span className="px-2 py-1 rounded text-xs font-medium text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/50 animate-pulse">
							Running
						</span>
					)}
				</div>
			</div>

			<div className="mt-3">
				<div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 mb-1">
					<span>
						{prd.completedStories}/{prd.storyCount} stories
					</span>
					<span>{progressPercent}%</span>
				</div>
				<div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
					<div
						className="bg-green-500 h-2 rounded-full transition-all"
						style={{ width: `${progressPercent}%` }}
					/>
				</div>
			</div>

			<div className="mt-2 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
				<span>{daemonName}</span>
				{prd.blockedStories > 0 && (
					<span className="text-red-600 dark:text-red-400 font-medium">
						{prd.blockedStories} blocked
					</span>
				)}
			</div>
		</div>
	);
}
