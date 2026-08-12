$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$RepoUrl = 'https://github.com/Panda-of-Axin/Freepaper.git'

function Require-Command($Name, $Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: '$Name' was not found." -ForegroundColor Red
    Write-Host $Hint -ForegroundColor Yellow
    exit 1
  }
}

Write-Host '=== Freepaper first-time local workspace setup ===' -ForegroundColor Cyan
Write-Host "Folder: $PSScriptRoot"
Write-Host "Remote: $RepoUrl"
Write-Host ''

Require-Command 'git' 'Install Git for Windows first, then run this file again.'
Require-Command 'node' 'Install Node.js 20 or later first, then run this file again.'
Require-Command 'npm' 'npm normally comes with Node.js.'

if (-not (Test-Path '.git')) {
  Write-Host '[1/5] Creating local Git metadata...' -ForegroundColor Cyan
  git init
  if ($LASTEXITCODE -ne 0) { throw 'git init failed' }

  git branch -M main
  git remote add origin $RepoUrl

  Write-Host '[2/5] Fetching the real GitHub main branch...' -ForegroundColor Cyan
  git fetch origin main
  if ($LASTEXITCODE -ne 0) { throw 'git fetch origin main failed' }

  # Important: mixed reset anchors this existing populated folder to origin/main
  # without overwriting the prepared local files in the working tree.
  Write-Host '[3/5] Linking this folder to origin/main without overwriting prepared files...' -ForegroundColor Cyan
  git reset --mixed origin/main
  if ($LASTEXITCODE -ne 0) { throw 'git reset --mixed origin/main failed' }
} else {
  Write-Host '[1/5] Existing .git folder detected.' -ForegroundColor Green
  $origin = (git remote get-url origin 2>$null)
  if ($LASTEXITCODE -ne 0) {
    git remote add origin $RepoUrl
  } elseif ($origin -ne $RepoUrl) {
    Write-Host "Updating origin from '$origin' to '$RepoUrl'..." -ForegroundColor Yellow
    git remote set-url origin $RepoUrl
  }

  Write-Host '[2/5] Fetching origin/main...' -ForegroundColor Cyan
  git fetch origin main
  if ($LASTEXITCODE -ne 0) { throw 'git fetch origin main failed' }
}

Write-Host '[4/5] Current Git status:' -ForegroundColor Cyan
git status --short

Write-Host ''
Write-Host '[5/5] Running Freepaper verification...' -ForegroundColor Cyan
npm run verify
if ($LASTEXITCODE -ne 0) { throw 'npm run verify failed' }

Write-Host ''
Write-Host 'SETUP COMPLETE.' -ForegroundColor Green
Write-Host 'This folder is now your permanent Freepaper working directory.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next step:' -ForegroundColor Cyan
Write-Host '  Double-click 01_COMMIT_AND_PUSH.bat to publish the prepared automation/cleanup changes.'
Write-Host ''
Write-Host 'Later workflow:' -ForegroundColor Cyan
Write-Host '  02_SYNC_FROM_GITHUB.bat   -> pull latest main safely'
Write-Host '  03_OPEN_TERMINAL_HERE.bat -> open terminal in this folder'
Write-Host '  04_RELEASE_VERSION.bat    -> prepare/commit/tag/push a real release'
Write-Host ''
Read-Host 'Press Enter to close'
