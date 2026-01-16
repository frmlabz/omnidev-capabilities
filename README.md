# OmniDev Capabilities

Community capabilities for [OmniDev](https://github.com/Nikola-Milovic/omnidev).

## Usage

Capabilities are configured in your project's `omnidev.toml`:

```toml
[capabilities.ralph]
path = "/path/to/omnidev-capabilities/ralph"
enabled = true
```

Or install from a git URL:

```toml
[capabilities.ralph]
git = "https://github.com/Nikola-Milovic/omnidev-capabilities"
path = "ralph"
enabled = true
```

## Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format
```

## Creating a New Capability

See the [capability development guide](https://github.com/Nikola-Milovic/omnidev/blob/main/docs/capability-development.md).
