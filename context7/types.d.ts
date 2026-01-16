/**
 * Context7 Documentation Lookup Types
 *
 * These types define the interfaces for Context7 MCP tools.
 */

/**
 * Arguments for resolving a library ID
 */
export interface ResolveLibraryIdArgs {
	/** The user's question or task (used to rank results by relevance) */
	query: string;
	/** The name of the library to search for */
	libraryName: string;
}

/**
 * Arguments for querying documentation
 */
export interface QueryDocsArgs {
	/** Exact Context7-compatible library ID (e.g., /mongodb/docs, /vercel/next.js) */
	libraryId: string;
	/** The question or task to get relevant documentation for */
	query: string;
}

/**
 * Resolve a library name into a Context7-compatible library ID.
 * Call this before query-docs to obtain a valid library ID.
 */
export function resolveLibraryId(args: ResolveLibraryIdArgs): Promise<unknown>;

/**
 * Query documentation for a library using a Context7-compatible library ID.
 * Use the library ID returned from resolveLibraryId.
 */
export function queryDocs(args: QueryDocsArgs): Promise<unknown>;
