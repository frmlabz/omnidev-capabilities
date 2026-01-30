/**
 * PRD Card Component
 */

import type { PRDSummary } from "../lib/schemas";
import { StatusBadge } from "./StatusBadge";

interface PRDCardProps {
	prd: PRDSummary;
	daemonName: string;
}

export function PRDCard({ prd, daemonName }: PRDCardProps) {
	const progressPercent =
		prd.progress.total > 0 ? Math.round((prd.progress.completed / prd.progress.total) * 100) : 0;

	return (
		<div className="bg-white rounded-lg border border-gray-200 p-4 hover:border-gray-300 hover:shadow-sm transition-all">
			<div className="flex items-start justify-between">
				<div className="flex-1 min-w-0">
					<h3 className="text-lg font-semibold text-gray-900 truncate">{prd.name}</h3>
					<p className="mt-1 text-sm text-gray-500 line-clamp-2">{prd.description}</p>
				</div>
				<div className="flex flex-col items-end gap-1 ml-4">
					<StatusBadge status={prd.status} />
					{prd.isRunning && <StatusBadge status="running" />}
				</div>
			</div>

			<div className="mt-3">
				<div className="flex items-center justify-between text-sm text-gray-600 mb-1">
					<span>
						{prd.progress.completed}/{prd.progress.total} stories
					</span>
					<span>{progressPercent}%</span>
				</div>
				<div className="w-full bg-gray-200 rounded-full h-2">
					<div
						className="bg-green-500 h-2 rounded-full transition-all"
						style={{ width: `${progressPercent}%` }}
					/>
				</div>
			</div>

			<div className="mt-2 flex items-center justify-between text-xs text-gray-500">
				<span>{daemonName}</span>
				{prd.hasBlockedStories && (
					<span className="text-red-600 font-medium">{prd.progress.blocked} blocked</span>
				)}
			</div>
		</div>
	);
}
