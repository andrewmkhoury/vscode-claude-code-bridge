#!/usr/bin/env node
/**
 * mcp-server-vscode — MCP server for the Claude Code Workspace Bridge
 *
 * Connects to the HTTP bridge running inside VS Code (default port 29837)
 * and exposes VS Code workspace intelligence as MCP tools:
 *
 *   bridge_health      — VS Code status, open folders, active file
 *   workspace_symbols  — LSP workspace symbol search
 *   find_files         — Glob file search (respects .gitignore)
 *   active_editor      — Current file, selection, open tabs
 *   diagnostics        — Errors/warnings from the Problems panel
 *   definition         — Go-to-definition (LSP)
 *   references         — Find all references (LSP)
 *   text_search        — Full-text search (respects .gitignore)
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
  const text = msg.includes('fetch failed') || msg.includes('ECONNREFUSED')
    ? NOT_RUNNING
    : `Error: ${msg}`;
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const server = new McpServer({ name: 'mcp-server-vscode', version: '0.1.0' });

// ── bridge_health ─────────────────────────────────────────────────────────────
server.registerTool(
  'bridge_health',
  {
    description:
      'Check whether VS Code is running, which workspace folders are open, and which file is currently active. ' +
      'Call this first to confirm the bridge is reachable.',
  },
  async () => {
    try {
      const data = await bridgeGet<{
        ok: boolean;
        version: string;
        workspaceFolders: string[];
        activeFile: string | null;
      }>('/health');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return errResult(e);
    }
  }
);

// ── workspace_symbols ─────────────────────────────────────────────────────────
server.registerTool(
  'workspace_symbols',
  {
    description:
      "Search VS Code's workspace symbol index (LSP-backed). " +
      'Returns symbols matching the query across all open workspace folders. ' +
      'Great for finding class names, function definitions, interfaces, and exports by name or prefix.',
    inputSchema: {
      query: z.string().describe(
        'Symbol name or prefix to search for (e.g. "useAuth", "AssetGrid", "ITokenProvider")'
      ),
    },
  },
  async ({ query }) => {
    try {
      type Symbol = { name: string; kind: string; container: string; file: string; line: number };
      const symbols = await bridgeGet<Symbol[]>(`/symbols?q=${encodeURIComponent(query)}`);
      if (symbols.length === 0) {
        return { content: [{ type: 'text', text: `No symbols found matching "${query}".` }] };
      }
      const lines = symbols.map(s => {
        const container = s.container ? `${s.container}.` : '';
        return `[${s.kind}] ${container}${s.name}  →  ${s.file}:${s.line}`;
      });
      return { content: [{ type: 'text', text: `Found ${symbols.length} symbol(s):\n\n${lines.join('\n')}` }] };
    } catch (e) { return errResult(e); }
  }
);

// ── find_files ────────────────────────────────────────────────────────────────
server.registerTool(
  'find_files',
  {
    description:
      'Find files in the VS Code workspace by glob pattern. ' +
      "Respects VS Code's workspace folders and .gitignore — more accurate than raw filesystem search.",
    inputSchema: {
      pattern: z.string()
        .describe('Glob pattern (e.g. "**/*.test.ts", "src/components/**/*.tsx")')
        .default('**/*'),
      exclude: z.string()
        .describe('Glob pattern to exclude (default: **/node_modules/**)')
        .default('**/node_modules/**'),
    },
  },
  async ({ pattern, exclude }) => {
    try {
      const files = await bridgeGet<string[]>(
        `/files?pattern=${encodeURIComponent(pattern)}&exclude=${encodeURIComponent(exclude)}`
      );
      if (files.length === 0) {
        return { content: [{ type: 'text', text: `No files matched pattern "${pattern}".` }] };
      }
      return { content: [{ type: 'text', text: `Found ${files.length} file(s):\n\n${files.join('\n')}` }] };
    } catch (e) { return errResult(e); }
  }
);

