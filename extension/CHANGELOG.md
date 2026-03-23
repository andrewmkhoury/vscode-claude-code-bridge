# Changelog

## [0.1.0] - 2026-03-22

### Added
- HTTP bridge server exposing VS Code workspace intelligence on `127.0.0.1:29837`
- `GET /health` — VS Code status, workspace folders, active file
- `GET /symbols` — LSP workspace symbol search
- `GET /files` — Glob file search
- `GET /active-editor` — Current file, selection, open tabs
- `GET /diagnostics` — Problems panel errors and warnings
- `GET /definition` — Go-to-definition via LSP
- `GET /references` — Find all references via LSP
- `GET /search` — Full-text search with regex support
- `@claude` chat participant forwarding messages to Claude Code CLI
- Settings UI: `claudeCodeWorkspace.*` configuration namespace
- Status bar indicator showing bridge health
- Auto-detect `claude` CLI from `$PATH` and common install locations
- Graceful handling of port conflicts with user-facing warning
