#!/usr/bin/env node
/**
 * Bundled MCP server — copied to ~/.claude-code-workspace/mcp-server.mjs
 * on extension activation so Claude Code always has a stable path to reference.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PORT = parseInt(process.env['VSCODE_BRIDGE_PORT'] ?? '29837', 10);
const BRIDGE = `http://127.0.0.1:${PORT}`;

async function bridgeGet<T>(path: string): Promise<T> {
  const res = await fetch(BRIDGE + path);
  if (!res.ok) throw new Error(`Bridge returned HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const NOT_RUNNING =
  'VS Code bridge is not reachable. Make sure VS Code is open with the ' +
  '"Claude Code Workspace" extension installed and active.';

function errResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const text = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') ? NOT_RUNNING : `Error: ${msg}`;
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const server = new McpServer({ name: 'mcp-server-vscode', version: '0.1.0' });

server.registerTool('bridge_health', {
  description: 'Check whether VS Code is running, which workspace folders are open, and which file is currently active.',
}, async () => {
  try {
    const data = await bridgeGet<{ ok: boolean; version: string; workspaceFolders: string[]; activeFile: string | null }>('/health');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e) { return errResult(e); }
});

server.registerTool('workspace_symbols', {
  description: "Search VS Code's workspace symbol index (LSP-backed). Returns symbols matching the query across all open workspace folders. Great for finding class names, function definitions, interfaces, and exports by name or prefix.",
  inputSchema: { query: z.string().describe('Symbol name or prefix (e.g. "useAuth", "AssetGrid", "ITokenProvider")') },
}, async ({ query }) => {
  try {
    type Sym = { name: string; kind: string; container: string; file: string; line: number };
    const symbols = await bridgeGet<Sym[]>(`/symbols?q=${encodeURIComponent(query)}`);
    if (!symbols.length) return { content: [{ type: 'text', text: `No symbols found matching "${query}".` }] };
    const lines = symbols.map(s => `[${s.kind}] ${s.container ? `${s.container}.` : ''}${s.name}  →  ${s.file}:${s.line}`);
    return { content: [{ type: 'text', text: `Found ${symbols.length} symbol(s):\n\n${lines.join('\n')}` }] };
  } catch (e) { return errResult(e); }
});

server.registerTool('find_files', {
  description: "Find files in the VS Code workspace by glob pattern. Respects VS Code's workspace folders and .gitignore.",
  inputSchema: {
    pattern: z.string().describe('Glob pattern (e.g. "**/*.test.ts", "src/components/**/*.tsx")').default('**/*'),
    exclude: z.string().describe('Glob to exclude (default: **/node_modules/**)').default('**/node_modules/**'),
  },
}, async ({ pattern, exclude }) => {
  try {
    const files = await bridgeGet<string[]>(`/files?pattern=${encodeURIComponent(pattern)}&exclude=${encodeURIComponent(exclude)}`);
    if (!files.length) return { content: [{ type: 'text', text: `No files matched "${pattern}".` }] };
    return { content: [{ type: 'text', text: `Found ${files.length} file(s):\n\n${files.join('\n')}` }] };
  } catch (e) { return errResult(e); }
});

server.registerTool('active_editor', {
  description: 'Get the currently active file in VS Code — path, language, dirty state, selected text, and open tabs.',
}, async () => {
  try {
    type Sel = { startLine: number; startCol: number; endLine: number; endCol: number; text: string };
    type AE = { file: string; language: string; isDirty: boolean; lineCount: number; selection: Sel | null; openTabs: string[] };
    const data = await bridgeGet<{ activeEditor: AE | null }>('/active-editor');
    if (!data.activeEditor) return { content: [{ type: 'text', text: 'No file is currently open in VS Code.' }] };
    const e = data.activeEditor;
    const lines = [`File:     ${e.file}`, `Language: ${e.language}`, `Lines:    ${e.lineCount}${e.isDirty ? '  ⚠ unsaved' : ''}`];
    if (e.selection) {
      const s = e.selection;
      lines.push(`\nSelection (${s.startLine}:${s.startCol} – ${s.endLine}:${s.endCol}):`, '```', s.text, '```');
    }
    if (e.openTabs.length) { lines.push(`\nOpen tabs (${e.openTabs.length}):`); e.openTabs.forEach(f => lines.push(`  ${f}`)); }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) { return errResult(e); }
});

