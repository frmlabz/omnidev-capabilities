#!/usr/bin/env bash
# Setup script to create a minimal test repo for ralph-orchestrator testing
# Usage: ./setup-test-repo.sh /path/to/destination

set -e

DEST="${1:-/tmp/ralph-test}"

echo "Creating test repo at: $DEST"

# Clean up if exists
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

# Initialize bare repo
git init --bare .

# Create a temporary directory to build the initial content
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"
git init

# Create directory structure
mkdir -p scripts/ralph scripts/worktree
mkdir -p .omni/state/ralph/prds/{pending,completed,testing}
mkdir -p src

# Create simple source files
cat > src/app.txt << 'EOF'
This is a simple test application.
It doesn't do anything - it's just for testing ralph-orchestrator.
EOF

cat > src/config.txt << 'EOF'
# Configuration
debug = true
version = 1.0
EOF

cat > README.md << 'EOF'
# Test Project

A minimal test project for ralph-orchestrator development.

## Structure

- `src/` - Source files (just text files for testing)
- `scripts/ralph/` - Ralph lifecycle scripts
- `scripts/worktree/` - Worktree setup scripts
- `.omni/` - Omni configuration and state
EOF

# Create omni.toml
cat > omni.toml << 'EOF'
[ralph]
default_agent = "claude"
default_iterations = 3

[ralph.testing]
project_verification_instructions = "cat src/*.txt"
test_iterations = 2
web_testing_enabled = false

[ralph.scripts]
setup = "./scripts/ralph/setup.sh"
start = "./scripts/ralph/start.sh"
health_check = "./scripts/ralph/health-check.sh"
teardown = "./scripts/ralph/teardown.sh"

[ralph.agents.claude]
command = "claude"
args = ["--model", "sonnet", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "-p"]

[ralph.agents.echo]
command = "bash"
args = ["-c", "echo 'Agent completed task'; sleep 2; echo 'Done'"]
EOF

# Create .wt.toml for worktree tool
cat > .wt.toml << 'EOF'
[worktree]
primary = "main"

[[worktree.commands]]
trigger = "post-create"
name = "setup"
command = "bash scripts/worktree/setup.sh '{{ branch }}' '{{ primary_worktree_path }}'"

[[worktree.commands]]
trigger = "post-create"
name = "direnv"
command = "cd {{ worktree_path }} && direnv allow || true"

[[worktree.commands]]
trigger = "post-delete"
name = "cleanup"
command = "bash scripts/worktree/cleanup.sh '{{ branch }}'"
EOF

# Create ralph scripts
cat > scripts/ralph/setup.sh << 'EOFSCRIPT'
#!/usr/bin/env bash
echo "[ralph/setup] Setting up test environment..."
echo "[ralph/setup] Done."
EOFSCRIPT

cat > scripts/ralph/start.sh << 'EOFSCRIPT'
#!/usr/bin/env bash
echo "[ralph/start] Starting test services..."
echo "[ralph/start] Services ready."
EOFSCRIPT

cat > scripts/ralph/health-check.sh << 'EOFSCRIPT'
#!/usr/bin/env bash
echo "[ralph/health-check] Checking health..."
echo "[ralph/health-check] All systems operational."
exit 0
EOFSCRIPT

cat > scripts/ralph/teardown.sh << 'EOFSCRIPT'
#!/usr/bin/env bash
echo "[ralph/teardown] Stopping services..."
echo "[ralph/teardown] Cleanup complete."
EOFSCRIPT

