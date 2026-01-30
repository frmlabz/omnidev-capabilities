/**
 * PRD Page
 *
 * Route component that fetches PRD data and renders the detail view.
 * This ensures fresh data is always displayed, even after WebSocket updates.
 */

import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate } from "@tanstack/react-router";
import { createDaemonClient } from "../lib/daemon-client";
import { WebSocketProvider } from "../lib/websocket";
import { PRDDetailPage } from "../components/PRDDetailPage";

export function PRDPage() {
	const { host, port, name } = useParams({ from: "/prd/$host/$port/$name" });
	const navigate = useNavigate();
	const portNum = Number.parseInt(port, 10);

	const client = createDaemonClient(host, portNum);

	// Fetch PRD data - this query will be invalidated by WebSocket events
	const {
		data: prd,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["prd", host, port, name],
		queryFn: async () => {
			const prds = await client.getPRDs();
			return prds.find((p) => p.name === name) || null;
		},
		refetchInterval: 5000, // Fallback polling
	});

	// Also fetch daemon info for the name
	const { data: daemonInfo } = useQuery({
		queryKey: ["daemon-info", host, port],
		queryFn: () => client.getInfo(),
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

	if (error || !prd) {
		return (
			<div className="max-w-6xl mx-auto px-4 py-8">
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
					<h2 className="text-lg font-semibold text-red-700 dark:text-red-400 mb-2">
						Failed to load PRD
					</h2>
					<p className="text-red-600 dark:text-red-300 mb-4">{error?.message || "PRD not found"}</p>
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
				<PRDDetailPage
					prd={prd}
					daemonHost={host}
					daemonPort={portNum}
					daemonName={daemonInfo?.projectName || "Unknown"}
					onBack={handleBack}
				/>
			</div>
		</WebSocketProvider>
	);
}
