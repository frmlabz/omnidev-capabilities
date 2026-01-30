/**
 * Log Viewer Component
 *
 * Displays streaming logs with auto-scroll and manual scroll control.
 */

import { useEffect, useRef, useState, memo } from "react";
import type { LogEntry } from "../lib/schemas";

interface LogViewerProps {
	logs: LogEntry[];
	maxHeight?: string;
	onClear?: () => void;
}

/**
 * Memoized log line component for performance
 */
const LogLine = memo(function LogLine({ log }: { log: LogEntry }) {
	const time = new Date(log.timestamp).toLocaleTimeString();

	return (
		<div className="flex gap-2 hover:bg-gray-800/50">
			<span className="text-gray-500 flex-shrink-0 select-none">{time}</span>
			<span className="text-gray-100 whitespace-pre-wrap break-all">{log.line}</span>
		</div>
	);
});

/**
 * Log Viewer Component
 *
 * Features:
 * - Auto-scroll to bottom when new logs arrive
 * - Disable auto-scroll when user scrolls up manually
 * - "Jump to bottom" button when not auto-scrolling
 * - Monospace font with timestamp + line format
 */
export function LogViewer({ logs, maxHeight = "400px", onClear }: LogViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const [isAtBottom, setIsAtBottom] = useState(true);

	// Check if scrolled to bottom
	const checkIfAtBottom = () => {
		const container = containerRef.current;
		if (!container) return true;

		const threshold = 50; // pixels from bottom to consider "at bottom"
		const isBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
		return isBottom;
	};

	// Handle scroll events
	const handleScroll = () => {
		const atBottom = checkIfAtBottom();
		setIsAtBottom(atBottom);

		// Re-enable auto-scroll when user scrolls to bottom
		if (atBottom) {
			setAutoScroll(true);
		} else {
			// Disable auto-scroll when user scrolls up
			setAutoScroll(false);
		}
	};

	// Auto-scroll to bottom when new logs arrive
	// biome-ignore lint/correctness/useExhaustiveDependencies: logs.length is intentionally used as trigger
	useEffect(() => {
		if (autoScroll && containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [logs.length, autoScroll]);

	// Jump to bottom handler
	const jumpToBottom = () => {
		if (containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
			setAutoScroll(true);
			setIsAtBottom(true);
		}
	};

	return (
		<div className="relative">
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="bg-gray-900 rounded-lg p-4 font-mono text-sm overflow-auto"
				style={{ maxHeight }}
			>
				{logs.length === 0 ? (
					<div className="text-gray-500 italic">No logs yet...</div>
				) : (
					<div className="space-y-0.5">
						{logs.map((log, index) => (
							<LogLine key={`${log.timestamp}-${index}`} log={log} />
						))}
					</div>
				)}
			</div>

			{/* Jump to bottom button */}
			{!isAtBottom && logs.length > 0 && (
				<button
					type="button"
					onClick={jumpToBottom}
					className="absolute bottom-4 right-4 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-full shadow-lg hover:bg-blue-700 transition-colors"
				>
					↓ Jump to bottom
				</button>
			)}

			{/* Controls */}
			{onClear && logs.length > 0 && (
				<div className="absolute top-2 right-2">
					<button
						type="button"
						onClick={onClear}
						className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
					>
						Clear
					</button>
				</div>
			)}
		</div>
	);
}
