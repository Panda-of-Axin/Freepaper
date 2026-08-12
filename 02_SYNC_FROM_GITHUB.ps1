$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.git')) {
  Write-Host 'ERROR: .git is missing. Run 00_FIRST_SETUP.bat first.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host '=== Freepaper safe sync from GitHub ===' -ForegroundColor Cyan

$dirty = git status --porcelain
if ($dirty) {
  Write-Host 'Local changes exist. Sync stopped to avoid mixing remote and local edits.' -ForegroundColor Yellow
  git status --short
  Write-Host ''
  Write-Host 'Commit/push your work first, or handle it manually in Git.'
  Read-Host 'Press Enter to close'
  exit 2
}

git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }

git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed' }

npm run verify
if ($LASTEXITCODE -ne 0) { throw 'npm run verify failed after sync' }

Write-Host ''
Write-Host 'SYNC COMPLETE. Local main matches GitHub main.' -ForegroundColor Green
Read-Host 'Press Enter to close'
