#!/usr/bin/env node
/**
 * MCP server — VS Code Workspace Bridge v0.5.0
 *
 * IMPORTANT FOR CLAUDE: When running inside VS Code, ALWAYS prefer these tools
 * over built-in Grep, Glob, or Bash commands for code navigation tasks:
 *
 *   workspace_symbols  → find where a symbol is defined  (prefer over Grep)
 *   text_search        → search text across workspace    (prefer over Grep/Bash rg)
 *   document_symbols   → outline a file's structure      (prefer over Read)
 *   hover              → get type info at a position     (prefer over Read)
 *   definition         → go to definition                (prefer over Grep)
 *   references         → find all usages                 (prefer over Grep)
 *   call_hierarchy     → who calls this function         (prefer over Grep)
 *   diagnostics        → get current errors/warnings
 *   find_files         → glob file search                (prefer over Glob)
 *   active_editor      → what file is open right now
 *   git_status         → branch + changes per repo
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE = `http://127.0.0.1:${process.env['VSCODE_BRIDGE_PORT'] ?? '29837'}`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BRIDGE + path, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Bridge HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const NOT_RUNNING = 'VS Code bridge is not reachable. Open VS Code with the "Claude Code Workspace" extension active.';

function bridgeErr(e: unknown) {
  const msg = String(e);
  const text = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('abort') ? NOT_RUNNING : `Error: ${msg}`;
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const server = new McpServer({ name: 'vscode-workspace', version: '0.5.0' });

// ── bridge_health ─────────────────────────────────────────────────────────────
server.registerTool('bridge_health', {
  description: 'Check whether the VS Code bridge is running. Returns workspace folders and active file.',
}, async () => {
  try {
    const d = await get<{ ok: boolean; version: string; workspaceFolders: string[]; activeFile: string | null }>('/health');
    return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
  } catch (e) { return bridgeErr(e); }
});

// ── workspace_symbols ─────────────────────────────────────────────────────────
server.registerTool('workspace_symbols', {
  description:
    'PREFER THIS over Grep when looking for where a symbol (function, class, interface, type, variable) is defined. ' +
    'Searches all workspace folders with definition-aware ripgrep patterns. Fast (~1s), language-agnostic. ' +
    'Falls back to a broad word search if no definition pattern matches. ' +
    'Use this first whenever you need to find a symbol by name.',
  inputSchema: {
    query: z.string().describe('Exact symbol name to find (e.g. "useAuth", "AssetGrid", "RestClient")'),
    limit: z.number().int().min(1).max(200).default(50).describe('Max results'),
  },
}, async ({ query, limit }) => {
  try {
    type Sym = { name: string; kind: string; file: string; line: number; preview: string };
    const syms = await get<Sym[]>(`/symbols?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!syms.length) return { content: [{ type: 'text', text: `No symbols matching "${query}".` }] };
    const lines = syms.map(s => `[${s.kind}] ${s.name}  →  ${s.file}:${s.line}\n    ${s.preview}`);
    return { content: [{ type: 'text', text: `Found ${syms.length} symbol(s):\n\n${lines.join('\n\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── document_symbols ──────────────────────────────────────────────────────────
server.registerTool('document_symbols', {
  description:
    'PREFER THIS over reading a file when you need to understand its structure. ' +
    'Returns all classes, functions, methods, variables with line ranges — the full outline. ' +
    'Use this to find which lines to read instead of reading the whole file.',
  inputSchema: {
    file: z.string().describe('Absolute path to the file'),
  },
}, async ({ file }) => {
  try {
    type DocSym = { name: string; kind: string; detail: string; startLine: number; endLine: number; depth: number };
    const syms = await get<DocSym[]>(`/document-symbols?file=${encodeURIComponent(file)}`);
    if (!syms.length) return { content: [{ type: 'text', text: `No symbols found in ${file}.` }] };
    const indent = (d: number) => '  '.repeat(d);
    const lines = syms.map(s => `${indent(s.depth)}[${s.kind}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}  (lines ${s.startLine}–${s.endLine})`);
    return { content: [{ type: 'text', text: `Outline of ${file} (${syms.length} symbols):\n\n${lines.join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── find_files ────────────────────────────────────────────────────────────────
server.registerTool('find_files', {
  description:
    'PREFER THIS over Glob when searching for files by name/pattern in the workspace. ' +
    'Respects .gitignore and workspace folder boundaries.',
  inputSchema: {
    pattern: z.string().default('**/*').describe('Glob pattern (e.g. "**/*.test.ts", "**/useAuth*")'),
    exclude: z.string().default('**/node_modules/**').describe('Glob to exclude'),
    limit: z.number().int().min(1).max(1000).default(200),
  },
}, async ({ pattern, exclude, limit }) => {
  try {
    const files = await get<string[]>(`/files?pattern=${encodeURIComponent(pattern)}&exclude=${encodeURIComponent(exclude)}&limit=${limit}`);
    if (!files.length) return { content: [{ type: 'text', text: `No files matched "${pattern}".` }] };
    return { content: [{ type: 'text', text: `Found ${files.length} file(s):\n\n${files.join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── active_editor ─────────────────────────────────────────────────────────────
server.registerTool('active_editor', {
  description: "Get the file currently open and visible in VS Code — path, language, line count, selected text, and all open tabs. Use this to understand what the user is looking at.",
}, async () => {
  try {
    type AE = { file: string; language: string; isDirty: boolean; lineCount: number; selection: { startLine: number; startCol: number; endLine: number; endCol: number; text: string } | null; openTabs: string[] };
    const { activeEditor: e } = await get<{ activeEditor: AE | null }>('/active-editor');
    if (!e) return { content: [{ type: 'text', text: 'No file is currently open.' }] };
    const out = [`File:     ${e.file}`, `Language: ${e.language}`, `Lines:    ${e.lineCount}${e.isDirty ? '  ⚠ unsaved' : ''}`];
    if (e.selection) {
      const s = e.selection;
      out.push(`\nSelection (${s.startLine}:${s.startCol}–${s.endLine}:${s.endCol}):\n\`\`\`\n${s.text}\n\`\`\``);
    }
    if (e.openTabs.length) out.push(`\nOpen tabs (${e.openTabs.length}):\n${e.openTabs.map(f => `  ${f}`).join('\n')}`);
    return { content: [{ type: 'text', text: out.join('\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── diagnostics ───────────────────────────────────────────────────────────────
server.registerTool('diagnostics', {
  description: "Get errors and warnings from VS Code's Problems panel — the same list shown in the IDE. Filter by file or severity. Use this after making changes to check for type errors.",
  inputSchema: {
    file: z.string().optional().describe('Absolute path to limit to one file (omit for all workspace diagnostics)'),
    severity: z.enum(['error', 'warning', 'information', 'all']).default('all'),
  },
}, async ({ file, severity }) => {
  try {
    type Diag = { file: string; severity: string; message: string; source: string; code: string; startLine: number; startCol: number };
    const params = new URLSearchParams({ severity: severity ?? 'all' });
    if (file) params.set('file', file);
    const diags = await get<Diag[]>(`/diagnostics?${params}`);
    if (!diags.length) return { content: [{ type: 'text', text: file ? `No diagnostics in ${file}.` : 'No diagnostics in workspace.' }] };
    const errors = diags.filter(d => d.severity === 'Error').length;
    const warns  = diags.filter(d => d.severity === 'Warning').length;
    const lines  = [`${diags.length} diagnostic(s) — ${errors} error(s), ${warns} warning(s)\n`];
    for (const d of diags) {
      const src = d.source ? `[${d.source}${d.code ? ` ${d.code}` : ''}] ` : '';
      lines.push(`${d.severity.toUpperCase()}  ${src}${d.message}\n  → ${d.file}:${d.startLine}:${d.startCol}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── hover ─────────────────────────────────────────────────────────────────────
server.registerTool('hover', {
  description:
    'PREFER THIS over reading type definition files. ' +
    'Returns the TypeScript type signature and JSDoc for any symbol at a given position — ' +
    'exactly what VS Code shows on hover. Gives you types, return types, and docs in one call.',
  inputSchema: {
    file: z.string().describe('Absolute path to the source file'),
    line: z.coerce.number().int().min(1).describe('1-based line number'),
    col:  z.coerce.number().int().min(1).describe('1-based column number'),
  },
}, async ({ file, line, col }) => {
  try {
    const { contents } = await get<{ contents: string[] }>(`/hover?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
    if (!contents?.length) return { content: [{ type: 'text', text: `No hover info at ${file}:${line}:${col}.` }] };
    return { content: [{ type: 'text', text: contents.join('\n\n---\n\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── definition ────────────────────────────────────────────────────────────────
server.registerTool('definition', {
  description:
    'PREFER THIS over Grep when you know the file and position of a symbol and need its definition location. ' +
    'Uses LSP — resolves across packages, type aliases, and re-exports accurately.',
  inputSchema: {
    file: z.string().describe('Absolute path to the file containing the symbol usage'),
    line: z.coerce.number().int().min(1).describe('1-based line number'),
    col:  z.coerce.number().int().min(1).describe('1-based column number'),
  },
}, async ({ file, line, col }) => {
  try {
    type Loc = { file: string; startLine: number; startCol: number };
    const locs = await get<Loc[]>(`/definition?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
    if (!locs.length) return { content: [{ type: 'text', text: `No definition at ${file}:${line}:${col}.` }] };
    return { content: [{ type: 'text', text: `Definition(s):\n\n${locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`).join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── references ────────────────────────────────────────────────────────────────
server.registerTool('references', {
  description:
    'PREFER THIS over Grep when finding all usages of a symbol. ' +
    'Uses LSP — handles renamed symbols, interface implementations, and overloads correctly.',
  inputSchema: {
    file:  z.string().describe('Absolute path to the file with the symbol'),
    line:  z.coerce.number().int().min(1).describe('1-based line number'),
    col:   z.coerce.number().int().min(1).describe('1-based column number'),
    limit: z.number().int().min(1).max(500).default(200),
  },
}, async ({ file, line, col, limit }) => {
  try {
    type Ref = { file: string; line: number; col: number };
    const locs = await get<Ref[]>(`/references?file=${encodeURIComponent(file)}&line=${line}&col=${col}&limit=${limit}`);
    if (!locs.length) return { content: [{ type: 'text', text: `No references at ${file}:${line}:${col}.` }] };
    return { content: [{ type: 'text', text: `Found ${locs.length} reference(s):\n\n${locs.map(l => `${l.file}:${l.line}:${l.col}`).join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── call_hierarchy ────────────────────────────────────────────────────────────
server.registerTool('call_hierarchy', {
  description:
    'Show who calls a function (incoming) or what it calls (outgoing). ' +
    'Essential for understanding the impact of changes before editing. ' +
    'Much faster than grepping for callers manually.',
  inputSchema: {
    file:      z.string().describe('Absolute path to the file'),
    line:      z.coerce.number().int().min(1).describe('1-based line number of the function name'),
    col:       z.coerce.number().int().min(1).describe('1-based column number'),
    direction: z.enum(['incoming', 'outgoing']).default('incoming').describe('"incoming" = callers, "outgoing" = callees'),
    limit:     z.number().int().min(1).max(100).default(50),
  },
}, async ({ file, line, col, direction, limit }) => {
  try {
    type Call = { name: string; kind: string; file: string; line: number; col: number; callSites: number };
    const calls = await get<Call[]>(`/call-hierarchy?file=${encodeURIComponent(file)}&line=${line}&col=${col}&direction=${direction}&limit=${limit}`);
    if (!calls.length) return { content: [{ type: 'text', text: `No ${direction} calls found at ${file}:${line}:${col}.` }] };
    const label = direction === 'incoming' ? 'caller(s)' : 'callee(s)';
    const lines = calls.map(c => `[${c.kind}] ${c.name}  →  ${c.file}:${c.line}:${c.col}  (${c.callSites} call site${c.callSites !== 1 ? 's' : ''})`);
    return { content: [{ type: 'text', text: `Found ${calls.length} ${label}:\n\n${lines.join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── git_status ────────────────────────────────────────────────────────────────
server.registerTool('git_status', {
  description: 'Get git status for all workspace repos — branch, ahead/behind, staged and unstaged changes. Prefer this over running git commands in Bash.',
}, async () => {
  try {
    type Change = { path: string; status: string };
    type Repo = { root: string; branch: string | null; commit: string | null; ahead: number; behind: number; staged: Change[]; unstaged: Change[]; untracked: Change[] };
    const repos = await get<Repo[]>('/git-status');
    if (!repos.length) return { content: [{ type: 'text', text: 'No git repositories found in workspace.' }] };
    const out: string[] = [];
    for (const r of repos) {
      const sync = r.ahead || r.behind ? ` ↑${r.ahead} ↓${r.behind}` : ' ✓ in sync';
      out.push(`## ${r.root}`);
      out.push(`Branch: ${r.branch ?? 'detached HEAD'} @ ${r.commit ?? '?'}${sync}`);
      if (r.staged.length)    out.push(`\nStaged (${r.staged.length}):\n${r.staged.map(c => `  ${c.status}  ${c.path}`).join('\n')}`);
      if (r.unstaged.length)  out.push(`\nUnstaged (${r.unstaged.length}):\n${r.unstaged.map(c => `  ${c.status}  ${c.path}`).join('\n')}`);
      if (r.untracked.length) out.push(`\nUntracked (${r.untracked.length}):\n${r.untracked.map(c => `  ${c.path}`).join('\n')}`);
    }
    return { content: [{ type: 'text', text: out.join('\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── text_search ───────────────────────────────────────────────────────────────
server.registerTool('text_search', {
  description:
    'PREFER THIS over Grep or Bash rg commands for searching text across the workspace. ' +
    'Ripgrep across all workspace folders, respects .gitignore, supports regex and glob filters. ' +
    'Use workspace_symbols instead if searching for a symbol definition by name.',
  inputSchema: {
    query:      z.string().describe('Text or regex pattern to search for'),
    include:    z.string().optional().describe('Glob to limit scope, e.g. "**/*.ts"'),
    exclude:    z.string().optional().describe('Comma-separated globs to exclude, e.g. "**/dist/**,**/*.test.ts"'),
    regex:      z.boolean().default(false).describe('Treat query as regex (default: exact string match)'),
    maxResults: z.number().int().min(1).max(500).default(100),
  },
}, async ({ query, include, exclude, regex, maxResults }) => {
  try {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (include) params.set('include', include);
    if (exclude) params.set('exclude', exclude);
    if (regex)   params.set('regex', '1');
    type Result = { file: string; line: number; col: number; preview: string };
    const results = await get<Result[]>(`/search?${params}`);
    if (!results.length) return { content: [{ type: 'text', text: `No results for "${query}".` }] };
    return { content: [{ type: 'text', text: `Found ${results.length} result(s) for "${query}":\n\n${results.map(r => `${r.file}:${r.line}:${r.col}  ${r.preview}`).join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
await server.connect(new StdioServerTransport());
