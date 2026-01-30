/**
 * Status Badge Component
 */

import type { PRDStatus, StoryStatus } from "../lib/schemas";

type StatusType = PRDStatus | StoryStatus | "healthy" | "unhealthy" | "stale" | "running";

const statusConfig: Record<StatusType, { bg: string; text: string; label: string }> = {
	pending: {
		bg: "bg-yellow-100 dark:bg-yellow-900/30",
		text: "text-yellow-800 dark:text-yellow-300",
		label: "Pending",
	},
	testing: {
		bg: "bg-blue-100 dark:bg-blue-900/30",
		text: "text-blue-800 dark:text-blue-300",
		label: "Testing",
	},
	completed: {
		bg: "bg-green-100 dark:bg-green-900/30",
		text: "text-green-800 dark:text-green-300",
		label: "Completed",
	},
	in_progress: {
		bg: "bg-blue-100 dark:bg-blue-900/30",
		text: "text-blue-800 dark:text-blue-300",
		label: "In Progress",
	},
	blocked: {
		bg: "bg-red-100 dark:bg-red-900/30",
		text: "text-red-800 dark:text-red-300",
		label: "Blocked",
	},
	healthy: {
		bg: "bg-green-100 dark:bg-green-900/30",
		text: "text-green-800 dark:text-green-300",
		label: "Online",
	},
	unhealthy: {
		bg: "bg-red-100 dark:bg-red-900/30",
		text: "text-red-800 dark:text-red-300",
		label: "Offline",
	},
	stale: {
		bg: "bg-yellow-100 dark:bg-yellow-900/30",
		text: "text-yellow-800 dark:text-yellow-300",
		label: "Stale",
	},
	running: {
		bg: "bg-purple-100 dark:bg-purple-900/30",
		text: "text-purple-800 dark:text-purple-300",
		label: "Running",
	},
};

interface StatusBadgeProps {
	status: StatusType;
	className?: string;
}

export function StatusBadge({ status, className = "" }: StatusBadgeProps) {
	const config = statusConfig[status];

	return (
		<span
			className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text} ${className}`}
		>
			{config.label}
		</span>
	);
}
