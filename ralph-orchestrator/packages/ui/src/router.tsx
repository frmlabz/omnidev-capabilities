/**
 * Router Configuration
 *
 * TanStack Router setup for URL-based navigation.
 */

import { createRouter, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { App } from "./App";
import { PRDPage } from "./pages/PRDPage";
import { WorktreePage } from "./pages/WorktreePage";

// Root layout
const rootRoute = createRootRoute({
	component: () => <Outlet />,
});

// Dashboard route
const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: App,
});

// PRD detail route
const prdRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/prd/$host/$port/$name",
	component: PRDPage,
});

// Worktree detail route
const worktreeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/worktree/$host/$port/$name",
	component: WorktreePage,
});

// Create route tree
const routeTree = rootRoute.addChildren([indexRoute, prdRoute, worktreeRoute]);

// Create router
export const router = createRouter({ routeTree });

// Type declarations for router
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
