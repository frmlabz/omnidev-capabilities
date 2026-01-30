/**
 * Worktree Card Component
 */

import type { WorktreeSummary } from "../lib/schemas";
import { StatusBadge } from "./StatusBadge";

interface WorktreeCardProps {
	worktree: WorktreeSummary;
	onClick?: () => void;
}

export function WorktreeCard({ worktree, onClick }: WorktreeCardProps) {
	const cardClasses = onClick
		? "bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all cursor-pointer"
		: "bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4";

	const hasRunningCommands = worktree.runningCommands.length > 0;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: role="button" is conditionally applied with onClick
		<div
			className={cardClasses}
			onClick={onClick}
			role={onClick ? "button" : undefined}
			tabIndex={onClick ? 0 : undefined}
			onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
		>
			<div className="flex items-start justify-between">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
							{worktree.name}
						</h3>
						{worktree.isMain && (
							<span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 px-1.5 py-0.5 rounded">
								main
							</span>
						)}
					</div>
					<p className="mt-1 text-sm text-gray-500 dark:text-gray-400 truncate">
						{worktree.branch}
					</p>
				</div>
				<div className="flex flex-col items-end gap-1 ml-4">
					{hasRunningCommands && <StatusBadge status="running" />}
					{worktree.prdName && (
						<span className="text-xs text-gray-500 dark:text-gray-400">
							PRD: {worktree.prdName}
						</span>
					)}
				</div>
			</div>

			{hasRunningCommands && (
				<div className="mt-3 text-sm text-gray-600 dark:text-gray-400">
					{worktree.runningCommands.length} command(s) running
				</div>
			)}
		</div>
	);
}
