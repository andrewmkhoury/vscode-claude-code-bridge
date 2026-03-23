# Claude Code Workspace Bridge — one-command installer for Windows (PowerShell)
# Run: irm https://raw.githubusercontent.com/andrewmkhoury/vscode-claude-code-bridge/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "andrewmkhoury/vscode-claude-code-bridge"

function Write-Info    { Write-Host "[Claude Code Workspace] $args" -ForegroundColor Cyan }
function Write-Success { Write-Host "[Claude Code Workspace] $args" -ForegroundColor Green }
function Write-Fail    { Write-Host "[Claude Code Workspace] ERROR: $args" -ForegroundColor Red; exit 1 }

# ── Detect editor ─────────────────────────────────────────────────────────────
$EditorCmd = $null
foreach ($cmd in @("code", "cursor")) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { $EditorCmd = $cmd; break }
}
if (-not $EditorCmd) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $EditorCmd = $c; break } }
}
if (-not $EditorCmd) {
  Write-Fail "VS Code or Cursor not found in PATH. Install from https://code.visualstudio.com or https://cursor.com"
}

# ── Fetch latest release ──────────────────────────────────────────────────────
Write-Info "Fetching latest release from github.com/$Repo…"
$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Tag     = $Release.tag_name
$Version = $Tag -replace '^v', ''
$VsixUrl = "https://github.com/$Repo/releases/download/$Tag/claude-code-workspace-$Version.vsix"

# ── Download ──────────────────────────────────────────────────────────────────
$TmpFile = [System.IO.Path]::GetTempFileName() + ".vsix"
Write-Info "Downloading claude-code-workspace-$Version.vsix…"
Invoke-WebRequest -Uri $VsixUrl -OutFile $TmpFile -UseBasicParsing

# ── Install ───────────────────────────────────────────────────────────────────
Write-Info "Installing extension via: $EditorCmd"
& $EditorCmd --install-extension $TmpFile --force
Remove-Item $TmpFile -Force

Write-Success "Installed claude-code-workspace $Version!"
Write-Host ""
Write-Host "  Next steps:"
Write-Host "  1. Restart VS Code / Cursor"
Write-Host "  2. Click 'Set Up' in the prompt — this configures Claude Code automatically"
Write-Host "  3. Restart Claude Code"
Write-Host ""
Write-Host "  Or run from the Command Palette: > Claude Code Workspace: Configure Claude Code"
