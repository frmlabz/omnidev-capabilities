---
name: extract-findings
description: "Extract patterns discovered and findings from completed PRDs. Use when you want to gather learnings, aggregate patterns, or process completed PRDs. Triggers on: extract findings, gather patterns, process completed prds, aggregate learnings."
---

# Findings Extractor

Extract and aggregate patterns discovered from completed PRD progress logs.

## The Job

When a user requests finding extraction:

### 1. Locate Completed PRDs

Find all PRDs that:
- Have `completedAt` set in prd.json
- Have a progress.txt file with content
- Haven't been archived yet (optional filter)

Look in: `.omni/state/ralph/prds/`

### 2. Extract Patterns from Each PRD

For each completed PRD, read the progress.txt file and extract:

**Patterns Discovered Section:**
- Usually appears at the end of progress.txt
- Marked by headings like "Patterns discovered:", "## Patterns", "Key learnings:", etc.
- Contains bullet points or numbered lists of patterns
- May include code patterns, architectural decisions, database patterns, API patterns, etc.

**Example patterns in progress.txt:**
```
Patterns discovered:
- Active session check requires two queries: first check for active session, then optionally join to get customer name
- Session is "active" when: `packingDate = today AND endedAt IS NULL`
- Customer info retrieved via: `packingSessionDeliveries` → `deliveries` → `plans` → `customerProfiles`
- Return null values when no active session exists (not 404)
```

### 3. Create Aggregated Findings File

Create or append to: `.omni/state/ralph/FINDINGS.md`

Structure:
```markdown
# Ralph Findings & Patterns

Last updated: [ISO timestamp]

---

## [PRD Name] - [Date]

**Description:** [PRD description]

**Patterns Discovered:**
- Pattern 1
- Pattern 2
- Pattern 3

**Stories Completed:** [count]
**Duration:** [if available]

---

## [Next PRD Name] - [Date]

...
```

### 4. Mark PRD as Archived (Optional)

After extracting findings:

**Option A: Add archived flag to prd.json**
```json
{
  "name": "feature-name",
  "completedAt": "2026-01-20T15:30:00Z",
  "archivedAt": "2026-01-25T10:00:00Z",
  ...
}
```

**Option B: Move to archived subdirectory**
```
.omni/state/ralph/prds/archived/[prd-name]/
```

Ask the user which approach they prefer.

### 5. Summary Report

After processing, show:
```
Findings Extraction Complete

Processed PRDs: 3
- feature-auth-system
- api-optimization
- user-dashboard

Patterns extracted: 15
Findings saved to: .omni/state/ralph/FINDINGS.md

Archives:
- 3 PRDs marked as archived
```

## Filtering Options

Support these filters:
- `--all`: Process all completed PRDs (default)
- `--unarchived`: Only process PRDs not yet archived
- `--prd <name>`: Process a specific PRD
- `--since <date>`: Only PRDs completed after this date

## Best Practices

### Pattern Recognition

Look for these common pattern types in progress.txt:

1. **Database Patterns:**
   - Query structures
   - Join patterns
   - Table relationships
   - Indexing decisions

2. **API Patterns:**
   - Endpoint structures
   - Response formats
   - Error handling approaches
   - Authentication flows

3. **Code Patterns:**
   - File organization
   - Naming conventions
   - Common utilities
   - Testing approaches

4. **Business Logic Patterns:**
   - Validation rules
   - State transitions
   - Edge case handling
   - Domain concepts

### Cleaning Up Findings

When extracting patterns:
- Remove redundant patterns across PRDs
- Group similar patterns together
- Keep patterns specific and actionable
- Include code examples when available in progress.txt

### Deduplication

If a pattern appears in multiple PRDs:
```markdown
## Common Patterns Across Multiple PRDs

**Database Query Pattern** (seen in: auth-system, user-profile, api-v2)
- Always use prepared statements
- Index foreign keys
- Return null instead of 404 for optional queries
```

## Example Usage

**Extract from all unarchived PRDs:**
```
User: "Extract findings from completed PRDs"
→ Process all PRDs with completedAt && !archivedAt
→ Create FINDINGS.md with all patterns
→ Mark PRDs as archived
```

**Extract from specific PRD:**
```
User: "Extract findings from auth-system PRD"
→ Process only auth-system
→ Append to FINDINGS.md
→ Mark auth-system as archived
```

**Review findings without archiving:**
```
User: "Show me patterns from completed PRDs but don't archive them yet"
→ Extract patterns
→ Show in FINDINGS.md
→ Don't set archivedAt flag
```

## Quality Checks

Before finalizing:

- [ ] All completed PRDs have been scanned
- [ ] Patterns are clearly extracted and formatted
- [ ] FINDINGS.md is properly structured
- [ ] Archive flags/moves are correct
- [ ] Summary report is accurate

## Integration with Ralph CLI

This skill should be callable via:
```bash
omnidev ralph extract-findings [options]
```

Options:
- `--all`: Process all completed PRDs
- `--unarchived`: Only unarchived PRDs (default)
- `--prd <name>`: Specific PRD
- `--no-archive`: Don't mark as archived after extraction

## After Extraction

Tell the user:
```
Findings extracted and saved to .omni/state/ralph/FINDINGS.md

[X] PRDs processed
[Y] patterns discovered
[Z] PRDs archived

To review findings:
  cat .omni/state/ralph/FINDINGS.md

To continue with next PRD:
  omnidev ralph list
```
