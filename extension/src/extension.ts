/**
 * Claude Code Workspace Bridge — VS Code Extension
 *
 * On activation:
 *   1. Starts a local HTTP server exposing VS Code workspace intelligence.
 *   2. Syncs the bundled MCP server to a stable path (~/.claude-code-workspace/).
 *   3. Auto-configures ~/.claude.json so Claude Code picks it up immediately.
 */

import * as http from 'http';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_NAME = 'Claude Code Workspace';
const MCP_KEY = 'vscode-workspace';
/** Stable directory written outside the extension so the path survives updates. */
const STABLE_DIR = path.join(os.homedir(), '.claude-code-workspace');
const STABLE_SERVER = path.join(STABLE_DIR, 'mcp-server.mjs');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

// ─── Config helpers ───────────────────────────────────────────────────────────

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('claudeCodeWorkspace').get<T>(key) as T;
}

function getPort(): number {
  return cfg<number>('port') || 29837;
}

function resolveClaude(): string | null {
  const configured = (cfg<string>('claudePath') ?? '').trim();
  if (configured) return configured;

  const candidates: string[] = [];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    candidates.push(path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude'));
  }
  candidates.push(
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  );

  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* skip */ }
  }
  return null;
}

// ─── ~/.claude.json helpers ───────────────────────────────────────────────────

type ClaudeConfig = {
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  [key: string]: unknown;
};

async function readClaudeJson(): Promise<ClaudeConfig> {
  try {
    return JSON.parse(await fs.promises.readFile(CLAUDE_JSON, 'utf8')) as ClaudeConfig;
  } catch {
    return {};
  }
}

