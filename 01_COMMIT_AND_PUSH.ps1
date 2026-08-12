$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.git')) {
  Write-Host 'ERROR: .git is missing. Run 00_FIRST_SETUP.bat first.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host '=== Freepaper commit and push ===' -ForegroundColor Cyan

git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }

Write-Host ''
Write-Host 'Current changes:' -ForegroundColor Cyan
git status --short

$dirty = git status --porcelain
if (-not $dirty) {
  Write-Host 'Nothing to commit.' -ForegroundColor Green
  Read-Host 'Press Enter to close'
  exit 0
}

$defaultMessage = 'chore: automate release workflow and clean repository docs'
$message = Read-Host "Commit message [$defaultMessage]"
if ([string]::IsNullOrWhiteSpace($message)) { $message = $defaultMessage }

git add -A
Write-Host ''
Write-Host 'Staged summary:' -ForegroundColor Cyan
git diff --cached --stat

$answer = Read-Host 'Commit and push these changes to origin/main? (y/N)'
if ($answer -notmatch '^[Yy]$') {
  Write-Host 'Cancelled. Nothing was pushed.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit 0
}

git commit -m $message
if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }

git push origin main
if ($LASTEXITCODE -ne 0) { throw 'git push failed' }

Write-Host ''
Write-Host 'PUSH COMPLETE.' -ForegroundColor Green
git status --short
Read-Host 'Press Enter to close'