// ── active_editor ─────────────────────────────────────────────────────────────
server.registerTool(
  'active_editor',
  {
    description:
      'Get the currently active file in VS Code — its path, language, dirty state, ' +
      'current text selection (if any), and all open tabs. ' +
      'Use this to understand exactly what the user is looking at.',
  },
  async () => {
    try {
      type Selection = { startLine: number; startCol: number; endLine: number; endCol: number; text: string };
      type ActiveEditor = {
        file: string; language: string; isDirty: boolean; lineCount: number;
        selection: Selection | null; openTabs: string[];
      };
      const data = await bridgeGet<{ activeEditor: ActiveEditor | null }>('/active-editor');
      if (!data.activeEditor) {
        return { content: [{ type: 'text', text: 'No file is currently open in VS Code.' }] };
      }
      const e = data.activeEditor;
      const lines = [
        `File:     ${e.file}`,
        `Language: ${e.language}`,
        `Lines:    ${e.lineCount}${e.isDirty ? '  ⚠ unsaved changes' : ''}`,
      ];
      if (e.selection) {
        const s = e.selection;
        lines.push(`\nSelection (${s.startLine}:${s.startCol} – ${s.endLine}:${s.endCol}):`);
        lines.push('```', s.text, '```');
      }
      if (e.openTabs.length > 0) {
        lines.push(`\nOpen tabs (${e.openTabs.length}):`);
        e.openTabs.forEach(f => lines.push(`  ${f}`));
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) { return errResult(e); }
  }
);

// ── diagnostics ───────────────────────────────────────────────────────────────
server.registerTool(
  'diagnostics',
  {
    description:
      "Get errors and warnings from VS Code's Problems panel, powered by TypeScript, ESLint, and other language servers. " +
      'Omit `file` to get all diagnostics across the workspace.',
    inputSchema: {
      file: z.string()
        .describe('Absolute path to a specific file (omit to get all workspace diagnostics)')
        .optional(),
    },
  },
  async ({ file }) => {
    try {
      type Diag = {
        file: string; severity: string; message: string; source: string; code: string;
        startLine: number; startCol: number; endLine: number; endCol: number;
      };
      const diags = await bridgeGet<Diag[]>(
        '/diagnostics' + (file ? `?file=${encodeURIComponent(file)}` : '')
      );
      if (diags.length === 0) {
        return { content: [{ type: 'text', text: file ? `No diagnostics for ${file}.` : 'No diagnostics in workspace.' }] };
      }
      const errors = diags.filter(d => d.severity === 'Error').length;
      const warnings = diags.filter(d => d.severity === 'Warning').length;
      const lines = [`${diags.length} diagnostic(s): ${errors} error(s), ${warnings} warning(s)\n`];
      for (const d of diags) {
        const src = d.source ? `[${d.source}${d.code ? ` ${d.code}` : ''}] ` : '';
        lines.push(`${d.severity.toUpperCase()}  ${src}${d.message}`);
        lines.push(`  → ${d.file}:${d.startLine}:${d.startCol}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) { return errResult(e); }
  }
);

// ── definition ────────────────────────────────────────────────────────────────
server.registerTool(
  'definition',
  {
    description:
      "Go-to-definition via VS Code's LSP. Given a file and cursor position, returns where the symbol is defined. " +
      'More accurate than grep — resolves across packages, type aliases, and re-exports.',
    inputSchema: {
      file: z.string().describe('Absolute path to the source file'),
      line: z.number().int().min(1).describe('1-based line number'),
      col: z.number().int().min(1).describe('1-based column number'),
    },
  },
  async ({ file, line, col }) => {
    try {
      type Loc = { file: string; startLine: number; startCol: number; endLine: number; endCol: number };
      const locs = await bridgeGet<Loc[]>(
        `/definition?file=${encodeURIComponent(file)}&line=${line}&col=${col}`
      );
      if (locs.length === 0) {
        return { content: [{ type: 'text', text: `No definition found at ${file}:${line}:${col}.` }] };
      }
      const lines = locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`);
      return { content: [{ type: 'text', text: `Definition(s):\n\n${lines.join('\n')}` }] };
    } catch (e) { return errResult(e); }
  }
);

// ── references ────────────────────────────────────────────────────────────────
server.registerTool(
  'references',
  {
    description:
      "Find all references to the symbol at a given position via VS Code's LSP. " +
      'More accurate than text search — handles renamed symbols, overloads, and interface implementations.',
    inputSchema: {
      file: z.string().describe('Absolute path to the source file'),
      line: z.number().int().min(1).describe('1-based line number'),
      col: z.number().int().min(1).describe('1-based column number'),
    },
  },
  async ({ file, line, col }) => {
    try {
      type Ref = { file: string; line: number; col: number };
      const locs = await bridgeGet<Ref[]>(
        `/references?file=${encodeURIComponent(file)}&line=${line}&col=${col}`
      );
      if (locs.length === 0) {
        return { content: [{ type: 'text', text: `No references found at ${file}:${line}:${col}.` }] };
      }
      const lines = locs.map(l => `${l.file}:${l.line}:${l.col}`);
      return { content: [{ type: 'text', text: `Found ${locs.length} reference(s):\n\n${lines.join('\n')}` }] };
    } catch (e) { return errResult(e); }
  }
);

// ── text_search ───────────────────────────────────────────────────────────────
server.registerTool(
  'text_search',
  {
    description:
      "Full-text search across the VS Code workspace. Respects .gitignore and VS Code's file exclude settings. " +
      'Supports both literal strings and regular expressions. Returns file path, line, and a preview snippet.',
    inputSchema: {
      query: z.string().describe('Text or regular expression to search for'),
      include: z.string().describe('Glob to limit scope, e.g. "**/*.ts"').optional(),
      exclude: z.string().describe('Glob to exclude, e.g. "**/dist/**"').optional(),
      regex: z.boolean().describe('Treat query as a regular expression (default: false)').default(false),
      maxResults: z.number().int().min(1).max(500).describe('Maximum results to return (default: 100)').default(100),
    },
  },
  async ({ query, include, exclude, regex, maxResults }) => {
    try {
      const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
      if (include) params.set('include', include);
      if (exclude) params.set('exclude', exclude);
      if (regex) params.set('regex', '1');
      type Result = { file: string; line: number; col: number; preview: string };
      const results = await bridgeGet<Result[]>(`/search?${params}`);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No results found for "${query}".` }] };
      }
      const lines = results.map(r => `${r.file}:${r.line}:${r.col}  ${r.preview}`);
      return { content: [{ type: 'text', text: `Found ${results.length} result(s):\n\n${lines.join('\n')}` }] };
    } catch (e) { return errResult(e); }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
