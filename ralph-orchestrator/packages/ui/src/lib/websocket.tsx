/**
 * WebSocket Provider and Hooks
 *
 * Manages WebSocket connections to daemons for real-time updates.
 */

import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	useCallback,
	type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * WebSocket events from daemon
 */
export type WebSocketEvent =
	| { type: "connected"; daemonId: string; projectName: string }
	| { type: "daemon:heartbeat"; timestamp: string }
	| { type: "prd:status"; prd: string; status: string; timestamp: string }
	| { type: "prd:log"; prd: string; line: string; timestamp: string }
	| { type: "prd:progress"; prd: string; story: string; iteration: number };

/**
 * WebSocket commands to daemon
 */
export type WebSocketCommand =
	| { type: "subscribe"; prds: string[] }
	| { type: "unsubscribe"; prds: string[] };

interface WebSocketContextValue {
	isConnected: boolean;
	subscribe: (prds: string[]) => void;
	unsubscribe: (prds: string[]) => void;
	addLogListener: (prd: string, callback: (line: string, timestamp: string) => void) => () => void;
	addStatusListener: (callback: (prd: string, status: string) => void) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

interface WebSocketProviderProps {
	host: string;
	port: number;
	children: ReactNode;
}

/**
 * WebSocket Provider Component
 *
 * Manages a single WebSocket connection per daemon with automatic reconnection.
 */
export function WebSocketProvider({ host, port, children }: WebSocketProviderProps) {
	const [isConnected, setIsConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectAttemptRef = useRef(0);
	const subscribedPrdsRef = useRef<Set<string>>(new Set());
	const logListenersRef = useRef<Map<string, Set<(line: string, timestamp: string) => void>>>(
		new Map(),
	);
	const statusListenersRef = useRef<Set<(prd: string, status: string) => void>>(new Set());
	const queryClient = useQueryClient();

	const connect = useCallback(() => {
		// Clean up existing connection
		if (wsRef.current) {
			wsRef.current.close();
		}

		const wsUrl = `ws://${host}:${port}`;
		const ws = new WebSocket(wsUrl);

		ws.onopen = () => {
			setIsConnected(true);
			reconnectAttemptRef.current = 0;

			// Re-subscribe to any PRDs we were tracking
			if (subscribedPrdsRef.current.size > 0) {
				const cmd: WebSocketCommand = {
					type: "subscribe",
					prds: Array.from(subscribedPrdsRef.current),
				};
				ws.send(JSON.stringify(cmd));
			}
		};

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as WebSocketEvent;

				switch (data.type) {
					case "prd:status":
						// Invalidate queries to refresh PRD data
						queryClient.invalidateQueries({ queryKey: ["daemons"] });
						// Notify status listeners
						for (const listener of statusListenersRef.current) {
							listener(data.prd, data.status);
						}
						break;

					case "prd:log": {
						// Notify log listeners for this PRD
						const listeners = logListenersRef.current.get(data.prd);
						if (listeners) {
							for (const listener of listeners) {
								listener(data.line, data.timestamp);
							}
						}
						break;
					}

					case "daemon:heartbeat":
						// Could update last seen timestamp
						break;
				}
			} catch {
				// Ignore invalid messages
			}
		};

		ws.onclose = () => {
			setIsConnected(false);
			wsRef.current = null;

			// Exponential backoff reconnection
			const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 30000);
			reconnectAttemptRef.current++;

			reconnectTimeoutRef.current = setTimeout(() => {
				connect();
			}, delay);
		};

		ws.onerror = () => {
			// onclose will be called after this
		};

		wsRef.current = ws;
	}, [host, port, queryClient]);

	// Connect on mount
	useEffect(() => {
		connect();

		return () => {
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
			if (wsRef.current) {
				wsRef.current.close();
			}
		};
	}, [connect]);

	const subscribe = useCallback((prds: string[]) => {
		for (const prd of prds) {
			subscribedPrdsRef.current.add(prd);
		}

		if (wsRef.current?.readyState === WebSocket.OPEN) {
			const cmd: WebSocketCommand = { type: "subscribe", prds };
			wsRef.current.send(JSON.stringify(cmd));
		}
	}, []);

	const unsubscribe = useCallback((prds: string[]) => {
		for (const prd of prds) {
			subscribedPrdsRef.current.delete(prd);
		}

		if (wsRef.current?.readyState === WebSocket.OPEN) {
			const cmd: WebSocketCommand = { type: "unsubscribe", prds };
			wsRef.current.send(JSON.stringify(cmd));
		}
	}, []);

	const addLogListener = useCallback(
		(prd: string, callback: (line: string, timestamp: string) => void) => {
			if (!logListenersRef.current.has(prd)) {
				logListenersRef.current.set(prd, new Set());
			}
			logListenersRef.current.get(prd)!.add(callback);

			// Return cleanup function
			return () => {
				const listeners = logListenersRef.current.get(prd);
				if (listeners) {
					listeners.delete(callback);
					if (listeners.size === 0) {
						logListenersRef.current.delete(prd);
					}
				}
			};
		},
		[],
	);

	const addStatusListener = useCallback((callback: (prd: string, status: string) => void) => {
		statusListenersRef.current.add(callback);
		return () => {
			statusListenersRef.current.delete(callback);
		};
	}, []);

	const value: WebSocketContextValue = {
		isConnected,
		subscribe,
		unsubscribe,
		addLogListener,
		addStatusListener,
	};

	return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}

/**
 * Hook to access WebSocket context
 */
export function useWebSocket(): WebSocketContextValue {
	const context = useContext(WebSocketContext);
	if (!context) {
		throw new Error("useWebSocket must be used within a WebSocketProvider");
	}
	return context;
}
