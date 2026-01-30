/**
 * Worktree Page
 *
 * Route component that fetches worktree data and renders the detail view.
 */

import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate } from "@tanstack/react-router";
import { createDaemonClient } from "../lib/daemon-client";
import { WebSocketProvider } from "../lib/websocket";
import { WorktreeDetailPage } from "../components/WorktreeDetailPage";

export function WorktreePage() {
	const { host, port, name } = useParams({ from: "/worktree/$host/$port/$name" });
	const navigate = useNavigate();
	const portNum = Number.parseInt(port, 10);

	const client = createDaemonClient(host, portNum);

	// Fetch worktree data
	const {
		data: worktree,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["worktree", host, port, name],
		queryFn: async () => {
			const worktrees = await client.getWorktrees();
			return worktrees.find((wt) => wt.name === name) || null;
		},
		refetchInterval: 5000,
	});

	const handleBack = () => {
		navigate({ to: "/" });
	};

	if (isLoading) {
		return (
			<div className="max-w-6xl mx-auto px-4 py-8">
				<div className="animate-pulse">
					<div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-4" />
					<div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-2/3 mb-8" />
					<div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
				</div>
			</div>
		);
	}

	if (error || !worktree) {
		return (
			<div className="max-w-6xl mx-auto px-4 py-8">
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
					<h2 className="text-lg font-semibold text-red-700 dark:text-red-400 mb-2">
						Failed to load Worktree
					</h2>
					<p className="text-red-600 dark:text-red-300 mb-4">
						{error?.message || "Worktree not found"}
					</p>
					<button
						type="button"
						onClick={handleBack}
						className="px-4 py-2 bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900"
					>
						Back to Dashboard
					</button>
				</div>
			</div>
		);
	}

	return (
		<WebSocketProvider host={host} port={portNum}>
			<div className="max-w-6xl mx-auto px-4 py-8">
				<WorktreeDetailPage
					worktree={worktree}
					daemonHost={host}
					daemonPort={portNum}
					onBack={handleBack}
				/>
			</div>
		</WebSocketProvider>
	);
}
