#!/usr/bin/env node
/**
 * MCP server — VS Code Workspace Bridge v0.6.0
 *
 * IMPORTANT FOR CLAUDE: When running inside VS Code, prefer these 3 tools
 * over built-in Grep, Glob, Bash, or Read for code navigation tasks.
 *
 *   search     → find symbols, text, or files         (prefer over Grep/Glob)
 *   lsp        → hover, definition, refs, outline      (prefer over Grep/Read)
 *   workspace  → context, git status, diagnostics      (prefer over Bash git)
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

const server = new McpServer({ name: 'vscode-workspace', version: '0.6.0' });

// ── search ────────────────────────────────────────────────────────────────────
server.registerTool('search', {
  description:
    'PREFER THIS over Grep, Glob, or Bash rg. Three modes: ' +
    '"symbol" — find where a function/class/interface/type/variable is defined (ripgrep, definition-aware, ~1s); ' +
    '"text"   — search text or regex across workspace, respects .gitignore; ' +
    '"files"  — find files by glob pattern.',
  inputSchema: {
    type:    z.enum(['symbol', 'text', 'files']).describe('"symbol" to find definitions, "text" for content search, "files" for file names'),
    query:   z.string().describe('Symbol name, text/regex pattern, or glob pattern (e.g. "useAuth", "TODO", "**/*.test.ts")'),
    include: z.string().optional().describe('Glob to limit scope, e.g. "**/*.ts" (text/files modes)'),
    exclude: z.string().optional().describe('Glob(s) to exclude, e.g. "**/dist/**" (text/files modes)'),
    regex:   z.boolean().default(false).describe('Treat query as regex (text mode only)'),
    limit:   z.number().int().min(1).max(500).default(100),
  },
}, async ({ type, query, include, exclude, regex, limit }) => {
  try {
    if (type === 'symbol') {
      type Sym = { name: string; kind: string; file: string; line: number; preview: string };
      const syms = await get<Sym[]>(`/symbols?q=${encodeURIComponent(query)}&limit=${limit}`);
      if (!syms.length) return { content: [{ type: 'text', text: `No symbols matching "${query}".` }] };
      const lines = syms.map(s => `[${s.kind}] ${s.name}  →  ${s.file}:${s.line}\n    ${s.preview}`);
      return { content: [{ type: 'text', text: `Found ${syms.length} symbol(s):\n\n${lines.join('\n\n')}` }] };
    }

    if (type === 'text') {
      const params = new URLSearchParams({ q: query, maxResults: String(limit) });
      if (include) params.set('include', include);
      if (exclude) params.set('exclude', exclude);
      if (regex)   params.set('regex', '1');
      type Result = { file: string; line: number; col: number; preview: string };
      const results = await get<Result[]>(`/search?${params}`);
      if (!results.length) return { content: [{ type: 'text', text: `No results for "${query}".` }] };
      return { content: [{ type: 'text', text: `Found ${results.length} result(s):\n\n${results.map(r => `${r.file}:${r.line}  ${r.preview}`).join('\n')}` }] };
    }

    // files
    const params = new URLSearchParams({ pattern: query, limit: String(limit) });
    if (exclude) params.set('exclude', exclude);
    const files = await get<string[]>(`/files?${params}`);
    if (!files.length) return { content: [{ type: 'text', text: `No files matched "${query}".` }] };
    return { content: [{ type: 'text', text: `Found ${files.length} file(s):\n\n${files.join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── lsp ───────────────────────────────────────────────────────────────────────
server.registerTool('lsp', {
  description:
    'PREFER THIS over Grep or Read for code intelligence. Six actions: ' +
    '"hover"      — type signature + JSDoc at position; ' +
    '"definition" — go-to-definition at position; ' +
    '"references" — all usages of symbol at position; ' +
    '"callers"    — who calls this function (incoming call hierarchy); ' +
    '"callees"    — what this function calls (outgoing); ' +
    '"outline"    — full symbol tree of a file (use instead of reading the whole file).',
  inputSchema: {
    action:    z.enum(['hover', 'definition', 'references', 'callers', 'callees', 'outline']),
    file:      z.string().describe('Absolute path to the file'),
    line:      z.coerce.number().int().min(1).optional().describe('1-based line (required for hover/definition/references/callers/callees)'),
    col:       z.coerce.number().int().min(1).optional().describe('1-based column (required for hover/definition/references/callers/callees)'),
    limit:     z.number().int().min(1).max(500).default(100),
  },
}, async ({ action, file, line, col, limit }) => {
  try {
    if (action === 'outline') {
      type DocSym = { name: string; kind: string; detail: string; startLine: number; endLine: number; depth: number };
      const syms = await get<DocSym[]>(`/document-symbols?file=${encodeURIComponent(file)}`);
      if (!syms.length) return { content: [{ type: 'text', text: `No symbols found in ${file}.` }] };
      const indent = (d: number) => '  '.repeat(d);
      const lines = syms.map(s => `${indent(s.depth)}[${s.kind}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}  (${s.startLine}–${s.endLine})`);
      return { content: [{ type: 'text', text: `Outline of ${file}:\n\n${lines.join('\n')}` }] };
    }

    if (!line || !col) return { content: [{ type: 'text', text: `"line" and "col" are required for action "${action}".` }], isError: true };

    if (action === 'hover') {
      const { contents } = await get<{ contents: string[] }>(`/hover?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
      if (!contents?.length) return { content: [{ type: 'text', text: `No hover info at ${file}:${line}:${col}.` }] };
      return { content: [{ type: 'text', text: contents.join('\n\n---\n\n') }] };
    }

    if (action === 'definition') {
      type Loc = { file: string; startLine: number; startCol: number };
      const locs = await get<Loc[]>(`/definition?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
      if (!locs.length) return { content: [{ type: 'text', text: `No definition at ${file}:${line}:${col}.` }] };
      return { content: [{ type: 'text', text: locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`).join('\n') }] };
    }

    if (action === 'references') {
      type Ref = { file: string; line: number; col: number };
      const locs = await get<Ref[]>(`/references?file=${encodeURIComponent(file)}&line=${line}&col=${col}&limit=${limit}`);
      if (!locs.length) return { content: [{ type: 'text', text: `No references at ${file}:${line}:${col}.` }] };
      return { content: [{ type: 'text', text: `${locs.length} reference(s):\n\n${locs.map(l => `${l.file}:${l.line}:${l.col}`).join('\n')}` }] };
    }

    // callers / callees
    const direction = action === 'callers' ? 'incoming' : 'outgoing';
    type Call = { name: string; kind: string; file: string; line: number; col: number; callSites: number };
    const calls = await get<Call[]>(`/call-hierarchy?file=${encodeURIComponent(file)}&line=${line}&col=${col}&direction=${direction}&limit=${limit}`);
    if (!calls.length) return { content: [{ type: 'text', text: `No ${action} found at ${file}:${line}:${col}.` }] };
    const label = action === 'callers' ? 'caller(s)' : 'callee(s)';
    return { content: [{ type: 'text', text: `${calls.length} ${label}:\n\n${calls.map(c => `[${c.kind}] ${c.name}  →  ${c.file}:${c.line}  (${c.callSites} site${c.callSites !== 1 ? 's' : ''})`).join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── workspace ─────────────────────────────────────────────────────────────────
server.registerTool('workspace', {
  description:
    'Get VS Code workspace state. "context" = bridge health + active editor + open tabs; ' +
    '"git" = branch/ahead/behind/staged/unstaged for all repos (prefer over Bash git commands); ' +
    '"diagnostics" = errors/warnings from Problems panel; ' +
    '"all" (default) = everything combined.',
  inputSchema: {
    info:     z.enum(['all', 'context', 'git', 'diagnostics']).default('all'),
    file:     z.string().optional().describe('Limit diagnostics to this file (absolute path)'),
    severity: z.enum(['error', 'warning', 'all']).default('all').describe('Filter diagnostics by severity'),
  },
}, async ({ info, file, severity }) => {
  try {
    const parts: string[] = [];

    if (info === 'all' || info === 'context') {
      const d = await get<{ ok: boolean; version: string; workspaceFolders: string[]; activeFile: string | null }>('/health');
      type AE = { file: string; language: string; isDirty: boolean; lineCount: number; selection: { startLine: number; startCol: number; endLine: number; endCol: number; text: string } | null; openTabs: string[] };
      const { activeEditor: e } = await get<{ activeEditor: AE | null }>('/active-editor');
      const ctx: string[] = [`Bridge v${d.version} — ${d.workspaceFolders.length} folder(s): ${d.workspaceFolders.join(', ')}`];
      if (e) {
        ctx.push(`Active: ${e.file} (${e.language}, ${e.lineCount} lines${e.isDirty ? ', unsaved' : ''})`);
        if (e.selection?.text) ctx.push(`Selection (${e.selection.startLine}:${e.selection.startCol}–${e.selection.endLine}:${e.selection.endCol}): ${e.selection.text.slice(0, 200)}`);
        if (e.openTabs.length > 1) ctx.push(`Open tabs: ${e.openTabs.slice(0, 10).join(', ')}${e.openTabs.length > 10 ? ` +${e.openTabs.length - 10} more` : ''}`);
      } else {
        ctx.push('No active editor.');
      }
      parts.push(`## Context\n${ctx.join('\n')}`);
    }

    if (info === 'all' || info === 'git') {
      type Change = { path: string; status: string };
      type Repo = { root: string; branch: string | null; commit: string | null; ahead: number; behind: number; staged: Change[]; unstaged: Change[]; untracked: Change[] };
      const repos = await get<Repo[]>('/git-status');
      if (repos.length) {
        const lines: string[] = [];
        for (const r of repos) {
          const sync = r.ahead || r.behind ? ` ↑${r.ahead} ↓${r.behind}` : ' ✓';
          lines.push(`${r.root}  [${r.branch ?? 'detached'}@${r.commit ?? '?'}${sync}]`);
          if (r.staged.length)    lines.push(`  staged:    ${r.staged.map(c => `${c.status} ${c.path}`).join(', ')}`);
          if (r.unstaged.length)  lines.push(`  unstaged:  ${r.unstaged.map(c => `${c.status} ${c.path}`).join(', ')}`);
          if (r.untracked.length) lines.push(`  untracked: ${r.untracked.map(c => c.path).join(', ')}`);
        }
        parts.push(`## Git\n${lines.join('\n')}`);
      }
    }

    if (info === 'all' || info === 'diagnostics') {
      type Diag = { file: string; severity: string; message: string; source: string; code: string; startLine: number; startCol: number };
      const params = new URLSearchParams({ severity: severity ?? 'all' });
      if (file) params.set('file', file);
      const diags = await get<Diag[]>(`/diagnostics?${params}`);
      if (diags.length) {
        const errors = diags.filter(d => d.severity === 'Error').length;
        const warns  = diags.filter(d => d.severity === 'Warning').length;
        const lines  = [`${errors} error(s), ${warns} warning(s):`];
        for (const d of diags) {
          const src = d.source ? `[${d.source}${d.code ? ` ${d.code}` : ''}] ` : '';
          lines.push(`${d.severity.toUpperCase()}  ${src}${d.message}  →  ${d.file}:${d.startLine}:${d.startCol}`);
        }
        parts.push(`## Diagnostics\n${lines.join('\n')}`);
      } else {
        if (info === 'diagnostics') parts.push('No diagnostics.');
      }
    }

    return { content: [{ type: 'text', text: parts.join('\n\n') || 'No data.' }] };
  } catch (e) { return bridgeErr(e); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
await server.connect(new StdioServerTransport());