async function writeClaudeJson(config: ClaudeConfig): Promise<void> {
  await fs.promises.writeFile(CLAUDE_JSON, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function isAlreadyConfigured(config: ClaudeConfig, port: number): boolean {
  const entry = config.mcpServers?.[MCP_KEY];
  if (!entry) return false;
  const argPath = entry.args?.[0];
  const portMatch = entry.env?.['VSCODE_BRIDGE_PORT'] === String(port);
  return argPath === STABLE_SERVER && portMatch;
}

// ─── MCP server sync ──────────────────────────────────────────────────────────

async function syncMcpServer(context: vscode.ExtensionContext): Promise<void> {
  const bundled = path.join(context.extensionPath, 'dist', 'mcp-server.mjs');
  await fs.promises.mkdir(STABLE_DIR, { recursive: true });
  await fs.promises.copyFile(bundled, STABLE_SERVER);
}

// ─── Configure / unconfigure ──────────────────────────────────────────────────

async function configureClaude(port: number): Promise<void> {
  const config = await readClaudeJson();
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[MCP_KEY] = {
    command: 'node',
    args: [STABLE_SERVER],
    env: { VSCODE_BRIDGE_PORT: String(port) },
  };
  await writeClaudeJson(config);
}

async function unconfigureClaude(): Promise<void> {
  const config = await readClaudeJson();
  if (config.mcpServers?.[MCP_KEY]) {
    delete config.mcpServers[MCP_KEY];
    await writeClaudeJson(config);
  }
}

// ─── HTTP bridge ──────────────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '127.0.0.1' });
  res.end(JSON.stringify(data));
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${getPort()}`);

  if (url.pathname === '/health') {
    jsonResponse(res, {
      ok: true,
      version: '0.1.0',
      workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      activeFile: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
    });
    return;
  }

  if (url.pathname === '/symbols') {
    const q = url.searchParams.get('q') ?? '';
    try {
      const raw = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', q);
      const limit = cfg<number>('maxSymbols') || 100;
      const symbols = (raw ?? []).slice(0, limit).map(s => ({
        name: s.name,
        kind: vscode.SymbolKind[s.kind] ?? String(s.kind),
        container: s.containerName || '',
        file: s.location.uri.fsPath,
        line: s.location.range.start.line + 1,
      }));
      jsonResponse(res, symbols);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/files') {
    const pattern = url.searchParams.get('pattern') ?? '**/*';
    const exclude = url.searchParams.get('exclude') ?? '**/node_modules/**';
    const limit = cfg<number>('maxFiles') || 200;
    try {
      const uris = await vscode.workspace.findFiles(pattern, exclude, limit);
      jsonResponse(res, uris.map(u => u.fsPath));
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/active-editor') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { jsonResponse(res, { activeEditor: null }); return; }
    const doc = editor.document;
    const sel = editor.selection;
    jsonResponse(res, {
      activeEditor: {
        file: doc.uri.fsPath,
        language: doc.languageId,
        isDirty: doc.isDirty,
        lineCount: doc.lineCount,
        selection: sel.isEmpty ? null : {
          startLine: sel.start.line + 1, startCol: sel.start.character + 1,
          endLine: sel.end.line + 1, endCol: sel.end.character + 1,
          text: doc.getText(sel),
        },
        openTabs: vscode.window.tabGroups.all
          .flatMap(g => g.tabs)
          .map(t => (t.input as { uri?: vscode.Uri })?.uri?.fsPath)
          .filter((p): p is string => Boolean(p)),
      },
    });
    return;
  }

  if (url.pathname === '/diagnostics') {
    const file = url.searchParams.get('file');
    try {
      type DiagRow = { file: string; severity: string; message: string; source: string; code: string; startLine: number; startCol: number; endLine: number; endCol: number };
      const toRow = (uri: vscode.Uri, d: vscode.Diagnostic): DiagRow => ({
        file: uri.fsPath,
        severity: (['Error', 'Warning', 'Information', 'Hint'] as const)[d.severity] ?? String(d.severity),
        message: d.message,
        source: d.source ?? '',
        code: d.code != null ? (typeof d.code === 'object' ? String(d.code.value) : String(d.code)) : '',
        startLine: d.range.start.line + 1, startCol: d.range.start.character + 1,
        endLine: d.range.end.line + 1, endCol: d.range.end.character + 1,
      });
      const rows = file
        ? vscode.languages.getDiagnostics(vscode.Uri.file(file)).map(d => toRow(vscode.Uri.file(file), d))
        : vscode.languages.getDiagnostics().flatMap(([uri, ds]) => ds.map(d => toRow(uri, d)));
      jsonResponse(res, rows);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/definition') {
    const file = url.searchParams.get('file');
    if (!file) { jsonResponse(res, { error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col = Math.max(0, parseInt(url.searchParams.get('col') ?? '1', 10) - 1);
    try {
      const raw = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider', vscode.Uri.file(file), new vscode.Position(line, col)
      );
      const locs = (raw ?? []).map(l => {
        const { uri, range } = 'targetUri' in l ? { uri: l.targetUri, range: l.targetRange } : l;
        return { file: uri.fsPath, startLine: range.start.line + 1, startCol: range.start.character + 1, endLine: range.end.line + 1, endCol: range.end.character + 1 };
      });
      jsonResponse(res, locs);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/references') {
    const file = url.searchParams.get('file');
    if (!file) { jsonResponse(res, { error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col = Math.max(0, parseInt(url.searchParams.get('col') ?? '1', 10) - 1);
    const limit = cfg<number>('maxReferences') || 200;
    try {
      const raw = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', vscode.Uri.file(file), new vscode.Position(line, col)
      );
      const locs = (raw ?? []).slice(0, limit).map(l => ({ file: l.uri.fsPath, line: l.range.start.line + 1, col: l.range.start.character + 1 }));
      jsonResponse(res, locs);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/search') {
    const q = url.searchParams.get('q');
    if (!q) { jsonResponse(res, { error: 'q param required' }, 400); return; }
    const maxResults = Math.min(parseInt(url.searchParams.get('maxResults') ?? '100', 10), cfg<number>('maxSearchResults') || 100);
    try {
      const results: { file: string; line: number; col: number; preview: string }[] = [];
      type TextMatch = { uri: vscode.Uri; ranges: vscode.Range[]; preview: { text: string } };
      const findTextInFiles = (vscode.workspace as unknown as {
        findTextInFiles(query: object, options: object, callback: (m: TextMatch) => void): Thenable<void>;
      }).findTextInFiles;
      await findTextInFiles(
        { pattern: q, isRegExp: url.searchParams.get('regex') === '1' },
        { include: url.searchParams.get('include') ?? undefined, exclude: url.searchParams.get('exclude') ?? undefined, maxResults },
        (m: TextMatch) => results.push({ file: m.uri.fsPath, line: (m.ranges[0]?.start.line ?? 0) + 1, col: (m.ranges[0]?.start.character ?? 0) + 1, preview: m.preview.text.trim() })
      );
      jsonResponse(res, results);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  jsonResponse(res, { error: 'Not found' }, 404);
}

// ─── Chat participant ─────────────────────────────────────────────────────────

function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant('claude-code-workspace.claude', async (request, _ctx, stream, token) => {
    const claudeBin = resolveClaude();
    if (!claudeBin) {
      stream.markdown('**Claude Code not found.** Set `claudeCodeWorkspace.claudePath` in Settings to the path of the `claude` CLI.');
      return;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    stream.markdown('_Asking Claude Code…_\n\n');
    await new Promise<void>((resolve, reject) => {
      const proc = cp.spawn(claudeBin, ['--print', '--output-format', 'stream-json', '--no-color', request.prompt], { cwd, env: process.env });
      let buf = '';
      const flush = (t: string) => { if (t) stream.markdown(t); };
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg['type'] === 'assistant') {
              for (const b of (msg['message'] as Record<string, unknown[]>)?.['content'] ?? []) {
                const block = b as Record<string, unknown>;
                if (block['type'] === 'text') flush(String(block['text']));
              }
            } else if (msg['type'] === 'text') flush(String(msg['text']));
            else if (msg['type'] === 'result' && msg['result']) flush(String(msg['result']));
          } catch { flush(line + '\n'); }
        }
      });
      proc.stderr.on('data', (c: Buffer) => console.error('[Claude Code Workspace]', c.toString()));
      proc.on('close', code => { if (buf.trim()) flush(buf); code === 0 ? resolve() : reject(new Error(`claude exited ${code}`)); });
      proc.on('error', reject);
      token.onCancellationRequested(() => { proc.kill(); reject(new Error('Cancelled')); });
    }).catch(e => { if ((e as Error).message !== 'Cancelled') stream.markdown(`\n\n> **Error:** ${(e as Error).message}`); });
  });
  participant.iconPath = new vscode.ThemeIcon('robot');
  context.subscriptions.push(participant);
}

// ─── Bridge server ────────────────────────────────────────────────────────────

let bridgeServer: http.Server | undefined;
let statusBar: vscode.StatusBarItem | undefined;

function setStatus(text: string, tooltip: string, isError = false): void {
  if (!statusBar) return;
  statusBar.text = text;
  statusBar.tooltip = tooltip;
  statusBar.backgroundColor = isError ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

function startBridgeServer(context: vscode.ExtensionContext): void {
  const port = getPort();
  bridgeServer = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      console.error('[Claude Code Workspace]', e);
    });
  });
  bridgeServer.listen(port, '127.0.0.1', () => {
    setStatus('$(plug) Claude Bridge', `Claude Code Workspace bridge active on port ${port}`);
  });
  bridgeServer.on('error', (err: NodeJS.ErrnoException) => {
    const msg = err.code === 'EADDRINUSE'
      ? `Port ${port} already in use — another instance may be running, or change the port in Settings.`
      : `Bridge error: ${err.message}`;
    setStatus('$(warning) Claude Bridge', msg, true);
    vscode.window.showWarningMessage(`${EXT_NAME}: ${msg}`);
  });
  context.subscriptions.push({ dispose: () => bridgeServer?.close() });
}

// ─── First-run setup ──────────────────────────────────────────────────────────

async function promptSetup(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `${EXT_NAME}: Configure Claude Code to use VS Code's workspace intelligence?`,
    'Set Up', 'Not Now'
  );
  if (choice !== 'Set Up') return;

  await configureClaude(getPort());
  const restart = await vscode.window.showInformationMessage(
    `${EXT_NAME}: All set! Restart Claude Code to activate the workspace bridge.`,
    'OK'
  );
  void restart;
}

