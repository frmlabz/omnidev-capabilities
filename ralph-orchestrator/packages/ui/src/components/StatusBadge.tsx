/**
 * Status Badge Component
 */

import type { PRDStatus, StoryStatus } from "../lib/schemas";

type StatusType = PRDStatus | StoryStatus | "healthy" | "unhealthy" | "stale" | "running";

const statusConfig: Record<StatusType, { bg: string; text: string; label: string }> = {
	pending: { bg: "bg-yellow-100", text: "text-yellow-800", label: "Pending" },
	testing: { bg: "bg-blue-100", text: "text-blue-800", label: "Testing" },
	completed: { bg: "bg-green-100", text: "text-green-800", label: "Completed" },
	in_progress: { bg: "bg-blue-100", text: "text-blue-800", label: "In Progress" },
	blocked: { bg: "bg-red-100", text: "text-red-800", label: "Blocked" },
	healthy: { bg: "bg-green-100", text: "text-green-800", label: "Online" },
	unhealthy: { bg: "bg-red-100", text: "text-red-800", label: "Offline" },
	stale: { bg: "bg-yellow-100", text: "text-yellow-800", label: "Stale" },
	running: { bg: "bg-purple-100", text: "text-purple-800", label: "Running" },
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
