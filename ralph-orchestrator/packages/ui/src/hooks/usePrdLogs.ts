/**
 * Hook for PRD Log Streaming
 *
 * Subscribes to PRD logs via WebSocket and maintains a log buffer.
 */

import { useState, useEffect, useCallback } from "react";
import { useWebSocket } from "../lib/websocket";
import type { LogEntry } from "../lib/schemas";

interface UsePrdLogsOptions {
	prdName: string;
	initialLogs?: LogEntry[];
	maxLogs?: number;
}

interface UsePrdLogsResult {
	logs: LogEntry[];
	clearLogs: () => void;
}

/**
 * Hook for streaming PRD logs via WebSocket
 *
 * @param options.prdName - Name of the PRD to subscribe to
 * @param options.initialLogs - Initial logs to display (from REST API)
 * @param options.maxLogs - Maximum number of logs to keep in buffer (default: 1000)
 */
export function usePrdLogs({
	prdName,
	initialLogs = [],
	maxLogs = 1000,
}: UsePrdLogsOptions): UsePrdLogsResult {
	const [logs, setLogs] = useState<LogEntry[]>(initialLogs);
	const { subscribe, unsubscribe, addLogListener } = useWebSocket();

	// Subscribe to PRD on mount
	useEffect(() => {
		subscribe([prdName]);

		return () => {
			unsubscribe([prdName]);
		};
	}, [prdName, subscribe, unsubscribe]);

	// Listen for log events
	useEffect(() => {
		const removeListener = addLogListener(prdName, (line: string, timestamp: string) => {
			setLogs((prev) => {
				const newLog: LogEntry = { timestamp, line };
				const updated = [...prev, newLog];

				// Trim to maxLogs
				if (updated.length > maxLogs) {
					return updated.slice(-maxLogs);
				}
				return updated;
			});
		});

		return removeListener;
	}, [prdName, addLogListener, maxLogs]);

	// Update logs when initialLogs changes
	useEffect(() => {
		if (initialLogs.length > 0) {
			setLogs(initialLogs);
		}
	}, [initialLogs]);

	const clearLogs = useCallback(() => {
		setLogs([]);
	}, []);

	return { logs, clearLogs };
}
