/**
 * Connection Status Indicator
 *
 * Shows WebSocket connection state with visual feedback.
 */

import { useWebSocket } from "../lib/websocket";

export function ConnectionStatus() {
	const { isConnected } = useWebSocket();

	return (
		<div className="flex items-center gap-2 text-sm">
			<span
				className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500 animate-pulse"}`}
			/>
			<span
				className={
					isConnected ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
				}
			>
				{isConnected ? "Connected" : "Reconnecting..."}
			</span>
		</div>
	);
}
