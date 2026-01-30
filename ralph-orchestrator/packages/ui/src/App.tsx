/**
 * Main App Component
 *
 * Dashboard showing all connected daemons, worktrees, and PRDs.
 * Daemons are automatically discovered from the local registry.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { DaemonCard } from "./components/DaemonCard";
import { PRDCard } from "./components/PRDCard";
import { WorktreeCard } from "./components/WorktreeCard";
import { DaemonGridSkeleton, PRDGridSkeleton } from "./components/LoadingSkeleton";
import { ThemeToggle } from "./components/ThemeToggle";
import { createDaemonClient, fetchDaemonStatus, type DaemonWithStatus } from "./lib/daemon-client";
import type { DaemonRegistration, PRDSummary, WorktreeSummary } from "./lib/schemas";

/**
 * Discover daemons from the server's registry
 */
async function discoverDaemons(): Promise<DaemonRegistration[]> {
	try {
		const response = await fetch("/api/discover");
		const data = await response.json();

		if (data.ok && Array.isArray(data.daemons)) {
			return data.daemons;
		}

		return [];
	} catch {
		// Fallback to env var if discovery fails
		return parseDaemonUrlsFallback();
	}
}

/**
 * Fallback: Parse daemon URLs from environment
 * Format: host:port,host:port,...
 */
function parseDaemonUrlsFallback(): DaemonRegistration[] {
	const urlsStr = import.meta.env.VITE_DAEMON_URLS;
	if (!urlsStr) return [];

	return urlsStr.split(",").map((url: string, index: number) => {
		const [host, portStr] = url.trim().split(":");
		const port = Number.parseInt(portStr || "12345", 10);

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

interface DaemonData {
	daemon: DaemonWithStatus;
	worktrees: WorktreeSummary[];
}

async function fetchAllDaemonData(): Promise<DaemonData[]> {
	const registrations = await discoverDaemons();
	const results = await Promise.all(
		registrations.map(async (reg) => {
			const daemon = await fetchDaemonStatus(reg);

			// Fetch worktrees if daemon is healthy
			let worktrees: WorktreeSummary[] = [];
			if (daemon.healthy) {
				try {
					const client = createDaemonClient(reg.host, reg.port);
					worktrees = await client.getWorktrees();
				} catch {
					// Ignore errors fetching worktrees
				}
			}

			return { daemon, worktrees };
		}),
	);
	return results;
}

export function App() {
	const navigate = useNavigate();

	const {
		data: daemonData = [],
		isLoading,
		error,
		refetch,
	} = useQuery({
		queryKey: ["daemons"],
		queryFn: fetchAllDaemonData,
	});

	const daemons = daemonData.map((d) => d.daemon);
	const healthyDaemons = daemons.filter((d) => d.healthy);

	const allWorktrees = daemonData
		.filter((d) => d.daemon.healthy)
		.flatMap((d) =>
			d.worktrees.map((wt) => ({
				worktree: wt,
				daemonHost: d.daemon.registration.host,
				daemonPort: d.daemon.registration.port,
			})),
		);

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

	// Handle PRD selection - navigate to PRD route
	const handlePrdClick = (prdData: { prd: PRDSummary; daemonHost: string; daemonPort: number }) => {
		navigate({
			to: "/prd/$host/$port/$name",
			params: {
				host: prdData.daemonHost,
				port: String(prdData.daemonPort),
				name: prdData.prd.name,
			},
		});
	};

	// Handle worktree selection - navigate to worktree route
	const handleWorktreeClick = (wtData: {
		worktree: WorktreeSummary;
		daemonHost: string;
		daemonPort: number;
	}) => {
		navigate({
			to: "/worktree/$host/$port/$name",
			params: {
				host: wtData.daemonHost,
				port: String(wtData.daemonPort),
				name: wtData.worktree.name,
			},
		});
	};

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
								<DaemonCard
									key={daemon.registration.id}
									daemon={daemon}
									onKill={() => setTimeout(refetch, 500)}
								/>
							))}
						</div>
					</section>

					{/* Worktrees Section */}
					{allWorktrees.length > 0 && (
						<section className="mb-8">
							<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
								Worktrees ({allWorktrees.length})
							</h2>
							<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
								{allWorktrees.map(({ worktree, daemonHost, daemonPort }) => (
									<WorktreeCard
										key={`${daemonHost}:${daemonPort}-${worktree.name}`}
										worktree={worktree}
										onClick={() => handleWorktreeClick({ worktree, daemonHost, daemonPort })}
									/>
								))}
							</div>
						</section>
					)}

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
										onClick={() => handlePrdClick({ prd, daemonHost, daemonPort })}
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
										onClick={() => handlePrdClick({ prd, daemonHost, daemonPort })}
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
