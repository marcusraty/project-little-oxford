# CLAUDE.md — little-oxford

## What this project is

A VS Code extension that renders live architecture diagrams from `.oxford/model.json` and watches AI coding agents via an audit engine. Being renamed from `oxford` to `little-oxford`.

## Current state

The extension works: diagram rendering, drag-to-pin, click-to-focus, model picker, activity tracking ("Last read X ago" on hover), audit panel with multi-session support. Installable via `npm run install:local`.

**In progress:** Major refactor to remove the daemon/CLI architecture and collapse everything into the extension. Read `.oxford/NEXT.md` for the full spec.

## Key files to read first

1. `.oxford/NEXT.md` — the product spec and migration plan (READ THIS FIRST)
2. `.oxford/ARCHITECTURE_V2.md` — why no daemon, rationale for single-extension architecture
3. `.oxford/AUDIT.md` — audit entry schema
4. `BOOTSTRAP.md` — how agents should author model.json (the diagram schema)
5. `.oxford/filter-rules.json` — audit filter rules (behavioral + companion)
6. `.oxford/MONITOR_GUIDE.md` — guide for the audit monitor pattern (reference for building the in-extension audit engine)

## Architecture (target — single extension)

The extension does everything directly. No daemon. No CLI. No external processes.

- **File watchers** — VS Code's `createFileSystemWatcher` with `RelativePattern` + `Uri.file()` for external files (CC JSONL in `~/.claude/projects/`). Debounce for double-fire bug.
- **Core libraries** — normalizer, renderer, storage, activity tracker imported directly by the extension host. No HTTP layer.
- **Webviews** — diagram panel (editor tab) and audit panel (bottom panel) receive data via postMessage.
- **Git hook** — template that ships with the extension. Blocks push if model.json is stale.
- **Audit engine** — watches CC JSONL, normalizes events, runs shareable filter rules from `.oxford/rules/`.

**Current code still has the daemon architecture** (daemon.ts, daemon_main.ts, client.ts, daemon_client.ts). These need to be deleted and replaced with direct library calls. See `.oxford/NEXT.md` for migration steps.

## Naming

Renaming from `oxford` / `project-viewer` to `little-oxford`. Use `little-oxford` for all new code.

## Development

```bash
npm run build          # esbuild (prod)
npm run build:debug    # esbuild (debug, enables diagnostics)
npm test               # esbuild → node --test
npm run install:local  # build + package + install vsix
```

After install:local, reload VS Code (Cmd+Shift+P → "Developer: Reload Window").

## Testing

Red-green development. Write a failing test first, then make it pass, then refactor. Tests live in `tests/` and use Node's built-in test runner (`node:test` + `node:assert/strict`).

## Conventions

- TypeScript, strict mode, esbuild bundled
- No comments unless the WHY is non-obvious
- No future-looking code or aspirational features — build what's needed now
- `model.json` schema is intentionally loose — `kind` is any string, no `additionalProperties: false`
- The `__DEBUG__` constant (injected by esbuild) gates diagnostics code — folds to `false` in prod
- Layout lives in `.oxford/layout.json` (tool-managed, not in model.json)
- Activity lives in `.oxford/activity.json` (tracks when components' files were last read)

## What NOT to do

- Don't add a daemon or CLI — the extension does everything
- Don't add HTTP/socket layers — use direct library calls
- Don't silently install hooks — all setup should be explicit via the walk-through wizard
- Don't add diff or attribution modules yet
- Don't add claimed_sources to model.json
