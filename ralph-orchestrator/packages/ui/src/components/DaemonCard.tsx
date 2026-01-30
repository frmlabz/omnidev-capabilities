/**
 * Daemon Card Component
 */

import type { DaemonWithStatus } from "../lib/daemon-client";
import { StatusBadge } from "./StatusBadge";

interface DaemonCardProps {
	daemon: DaemonWithStatus;
}

export function DaemonCard({ daemon }: DaemonCardProps) {
	const { registration, healthy, stale, prds } = daemon;
	const status = healthy ? "healthy" : stale ? "stale" : "unhealthy";
	const runningCount = prds.filter((p) => p.isRunning).length;

	return (
		<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm transition-all">
			<div className="flex items-start justify-between">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<span className={`w-2 h-2 rounded-full ${healthy ? "bg-green-500" : "bg-red-500"}`} />
						<h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
							{registration.projectName}
						</h3>
					</div>
					<p className="mt-1 text-sm text-gray-500 dark:text-gray-400 truncate">
						{registration.projectPath}
					</p>
					<div className="mt-2 flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
						<span>{prds.length} PRDs</span>
						{runningCount > 0 && (
							<span className="text-purple-600 dark:text-purple-400 font-medium">
								{runningCount} running
							</span>
						)}
					</div>
				</div>
				<StatusBadge status={status} />
			</div>
			{healthy && daemon.latencyMs !== undefined && (
				<p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
					Latency: {daemon.latencyMs}ms
				</p>
			)}
		</div>
	);
}