server.registerTool('diagnostics', {
  description: "Get errors and warnings from VS Code's Problems panel. Omit `file` for all workspace diagnostics.",
  inputSchema: { file: z.string().describe('Absolute path to a specific file (optional)').optional() },
}, async ({ file }) => {
  try {
    type Diag = { file: string; severity: string; message: string; source: string; code: string; startLine: number; startCol: number };
    const diags = await bridgeGet<Diag[]>('/diagnostics' + (file ? `?file=${encodeURIComponent(file)}` : ''));
    if (!diags.length) return { content: [{ type: 'text', text: file ? `No diagnostics for ${file}.` : 'No diagnostics in workspace.' }] };
    const errors = diags.filter(d => d.severity === 'Error').length;
    const warnings = diags.filter(d => d.severity === 'Warning').length;
    const lines = [`${diags.length} diagnostic(s): ${errors} error(s), ${warnings} warning(s)\n`];
    for (const d of diags) {
      const src = d.source ? `[${d.source}${d.code ? ` ${d.code}` : ''}] ` : '';
      lines.push(`${d.severity.toUpperCase()}  ${src}${d.message}`, `  → ${d.file}:${d.startLine}:${d.startCol}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) { return errResult(e); }
});

server.registerTool('definition', {
  description: "Go-to-definition via VS Code's LSP. More accurate than grep — resolves across packages, type aliases, and re-exports.",
  inputSchema: {
    file: z.string().describe('Absolute path to the source file'),
    line: z.number().int().min(1).describe('1-based line number'),
    col: z.number().int().min(1).describe('1-based column number'),
  },
}, async ({ file, line, col }) => {
  try {
    type Loc = { file: string; startLine: number; startCol: number };
    const locs = await bridgeGet<Loc[]>(`/definition?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
    if (!locs.length) return { content: [{ type: 'text', text: `No definition found at ${file}:${line}:${col}.` }] };
    return { content: [{ type: 'text', text: `Definition(s):\n\n${locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`).join('\n')}` }] };
  } catch (e) { return errResult(e); }
});

server.registerTool('references', {
  description: "Find all references to the symbol at a given position via VS Code's LSP. More accurate than text search.",
  inputSchema: {
    file: z.string().describe('Absolute path to the source file'),
    line: z.number().int().min(1).describe('1-based line number'),
    col: z.number().int().min(1).describe('1-based column number'),
  },
}, async ({ file, line, col }) => {
  try {
    type Ref = { file: string; line: number; col: number };
    const locs = await bridgeGet<Ref[]>(`/references?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
    if (!locs.length) return { content: [{ type: 'text', text: `No references at ${file}:${line}:${col}.` }] };
    return { content: [{ type: 'text', text: `Found ${locs.length} reference(s):\n\n${locs.map(l => `${l.file}:${l.line}:${l.col}`).join('\n')}` }] };
  } catch (e) { return errResult(e); }
});

server.registerTool('text_search', {
  description: "Full-text search across the VS Code workspace. Respects .gitignore. Supports literal strings and regex.",
  inputSchema: {
    query: z.string().describe('Text or regex pattern'),
    include: z.string().describe('Glob to limit scope, e.g. "**/*.ts"').optional(),
    exclude: z.string().describe('Glob to exclude, e.g. "**/dist/**"').optional(),
    regex: z.boolean().describe('Treat query as regex (default: false)').default(false),
    maxResults: z.number().int().min(1).max(500).describe('Max results (default: 100)').default(100),
  },
}, async ({ query, include, exclude, regex, maxResults }) => {
  try {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (include) params.set('include', include);
    if (exclude) params.set('exclude', exclude);
    if (regex) params.set('regex', '1');
    type Result = { file: string; line: number; col: number; preview: string };
    const results = await bridgeGet<Result[]>(`/search?${params}`);
    if (!results.length) return { content: [{ type: 'text', text: `No results for "${query}".` }] };
    return { content: [{ type: 'text', text: `Found ${results.length} result(s):\n\n${results.map(r => `${r.file}:${r.line}:${r.col}  ${r.preview}`).join('\n')}` }] };
  } catch (e) { return errResult(e); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
