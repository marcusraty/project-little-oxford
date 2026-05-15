# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2]

### Added

- **`little-oxford: Initialize Audit Engine` command.** Scaffolds `.oxford/rules/behavioral.json` and `.oxford/rules/companion.json` from the default rule set, plus an executable `.oxford/monitor.sh`. Idempotent. If user-authored rule files already exist in `.oxford/rules/`, defaults are not written — the user's rules are preserved.
- **Audit panel initialization banner.** When the audit engine is not initialized (no `monitor.sh` and no rules on disk), the audit panel shows a warning banner with an "Initialize" button. Clicking the button runs the new initialize command and the banner clears automatically.
- **Filesystem watcher on `.oxford/monitor.sh`.** Init state refreshes reactively if the script is deleted or recreated outside the extension. Existing rules-dir watcher also refreshes init state on rule file changes.

### Changed

- **Copy command button is gated on init state.** Previously the Copy command button on the audit panel would copy the monitor instructions regardless of whether `.oxford/monitor.sh` existed in the target project — which led to Claude failing to start the monitor in fresh projects. Now the button is disabled (with an explanatory tooltip) until the project is initialized; the postMessage handler also no-ops as defense-in-depth and surfaces a warning toast if invoked while uninitialized.

### Testing

- 7 new VS Code integration tests (V40–V46) covering command registration, file scaffolding, idempotency, user-rules preservation, init-state introspection, and gated copy behavior.
- 5 new Playwright tests (A40–A44) against the auto-generated audit harness covering banner visibility, the `disabled` attribute on the copy button, the `init-state` postMessage flow, and the Initialize button posting `{type: 'initialize'}` back to the host.

## [0.2.1]

### Fixed

- **Packaged `.vsix` was bloated.** `.vscodeignore` was missing entries for `coverage/`, `test-results/`, and several stale `dist/` artifacts from older build configurations (`audit_webview.js`, `build-harness.js`, `debug_dev.js`, `gen_audit_harness.js`, `gen_fixture.js`, `dist/vscode-tests/`). The v0.2.0 package shipped at 6.6 MB / 266 files. v0.2.1 ships at 2.4 MB / 12 files containing only what the extension actually loads (`dist/extension.js`, `dist/webview.js`, the schema, screenshots, README, BOOTSTRAP, CHANGELOG, LICENSE, package.json).
- **README clone URL pointed at the wrong repo.** Three occurrences of `https://github.com/marcusraty/little-oxford.git` corrected to `https://github.com/marcusraty/project-little-oxford.git`. Anyone copy-pasting the clone command from the README in v0.2.0 hit a 404.

## [0.2.0]

### Added

- **Audit engine** — watches Claude Code JSONL transcripts and runs a rule engine over each event. Normalizer converts raw events into a stable schema (`tool_use`, `text`, `thinking`, `user_prompt`, `system`).
- **Sink architecture** — rule evaluation results dispatch through four sinks: monitor feed, audit panel, status bar, and activity tracker.
- **Rule system** — behavioral rules (regex over text/thinking) and companion rules (triggers + required co-edits) live in `.oxford/rules/` as JSON. Default rules ship with the extension and load automatically when `.oxford/rules/` is empty.
- **Rules file watcher** — edits to any `.oxford/rules/*.json` file are picked up automatically; no command to run, no extension reload.
- **Monitor script** (`.oxford/monitor.sh`) — streams rule matches to a terminal in real time, with the event kind tagged on each line (e.g. `[F11] (thinking) ...`, `[F4] (tool_use:Edit) ...`). Uses `tail -n 0 -f` so a restart only shows new events.
- **Staleness v2** — green/red dots on diagram components reflect whether the agent read the backing file before updating the model. Driven by intent-to-verify tracking through context.
- **Activity routing** — Read vs Edit/Write tool calls are now correctly distinguished, including Bash commands that write files (`sed -i`, `> file`, `tee`, etc.).
- **Custom rule editor** — JSON files under `.oxford/rules/` open in a custom webview editor for guided rule creation.
- **Help affordances on every surface** — orange "? Help" button in the diagram panel (top-right), the audit panel, and the status bar pill menu. All three open a quick-pick offering email-the-maintainer or start-a-GitHub-discussion. Single source of truth in `helpMenuItems()`.
- **Rules-status chip** — audit panel shows `N rules · just reloaded / Xs ago / Xm ago` next to the monitor indicator. Ticks every 10s; updates on every watcher-triggered reload.
- **Status bar quick-pick** — clicking the little-oxford status bar pill opens a menu (Open Diagram / Get Help) instead of a single action.
- **Coverage tooling** — `npm run coverage` runs all tests with c8 and emits per-file HTML + lcov reports.

### Changed

- **Renamed from `oxford` to `little-oxford`** everywhere except the `.oxford/` data folder, which stays for backwards compatibility with existing workspaces.
- **Architecture collapsed to a single VS Code extension.** The daemon + HTTP layer and the standalone CLI are gone; the extension watches files directly via VS Code's file watcher API.
- **Audit panel reads from `audit.jsonl` on demand** instead of holding an in-memory ring buffer — eliminates startup races and bounds memory.
- **System event normalization** — only `compact_boundary` system events are emitted; noisy `turn_duration` and `local_command` events are filtered.
- **Audit log deduplication** — engine maintains a `seenIds` set scanned from `audit.jsonl` on startup, preventing the ~10× duplication seen in long-running sessions.
- **F11 (Test-free implementation) tightened** — pattern moved from broad `.*` glue to a literal phrase list with word boundaries, dramatically reducing false-positive fires on multi-sentence planning prose.
- **Playwright harness is now generated from production source** — `panel_body.ts` (pure, no vscode imports) feeds both `htmlShell()` and `scripts/build-harness.ts`. A drift unit test fails loudly if the on-disk harness diverges. Catches the class of bugs where the test surface and production code silently drift apart.

### Removed

- **`little-oxford: Create Default Audit Rules` command** — replaced by the rules file watcher. Defaults still ship via code; editing `.oxford/rules/*.json` directly is now the customisation path.

### Fixed

- Normalizer leaked `turn_duration` and `local_command` events into the audit panel.
- Activity tracking incorrectly classified every tool touch as a "read" — Edit/Write touches now record `last_edit` separately.
- Audit log file could exceed several hundred MB due to duplicate event ingestion across sessions.
- Diagram help button was rendered behind the Pan/Edit toggle because both occupied `top: 12px; right: 12px`. Help button now sits one row below; occlusion test catches future regressions via `elementFromPoint` and Playwright actionability.

### Testing

- ~630 tests across three suites: Node unit (~540), Playwright (~70), VS Code integration (~20).
- Statement coverage is at or near 100% on every reachable line of every source file. Remaining gaps are unreachable defensive code paths (`?? []` fallbacks, catch blocks for never-thrown errors) or runtime-specific paths covered by the Playwright suite.

## [0.1.0]

Initial release. Diagram rendering from `.oxford/model.json`, drag-to-pin layout persistence, click-to-jump-to-source, hover tooltips with file activity timestamps, multi-session audit panel.

[0.2.2]: https://github.com/marcusraty/project-little-oxford/releases/tag/v0.2.2
[0.2.1]: https://github.com/marcusraty/project-little-oxford/releases/tag/v0.2.1
[0.2.0]: https://github.com/marcusraty/little-oxford/releases/tag/v0.2.0
[0.1.0]: https://github.com/marcusraty/little-oxford/releases/tag/v0.1.0
