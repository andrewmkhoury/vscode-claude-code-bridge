/**
 * Claude Code Workspace Bridge — VS Code Extension
 *
 * Starts a local HTTP server that exposes VS Code workspace intelligence
 * (symbols, diagnostics, references, definitions, text search, active editor)
 * so the companion MCP server can feed them to Claude Code.
 */

import * as http from 'http';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

// ─── Config helpers ──────────────────────────────────────────────────────────

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('claudeCodeWorkspace').get<T>(key) as T;
}

function getPort(): number {
  return cfg<number>('port') || 29837;
}

/** Resolve the claude CLI path from settings or auto-detect. */
function resolveClaude(): string | null {
  const configured = cfg<string>('claudePath').trim();
  if (configured) return configured;

  const candidates = [
    path.join(process.env['HOME'] ?? '', '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];

  // Also check $PATH
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    candidates.unshift(path.join(dir, 'claude'));
  }

  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* skip */ }
  }
  return null;
}

// ─── HTTP bridge ─────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '127.0.0.1',
  });
  res.end(JSON.stringify(data));
}

function uriPath(uri: vscode.Uri): string {
  return uri.fsPath;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${getPort()}`);

  // GET /health
  if (url.pathname === '/health') {
    json(res, {
      ok: true,
      version: '0.1.0',
      workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      activeFile: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
    });
    return;
  }

  // GET /symbols?q=<query>
  if (url.pathname === '/symbols') {
    const q = url.searchParams.get('q') ?? '';
    const limit = cfg<number>('maxSymbols') || 100;
    try {
      const raw = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider', q
      );
      const symbols = (raw ?? []).slice(0, limit).map(s => ({
        name: s.name,
        kind: vscode.SymbolKind[s.kind] ?? String(s.kind),
        container: s.containerName || '',
        file: uriPath(s.location.uri),
        line: s.location.range.start.line + 1,
      }));
      json(res, symbols);
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }

  // GET /files?pattern=<glob>&exclude=<glob>
  if (url.pathname === '/files') {
    const pattern = url.searchParams.get('pattern') ?? '**/*';
    const exclude = url.searchParams.get('exclude') ?? '**/node_modules/**';
    const limit = cfg<number>('maxFiles') || 200;
    try {
      const uris = await vscode.workspace.findFiles(pattern, exclude, limit);
      json(res, uris.map(u => u.fsPath));
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }

  // GET /active-editor
  if (url.pathname === '/active-editor') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { json(res, { activeEditor: null }); return; }
    const doc = editor.document;
    const sel = editor.selection;
    json(res, {
      activeEditor: {
        file: doc.uri.fsPath,
        language: doc.languageId,
        isDirty: doc.isDirty,
        lineCount: doc.lineCount,
        selection: sel.isEmpty ? null : {
          startLine: sel.start.line + 1,
          startCol: sel.start.character + 1,
          endLine: sel.end.line + 1,
          endCol: sel.end.character + 1,
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

  // GET /diagnostics?file=<optional>
  if (url.pathname === '/diagnostics') {
    const file = url.searchParams.get('file');
    try {
      type DiagRow = {
        file: string; severity: string; message: string;
        source: string; code: string;
        startLine: number; startCol: number; endLine: number; endCol: number;
      };
      const toRow = (uri: vscode.Uri, d: vscode.Diagnostic): DiagRow => ({
        file: uri.fsPath,
        severity: (['Error', 'Warning', 'Information', 'Hint'] as const)[d.severity] ?? String(d.severity),
        message: d.message,
        source: d.source ?? '',
        code: d.code !== undefined && d.code !== null
          ? (typeof d.code === 'object' ? String(d.code.value) : String(d.code))
          : '',
        startLine: d.range.start.line + 1,
        startCol: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endCol: d.range.end.character + 1,
      });
      let rows: DiagRow[];
      if (file) {
        const uri = vscode.Uri.file(file);
        rows = vscode.languages.getDiagnostics(uri).map(d => toRow(uri, d));
      } else {
        rows = vscode.languages.getDiagnostics().flatMap(([uri, ds]) => ds.map(d => toRow(uri, d)));
      }
      json(res, rows);
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }

  // GET /definition?file=<path>&line=<1-based>&col=<1-based>
  if (url.pathname === '/definition') {
    const file = url.searchParams.get('file');
    if (!file) { json(res, { error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col = Math.max(0, parseInt(url.searchParams.get('col') ?? '1', 10) - 1);
    try {
      const uri = vscode.Uri.file(file);
      const pos = new vscode.Position(line, col);
      const raw = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider', uri, pos
      );
      const locs = (raw ?? []).map(l => {
        const loc = 'targetUri' in l
          ? { uri: l.targetUri, range: l.targetRange }
          : { uri: l.uri, range: l.range };
        return {
          file: uriPath(loc.uri),
          startLine: loc.range.start.line + 1,
          startCol: loc.range.start.character + 1,
          endLine: loc.range.end.line + 1,
          endCol: loc.range.end.character + 1,
        };
      });
      json(res, locs);
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }

  // GET /references?file=<path>&line=<1-based>&col=<1-based>
  if (url.pathname === '/references') {
    const file = url.searchParams.get('file');
    if (!file) { json(res, { error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col = Math.max(0, parseInt(url.searchParams.get('col') ?? '1', 10) - 1);
    const limit = cfg<number>('maxReferences') || 200;
    try {
      const uri = vscode.Uri.file(file);
      const pos = new vscode.Position(line, col);
      const raw = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', uri, pos
      );
      const locs = (raw ?? []).slice(0, limit).map(l => ({
        file: uriPath(l.uri),
        line: l.range.start.line + 1,
        col: l.range.start.character + 1,
      }));
      json(res, locs);
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }

  // GET /search?q=<text>&include=<glob>&exclude=<glob>&regex=1&maxResults=<n>
  if (url.pathname === '/search') {
    const q = url.searchParams.get('q');
    if (!q) { json(res, { error: 'q param required' }, 400); return; }
    const include = url.searchParams.get('include') ?? undefined;
    const exclude = url.searchParams.get('exclude') ?? undefined;
    const isRegex = url.searchParams.get('regex') === '1';
    const maxResults = Math.min(
      parseInt(url.searchParams.get('maxResults') ?? '100', 10),
      cfg<number>('maxSearchResults') || 100
    );
    try {
      const results: { file: string; line: number; col: number; preview: string }[] = [];
      type TextMatch = {
        uri: vscode.Uri;
        ranges: vscode.Range[];
        preview: { text: string };
      };
      // findTextInFiles is available at runtime but removed from @types/vscode 1.91+
      const findTextInFiles = (vscode.workspace as unknown as {
        findTextInFiles(
          query: object,
          options: object,
          callback: (match: TextMatch) => void
        ): Thenable<void>;
      }).findTextInFiles;
      await findTextInFiles(
        { pattern: q, isRegExp: isRegex },
        { include, exclude, maxResults },
        (match: TextMatch) => {
          results.push({
            file: match.uri.fsPath,
            line: (match.ranges[0]?.start.line ?? 0) + 1,
            col: (match.ranges[0]?.start.character ?? 0) + 1,
            preview: match.preview.text.trim(),
          });
        }
      );
      json(res, results);
    } catch (e) { json(res, { error: String(e) }, 500); }
    return;
  }

  json(res, { error: 'Not found' }, 404);
}

// ─── Chat participant ─────────────────────────────────────────────────────────

function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    'claude-code-workspace.claude',
    async (request, _ctx, stream, token) => {
      const claudeBin = resolveClaude();
      if (!claudeBin) {
        stream.markdown(
          '**Claude Code not found.** Set `claudeCodeWorkspace.claudePath` in your VS Code settings to the path of the `claude` CLI.'
        );
        return;
      }

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      stream.markdown('_Asking Claude Code…_\n\n');

      await new Promise<void>((resolve, reject) => {
        const args = ['--print', '--output-format', 'stream-json', '--no-color', request.prompt];
        const proc = child_process.spawn(claudeBin, args, { cwd, env: process.env });
        let buffer = '';

        const flush = (text: string) => { if (text) stream.markdown(text); };

        proc.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (msg['type'] === 'assistant') {
                const content = (msg['message'] as Record<string, unknown>)?.['content'];
                if (Array.isArray(content)) {
                  for (const block of content as Record<string, unknown>[]) {
                    if (block['type'] === 'text') flush(String(block['text']));
                  }
                }
              } else if (msg['type'] === 'text') {
                flush(String(msg['text']));
              } else if (msg['type'] === 'result' && msg['result']) {
                flush(String(msg['result']));
              }
            } catch {
              flush(line + '\n');
            }
          }
        });

        proc.stderr.on('data', (chunk: Buffer) => {
          console.error('[Claude Code Workspace]', chunk.toString());
        });

        proc.on('close', code => {
          if (buffer.trim()) flush(buffer);
          code === 0 ? resolve() : reject(new Error(`claude exited with code ${code}`));
        });

        proc.on('error', reject);
        token.onCancellationRequested(() => { proc.kill(); reject(new Error('Cancelled')); });
      }).catch(e => {
        if ((e as Error).message !== 'Cancelled') {
          stream.markdown(`\n\n> **Error:** ${(e as Error).message}`);
        }
      });
    }
  );

  participant.iconPath = new vscode.ThemeIcon('robot');
  context.subscriptions.push(participant);
}

// ─── Activation ──────────────────────────────────────────────────────────────

let bridgeServer: http.Server | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

function startServer(context: vscode.ExtensionContext): void {
  const port = getPort();

  bridgeServer = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
      console.error('[Claude Code Workspace]', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  bridgeServer.listen(port, '127.0.0.1', () => {
    console.log(`[Claude Code Workspace] Bridge listening on 127.0.0.1:${port}`);
    if (statusBarItem) {
      statusBarItem.text = '$(plug) Claude Bridge';
      statusBarItem.tooltip = `Claude Code Workspace bridge active on port ${port}`;
      statusBarItem.backgroundColor = undefined;
    }
  });

  bridgeServer.on('error', (err: NodeJS.ErrnoException) => {
    console.error('[Claude Code Workspace] Server error:', err.message);
    if (err.code === 'EADDRINUSE') {
      vscode.window.showWarningMessage(
        `Claude Code Workspace: port ${port} is already in use. ` +
        'Another instance may be running, or change the port in settings.'
      );
    } else {
      vscode.window.showErrorMessage(`Claude Code Workspace bridge error: ${err.message}`);
    }
    if (statusBarItem) {
      statusBarItem.text = '$(warning) Claude Bridge';
      statusBarItem.tooltip = `Claude Code Workspace bridge error: ${err.message}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  });

  context.subscriptions.push({ dispose: () => bridgeServer?.close() });
}

export function activate(context: vscode.ExtensionContext): void {
  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(loading~spin) Claude Bridge';
  statusBarItem.tooltip = 'Claude Code Workspace bridge starting…';
  statusBarItem.command = 'workbench.action.openSettings';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  startServer(context);
  registerChatParticipant(context);

  // Restart on port setting change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeCodeWorkspace.port')) {
        bridgeServer?.close(() => startServer(context));
      }
    })
  );
}

export function deactivate(): void {
  bridgeServer?.close();
  statusBarItem?.dispose();
}
