import type { CapabilityExport } from "@omnidev-ai/core";

export default {
	docs: [
		{
			title: "Context7 Documentation Lookup",
			content: `# Context7 Documentation Lookup

This capability provides access to Context7 for querying up-to-date library documentation.
Context7 maintains documentation for thousands of popular libraries and frameworks.

## Available Functions

### resolveLibraryId(query, libraryName)
Find the Context7 library ID for a given package name.

**Parameters:**
- \`query\`: The user's question or task (used to rank results by relevance)
- \`libraryName\`: The name of the library to search for

**Returns:** Library ID string (e.g., "/vercel/next.js", "/mongodb/docs")

### queryDocs(libraryId, query)
Query documentation for a specific library.

**Parameters:**
- \`libraryId\`: Exact Context7-compatible library ID from resolveLibraryId
- \`query\`: The question or task to get relevant documentation for

**Returns:** Relevant documentation snippets and examples

## Example Usage

\`\`\`typescript
import { resolveLibraryId, queryDocs } from "context7";

// First, resolve the library name to a Context7 ID
const libId = await resolveLibraryId({
  query: "how to use React hooks",
  libraryName: "react"
});

// Then query the documentation
const docs = await queryDocs({
  libraryId: libId,
  query: "useState hook examples"
});

console.log(docs);
\`\`\`

## Supported Libraries

Context7 supports documentation for thousands of libraries including:
- React, Vue, Angular, Svelte
- Next.js, Nuxt, Remix
- Node.js, Deno, Bun
- MongoDB, PostgreSQL, Redis
- And many more...

Use \`resolveLibraryId\` to check if a library is available.
`,
		},
	],
} satisfies CapabilityExport;