chmod +x scripts/ralph/*.sh

# Create worktree scripts
cat > scripts/worktree/setup.sh << 'EOFSCRIPT'
#!/usr/bin/env bash
BRANCH="$1"
PRIMARY_PATH="$2"
echo "[worktree/setup] Setting up worktree for branch: $BRANCH"
echo "[worktree/setup] Primary path: $PRIMARY_PATH"
echo "[worktree/setup] Done."
EOFSCRIPT

cat > scripts/worktree/cleanup.sh << 'EOFSCRIPT'
#!/usr/bin/env bash
BRANCH="$1"
echo "[worktree/cleanup] Cleaning up branch: $BRANCH"
echo "[worktree/cleanup] Done."
EOFSCRIPT

chmod +x scripts/worktree/*.sh

# Create .omni state files
cat > .omni/state/ralph/config.toml << 'EOF'
[testing]
project_verification_instructions = "cat src/*.txt"
test_iterations = 2
EOF

echo "" > .omni/state/ralph/findings.md

# Create PRD 1: write-files (directory format)
mkdir -p .omni/state/ralph/prds/pending/write-files
cat > .omni/state/ralph/prds/pending/write-files/prd.json << 'EOF'
{
  "name": "write-files",
  "description": "A simple PRD that writes content to files",
  "createdAt": "2026-01-30T12:00:00Z",
  "stories": [
    {
      "id": "US-001",
      "title": "Create greeting file",
      "acceptanceCriteria": [
        "File exists at src/greeting.txt",
        "Contains exactly 'Hello, World!'"
      ],
      "status": "pending",
      "priority": 1,
      "questions": []
    },
    {
      "id": "US-002",
      "title": "Create timestamp file",
      "acceptanceCriteria": [
        "File exists at src/timestamp.txt",
        "Contains a date string in ISO format"
      ],
      "status": "pending",
      "priority": 2,
      "questions": []
    },
    {
      "id": "US-003",
      "title": "Create summary file",
      "acceptanceCriteria": [
        "File exists at src/summary.txt",
        "Lists all .txt files in src/ directory"
      ],
      "status": "pending",
      "priority": 3,
      "questions": []
    }
  ]
}
EOF
cat > .omni/state/ralph/prds/pending/write-files/spec.md << 'EOF'
# Write Files PRD

## Description
A simple PRD that writes content to files.

## Stories

### US-001 - Create greeting file
Create a file called `src/greeting.txt` with the content "Hello, World!"

### US-002 - Create timestamp file
Create a file called `src/timestamp.txt` with the current date.

### US-003 - Create summary file
Create a file called `src/summary.txt` that lists all txt files in src/.
EOF

# Create PRD 2: modify-config (directory format)
mkdir -p .omni/state/ralph/prds/pending/modify-config
cat > .omni/state/ralph/prds/pending/modify-config/prd.json << 'EOF'
{
  "name": "modify-config",
  "description": "A simple PRD that modifies configuration files",
  "createdAt": "2026-01-30T12:00:00Z",
  "stories": [
    {
      "id": "US-001",
      "title": "Add new config option",
      "acceptanceCriteria": [
        "src/config.txt contains 'feature_flag = true'"
      ],
      "status": "pending",
      "priority": 1,
      "questions": []
    },
    {
      "id": "US-002",
      "title": "Update version number",
      "acceptanceCriteria": [
        "src/config.txt shows 'version = 2.0' instead of 'version = 1.0'"
      ],
      "status": "pending",
      "priority": 2,
      "questions": []
    }
  ]
}
EOF
cat > .omni/state/ralph/prds/pending/modify-config/spec.md << 'EOF'
# Modify Config PRD

## Description
A simple PRD that modifies configuration files.

## Stories

### US-001 - Add new config option
Add a line `feature_flag = true` to `src/config.txt`.

### US-002 - Update version
Change `version = 1.0` to `version = 2.0` in `src/config.txt`.
EOF

# Create PRD 3: create-structure (directory format)
mkdir -p .omni/state/ralph/prds/pending/create-structure
cat > .omni/state/ralph/prds/pending/create-structure/prd.json << 'EOF'
{
  "name": "create-structure",
  "description": "A simple PRD that creates a directory structure",
  "createdAt": "2026-01-30T12:00:00Z",
  "stories": [
    {
      "id": "US-001",
      "title": "Create docs directory",
      "acceptanceCriteria": [
        "docs/ directory exists",
        "docs/README.md exists with some content"
      ],
      "status": "pending",
      "priority": 1,
      "questions": []
    },
    {
      "id": "US-002",
      "title": "Create tests directory",
      "acceptanceCriteria": [
        "tests/ directory exists",
        "tests/test_sample.txt exists"
      ],
      "status": "pending",
      "priority": 2,
      "questions": []
    }
  ]
}
EOF
cat > .omni/state/ralph/prds/pending/create-structure/spec.md << 'EOF'
# Create Structure PRD

## Description
A simple PRD that creates a directory structure.

## Stories

### US-001 - Create docs directory
Create a `docs/` directory with a `README.md` file.

### US-002 - Create tests directory
Create a `tests/` directory with a `test_sample.txt` file.
EOF

# Create .gitignore
cat > .gitignore << 'EOF'
node_modules/
.env
.env.*
*.log
.DS_Store
EOF

# Commit and push to bare repo
git add -A
git commit -m "Initial commit: minimal test project for ralph-orchestrator"
git remote add origin "$DEST"
git push origin main

# Clean up temp directory
cd "$DEST"
rm -rf "$TEMP_DIR"

# Create main worktree
git worktree add main main

echo ""
echo "Test repo created successfully at: $DEST"
echo ""
echo "Structure:"
echo "  $DEST/          (bare repo)"
echo "  $DEST/main/     (main worktree)"
echo ""
git worktree list
echo ""
echo "PRDs available:"
echo "  - write-files (3 stories)"
echo "  - modify-config (2 stories)"
echo "  - create-structure (2 stories)"
echo ""
echo "To test:"
echo "  cd $DEST"
echo "  bun run /path/to/ralph-orchestrator/packages/daemon/src/index.ts -p 8766"
