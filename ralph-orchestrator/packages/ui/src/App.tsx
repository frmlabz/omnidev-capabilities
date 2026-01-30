/**
 * Main App Component
 *
 * Dashboard showing all connected daemons and their PRDs.
 * For MVP, daemon URLs are configured via environment variable.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DaemonCard } from "./components/DaemonCard";
import { PRDCard } from "./components/PRDCard";
import { PRDDetailPage } from "./components/PRDDetailPage";
import { DaemonGridSkeleton, PRDGridSkeleton } from "./components/LoadingSkeleton";
import { ThemeToggle } from "./components/ThemeToggle";
import { fetchDaemonStatus, type DaemonWithStatus } from "./lib/daemon-client";
import { WebSocketProvider } from "./lib/websocket";
import type { DaemonRegistration, PRDSummary } from "./lib/schemas";

/**
 * Selected PRD state for navigation
 */
interface SelectedPRD {
	prd: PRDSummary;
	daemonHost: string;
	daemonPort: number;
	daemonName: string;
}

/**
 * Parse daemon URLs from environment or use defaults
 * Format: host:port,host:port,...
 */
function parseDaemonUrls(): DaemonRegistration[] {
	// Default to localhost:12345 for development
	// In production, set VITE_DAEMON_URLS env var
	const urlsStr = import.meta.env.VITE_DAEMON_URLS || "127.0.0.1:12345";

	return urlsStr.split(",").map((url: string, index: number) => {
		const [host, portStr] = url.trim().split(":");
		const port = Number.parseInt(portStr || "12345", 10);

		// Create a mock registration for direct URL connections
		return {
			schemaVersion: 1 as const,
			id: `manual-${index}`,
			projectPath: "unknown",
			projectName: `Daemon ${index + 1}`,
			host: host || "127.0.0.1",
			port,
			pid: 0,
			startedAt: new Date().toISOString(),
			lastHeartbeat: new Date().toISOString(),
		};
	});
}

async function fetchAllDaemons(): Promise<DaemonWithStatus[]> {
	const registrations = parseDaemonUrls();
	const results = await Promise.all(registrations.map(fetchDaemonStatus));
	return results;
}

export function App() {
	const [selectedPrd, setSelectedPrd] = useState<SelectedPRD | null>(null);

	const {
		data: daemons = [],
		isLoading,
		error,
		refetch,
	} = useQuery({
		queryKey: ["daemons"],
		queryFn: fetchAllDaemons,
	});

	const healthyDaemons = daemons.filter((d) => d.healthy);
	const allPRDs = healthyDaemons.flatMap((d) =>
		d.prds.map((prd) => ({
			prd,
			daemonId: d.registration.id,
			daemonHost: d.registration.host,
			daemonPort: d.registration.port,
			daemonName: d.info?.projectName || d.registration.projectName,
		})),
	);
	const runningPRDs = allPRDs.filter((p) => p.prd.isRunning);

	// Handle PRD selection for navigation
	const handlePrdClick = (prdData: {
		prd: PRDSummary;
		daemonHost: string;
		daemonPort: number;
		daemonName: string;
	}) => {
		setSelectedPrd(prdData);
	};

	// Handle back navigation
	const handleBack = () => {
		setSelectedPrd(null);
		// Refresh data when returning to dashboard
		refetch();
	};

	// Detail page view
	if (selectedPrd) {
		return (
			<WebSocketProvider host={selectedPrd.daemonHost} port={selectedPrd.daemonPort}>
				<div className="max-w-6xl mx-auto px-4 py-8">
					<PRDDetailPage
						prd={selectedPrd.prd}
						daemonHost={selectedPrd.daemonHost}
						daemonPort={selectedPrd.daemonPort}
						daemonName={selectedPrd.daemonName}
						onBack={handleBack}
					/>
				</div>
			</WebSocketProvider>
		);
	}

	return (
		<div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
			<header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 sm:mb-8">
				<h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100">
					Ralph Orchestrator
				</h1>
				<div className="flex items-center gap-2">
					<ThemeToggle />
					<button
						type="button"
						onClick={() => refetch()}
						disabled={isLoading}
						className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600 dark:hover:bg-gray-700"
					>
						{isLoading ? "Loading..." : "Refresh"}
					</button>
				</div>
			</header>

			{error && (
				<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg dark:bg-red-900/20 dark:border-red-800">
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
						<div className="text-red-700 text-sm sm:text-base dark:text-red-400">
							<strong>Error loading daemons:</strong> {error.message}
						</div>
						<button
							type="button"
							onClick={() => refetch()}
							className="px-3 py-2 text-sm font-medium text-red-700 bg-red-100 rounded hover:bg-red-200 transition-colors w-full sm:w-auto dark:text-red-300 dark:bg-red-900/50 dark:hover:bg-red-900"
						>
							Retry
						</button>
					</div>
				</div>
			)}

			{isLoading ? (
				<>
					<section className="mb-8">
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Daemons</h2>
						<DaemonGridSkeleton count={2} />
					</section>
					<section>
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">PRDs</h2>
						<PRDGridSkeleton count={4} />
					</section>
				</>
			) : daemons.length === 0 ? (
				<div className="text-center py-12">
					<p className="text-gray-500 dark:text-gray-400 text-lg">No daemons found</p>
					<p className="text-gray-400 dark:text-gray-500 mt-2">
						Start a daemon with{" "}
						<code className="bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">ralph-daemon</code> in
						your project directory
					</p>
					<p className="text-gray-400 dark:text-gray-500 mt-4 text-sm">
						Configure daemon URLs via VITE_DAEMON_URLS environment variable
					</p>
				</div>
			) : (
				<>
					{/* Daemons Section */}
					<section className="mb-8">
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
							Daemons ({healthyDaemons.length}/{daemons.length} online)
						</h2>
						<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							{daemons.map((daemon) => (
								<DaemonCard key={daemon.registration.id} daemon={daemon} />
							))}
						</div>
					</section>

					{/* Running PRDs Section */}
					{runningPRDs.length > 0 && (
						<section className="mb-8">
							<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
								Running ({runningPRDs.length})
							</h2>
							<div className="grid gap-4 md:grid-cols-2">
								{runningPRDs.map(({ prd, daemonId, daemonHost, daemonPort, daemonName }) => (
									<PRDCard
										key={`${daemonId}-${prd.name}`}
										prd={prd}
										daemonName={daemonName}
										daemonHost={daemonHost}
										daemonPort={daemonPort}
										onClick={() => handlePrdClick({ prd, daemonHost, daemonPort, daemonName })}
									/>
								))}
							</div>
						</section>
					)}

					{/* All PRDs Section */}
					<section>
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
							All PRDs ({allPRDs.length})
						</h2>
						{allPRDs.length === 0 ? (
							<p className="text-gray-500 dark:text-gray-400">No PRDs found in connected daemons</p>
						) : (
							<div className="grid gap-4 md:grid-cols-2">
								{allPRDs.map(({ prd, daemonId, daemonHost, daemonPort, daemonName }) => (
									<PRDCard
										key={`${daemonId}-${prd.name}`}
										prd={prd}
										daemonName={daemonName}
										daemonHost={daemonHost}
										daemonPort={daemonPort}
										onClick={() => handlePrdClick({ prd, daemonHost, daemonPort, daemonName })}
									/>
								))}
							</div>
						)}
					</section>
				</>
			)}
		</div>
	);
}
