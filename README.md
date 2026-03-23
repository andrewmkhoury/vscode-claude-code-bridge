# vscode-claude-code-bridge

A VS Code extension + companion MCP server that expose VS Code's workspace intelligence to [Claude Code](https://claude.ai/code).

Claude Code gains access to your live LSP index — symbols, diagnostics, go-to-definition, find-all-references, and full-text search — without re-indexing the codebase itself.

## How it works

```
Claude Code CLI
    └── MCP server (mcp-server-vscode)
            └── HTTP bridge (port 29837)
                    └── VS Code extension (Claude Code Workspace)
                            ├── vscode.executeWorkspaceSymbolProvider
                            ├── vscode.languages.getDiagnostics
                            ├── vscode.executeDefinitionProvider
                            ├── vscode.executeReferenceProvider
                            ├── vscode.workspace.findTextInFiles
                            └── vscode.workspace.findFiles
```

## Installation

### 1. Install the VS Code extension

Install **Claude Code Workspace** from the VS Code Marketplace, or download the `.vsix` from the [releases page](https://github.com/akhoury/vscode-claude-code-bridge/releases) and install with:

```sh
code --install-extension claude-code-workspace-*.vsix
```

### 2. Install the MCP server

```sh
npm install -g mcp-server-vscode
```

### 3. Register the MCP server with Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "vscode-workspace": {
      "command": "mcp-server-vscode"
    }
  }
}
```

Or if you use a non-default port:

```json
{
  "mcpServers": {
    "vscode-workspace": {
      "command": "mcp-server-vscode",
      "env": { "VSCODE_BRIDGE_PORT": "29837" }
    }
  }
}
```

### 4. Open VS Code and verify

After restarting Claude Code, run:

```
check bridge_health
```

You should see the workspace folders VS Code currently has open.

## Available MCP tools

| Tool | Description |
|---|---|
| `bridge_health` | VS Code status, open workspace folders, active file |
| `workspace_symbols` | LSP workspace symbol search by name/prefix |
| `find_files` | Glob file search respecting `.gitignore` |
| `active_editor` | Current file, selected text, open tabs |
| `diagnostics` | Errors and warnings from the Problems panel |
| `definition` | Go-to-definition via LSP |
| `references` | Find all references via LSP |
| `text_search` | Full-text search with regex support |

## Configuration

All settings are available in VS Code under **Settings → Claude Code Workspace**:

| Setting | Default | Description |
|---|---|---|
| `claudeCodeWorkspace.claudePath` | *(auto)* | Path to the `claude` CLI. Leave empty to auto-detect. |
| `claudeCodeWorkspace.port` | `29837` | HTTP bridge port. Must match `VSCODE_BRIDGE_PORT` in MCP config. |
| `claudeCodeWorkspace.maxSymbols` | `100` | Max symbols returned per search. |
| `claudeCodeWorkspace.maxFiles` | `200` | Max files returned per search. |
| `claudeCodeWorkspace.maxSearchResults` | `100` | Max text search results. |
| `claudeCodeWorkspace.maxReferences` | `200` | Max reference locations. |

## @claude chat participant

The extension also registers a `@claude` participant in VS Code Chat that forwards messages directly to the Claude Code CLI. Type `@claude <your question>` in any VS Code chat panel.

## Development

```sh
git clone https://github.com/akhoury/vscode-claude-code-bridge
cd vscode-claude-code-bridge

# Build the extension
cd extension && npm install && npm run build

# Build the MCP server
cd ../mcp-server && npm install && npm run build
```

To run the extension locally, open the `extension/` folder in VS Code and press **F5**.

## Repository structure

```
vscode-claude-code-bridge/
├── extension/          VS Code extension (TypeScript, esbuild)
│   └── src/
│       └── extension.ts
└── mcp-server/         MCP server npm package (TypeScript)
    └── src/
        └── index.ts
```

## License

MIT
