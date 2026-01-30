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
import type { CommandStatus } from "./schemas";

/**
 * WebSocket events from daemon
 */
export type WebSocketEvent =
	| { type: "connected"; daemonId: string; projectName: string }
	| { type: "daemon:heartbeat"; timestamp: string }
	| { type: "prd:status"; prd: string; status: string; timestamp: string }
	| { type: "prd:log"; prd: string; line: string; timestamp: string }
	| { type: "prd:progress"; prd: string; story: string; iteration: number }
	| {
			type: "worktree:command:start";
			worktree: string;
			commandId: string;
			commandKey: string;
			timestamp: string;
	  }
	| {
			type: "worktree:command:log";
			worktree: string;
			commandId: string;
			line: string;
			timestamp: string;
	  }
	| {
			type: "worktree:command:end";
			worktree: string;
			commandId: string;
			status: CommandStatus;
			exitCode: number;
			timestamp: string;
	  };

/**
 * WebSocket commands to daemon
 */
export type WebSocketCommand =
	| { type: "subscribe"; prds: string[] }
	| { type: "unsubscribe"; prds: string[] }
	| { type: "subscribe:worktree"; worktrees: string[] }
	| { type: "unsubscribe:worktree"; worktrees: string[] };

type SubscriptionType = "prd" | "worktree";

interface WebSocketContextValue {
	isConnected: boolean;
	subscribe: (items: string[], type?: SubscriptionType) => void;
	unsubscribe: (items: string[], type?: SubscriptionType) => void;
	addLogListener: (prd: string, callback: (line: string, timestamp: string) => void) => () => void;
	addStatusListener: (callback: (prd: string, status: string) => void) => () => void;
	addCommandLogListener: (
		callback: (worktree: string, commandId: string, line: string, timestamp: string) => void,
	) => () => void;
	addCommandEndListener: (
		callback: (
			worktree: string,
			commandId: string,
			status: CommandStatus,
			exitCode: number,
		) => void,
	) => () => void;
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
	const subscribedWorktreesRef = useRef<Set<string>>(new Set());
	const logListenersRef = useRef<Map<string, Set<(line: string, timestamp: string) => void>>>(
		new Map(),
	);
	const statusListenersRef = useRef<Set<(prd: string, status: string) => void>>(new Set());
	const commandLogListenersRef = useRef<
		Set<(worktree: string, commandId: string, line: string, timestamp: string) => void>
	>(new Set());
	const commandEndListenersRef = useRef<
		Set<(worktree: string, commandId: string, status: CommandStatus, exitCode: number) => void>
	>(new Set());
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

			// Re-subscribe to any worktrees we were tracking
			if (subscribedWorktreesRef.current.size > 0) {
				const cmd: WebSocketCommand = {
					type: "subscribe:worktree",
					worktrees: Array.from(subscribedWorktreesRef.current),
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
						// Also invalidate the specific PRD query (for detail page)
						queryClient.invalidateQueries({
							queryKey: ["prd"],
							predicate: (query) => {
								const key = query.queryKey;
								return Array.isArray(key) && key[0] === "prd" && key[3] === data.prd;
							},
						});
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

					case "worktree:command:log":
						// Notify command log listeners
						for (const listener of commandLogListenersRef.current) {
							listener(data.worktree, data.commandId, data.line, data.timestamp);
						}
						break;

					case "worktree:command:end":
						// Notify command end listeners
						for (const listener of commandEndListenersRef.current) {
							listener(data.worktree, data.commandId, data.status, data.exitCode);
						}
						// Invalidate worktrees query
						queryClient.invalidateQueries({ queryKey: ["worktrees"] });
						break;

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

	const subscribe = useCallback((items: string[], type: SubscriptionType = "prd") => {
		if (type === "prd") {
			for (const item of items) {
				subscribedPrdsRef.current.add(item);
			}

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				const cmd: WebSocketCommand = { type: "subscribe", prds: items };
				wsRef.current.send(JSON.stringify(cmd));
			}
		} else {
			for (const item of items) {
				subscribedWorktreesRef.current.add(item);
			}

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				const cmd: WebSocketCommand = { type: "subscribe:worktree", worktrees: items };
				wsRef.current.send(JSON.stringify(cmd));
			}
		}
	}, []);

	const unsubscribe = useCallback((items: string[], type: SubscriptionType = "prd") => {
		if (type === "prd") {
			for (const item of items) {
				subscribedPrdsRef.current.delete(item);
			}

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				const cmd: WebSocketCommand = { type: "unsubscribe", prds: items };
				wsRef.current.send(JSON.stringify(cmd));
			}
		} else {
			for (const item of items) {
				subscribedWorktreesRef.current.delete(item);
			}

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				const cmd: WebSocketCommand = { type: "unsubscribe:worktree", worktrees: items };
				wsRef.current.send(JSON.stringify(cmd));
			}
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

	const addCommandLogListener = useCallback(
		(callback: (worktree: string, commandId: string, line: string, timestamp: string) => void) => {
			commandLogListenersRef.current.add(callback);
			return () => {
				commandLogListenersRef.current.delete(callback);
			};
		},
		[],
	);

	const addCommandEndListener = useCallback(
		(
			callback: (
				worktree: string,
				commandId: string,
				status: CommandStatus,
				exitCode: number,
			) => void,
		) => {
			commandEndListenersRef.current.add(callback);
			return () => {
				commandEndListenersRef.current.delete(callback);
			};
		},
		[],
	);

	const value: WebSocketContextValue = {
		isConnected,
		subscribe,
		unsubscribe,
		addLogListener,
		addStatusListener,
		addCommandLogListener,
		addCommandEndListener,
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
