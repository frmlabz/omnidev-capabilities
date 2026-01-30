/**
 * Main App Component
 *
 * Dashboard showing all connected daemons and their PRDs.
 * For MVP, daemon URLs are configured via environment variable.
 */

import { useQuery } from "@tanstack/react-query";
import { DaemonCard } from "./components/DaemonCard";
import { PRDCard } from "./components/PRDCard";
import { fetchDaemonStatus, type DaemonWithStatus } from "./lib/daemon-client";
import type { DaemonRegistration } from "./lib/schemas";

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
			daemonName: d.info?.projectName || d.registration.projectName,
		})),
	);
	const runningPRDs = allPRDs.filter((p) => p.prd.isRunning);

	return (
		<div className="max-w-6xl mx-auto px-4 py-8">
			<header className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-bold text-gray-900">Ralph Orchestrator</h1>
				<button
					type="button"
					onClick={() => refetch()}
					disabled={isLoading}
					className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
				>
					{isLoading ? "Loading..." : "Refresh"}
				</button>
			</header>

			{error && (
				<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
					Error loading daemons: {error.message}
				</div>
			)}

			{daemons.length === 0 && !isLoading ? (
				<div className="text-center py-12">
					<p className="text-gray-500 text-lg">No daemons found</p>
					<p className="text-gray-400 mt-2">
						Start a daemon with <code className="bg-gray-100 px-2 py-1 rounded">ralph-daemon</code>{" "}
						in your project directory
					</p>
					<p className="text-gray-400 mt-4 text-sm">
						Configure daemon URLs via VITE_DAEMON_URLS environment variable
					</p>
				</div>
			) : (
				<>
					{/* Daemons Section */}
					<section className="mb-8">
						<h2 className="text-lg font-semibold text-gray-900 mb-4">
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
							<h2 className="text-lg font-semibold text-gray-900 mb-4">
								Running ({runningPRDs.length})
							</h2>
							<div className="grid gap-4 md:grid-cols-2">
								{runningPRDs.map(({ prd, daemonId, daemonName }) => (
									<PRDCard key={`${daemonId}-${prd.name}`} prd={prd} daemonName={daemonName} />
								))}
							</div>
						</section>
					)}

					{/* All PRDs Section */}
					<section>
						<h2 className="text-lg font-semibold text-gray-900 mb-4">
							All PRDs ({allPRDs.length})
						</h2>
						{allPRDs.length === 0 ? (
							<p className="text-gray-500">No PRDs found in connected daemons</p>
						) : (
							<div className="grid gap-4 md:grid-cols-2">
								{allPRDs.map(({ prd, daemonId, daemonName }) => (
									<PRDCard key={`${daemonId}-${prd.name}`} prd={prd} daemonName={daemonName} />
								))}
							</div>
						)}
					</section>
				</>
			)}
		</div>
	);
}