// ─── Activation ───────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Status bar
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(loading~spin) Claude Bridge';
  statusBar.tooltip = `${EXT_NAME} starting…`;
  statusBar.command = 'claudeCodeWorkspace.configure';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Sync bundled MCP server to stable path (runs on every activation, so updates auto-propagate)
  try {
    await syncMcpServer(context);
  } catch (e) {
    console.error('[Claude Code Workspace] Failed to sync MCP server:', e);
  }

  // Start HTTP bridge
  startBridgeServer(context);

  // Register chat participant
  registerChatParticipant(context);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeWorkspace.configure', async () => {
      await configureClaude(getPort());
      vscode.window.showInformationMessage(`${EXT_NAME}: Claude Code configured. Restart Claude Code to apply.`);
    }),
    vscode.commands.registerCommand('claudeCodeWorkspace.unconfigure', async () => {
      await unconfigureClaude();
      vscode.window.showInformationMessage(`${EXT_NAME}: Removed from Claude Code configuration.`);
    }),
  );

  // Restart bridge when port changes; re-configure claude.json with new port
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('claudeCodeWorkspace.port')) {
        bridgeServer?.close(() => startBridgeServer(context));
        const config = await readClaudeJson();
        if (config.mcpServers?.[MCP_KEY]) await configureClaude(getPort());
      }
    })
  );

  // First-run: prompt if not yet configured
  const config = await readClaudeJson();
  if (!isAlreadyConfigured(config, getPort())) {
    await promptSetup();
  }
}

export function deactivate(): void {
  bridgeServer?.close();
  statusBar?.dispose();
}
