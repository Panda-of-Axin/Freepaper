$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.git')) {
  Write-Host 'ERROR: .git is missing. Run 00_FIRST_SETUP.bat first.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host '=== Freepaper release helper ===' -ForegroundColor Cyan
Write-Host 'Use this only when you really want to publish a new version.' -ForegroundColor Yellow
Write-Host ''

$dirty = git status --porcelain
if ($dirty) {
  Write-Host 'Working tree is not clean. Commit/push normal development changes first.' -ForegroundColor Red
  git status --short
  Read-Host 'Press Enter to close'
  exit 2
}

# Always start from current remote main.
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }

$version = Read-Host 'Version to release, e.g. 2.0.6'
$version = $version.Trim().TrimStart('v')
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Host 'Invalid version. Expected X.Y.Z, e.g. 2.0.6.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 3
}

Write-Host ''
Write-Host "Before continuing, CHANGELOG.md must already contain a non-empty '## $version' section." -ForegroundColor Yellow
$answer = Read-Host "Prepare and publish v$version? (y/N)"
if ($answer -notmatch '^[Yy]$') {
  Write-Host 'Cancelled.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit 0
}

npm run release -- $version
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Release preparation failed. Nothing will be committed/tagged.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 4
}

Write-Host ''
Write-Host 'Generated release files:' -ForegroundColor Cyan
Get-ChildItem -Path dist -File | Select-Object Name, Length | Format-Table -AutoSize

$confirm = Read-Host "Verification/package succeeded. Commit, push main, create tag v$version, and push the tag? (y/N)"
if ($confirm -notmatch '^[Yy]$') {
  Write-Host 'Stopped before commit/tag. Review the working tree manually.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit 0
}

$tag = "v$version"
$localTag = git tag --list $tag
if ($localTag) { throw "Local tag $tag already exists." }
$remoteTag = git ls-remote --tags origin "refs/tags/$tag"
if ($remoteTag) { throw "Remote tag $tag already exists." }

git add -A
git commit -m "release: Freepaper v$version"
if ($LASTEXITCODE -ne 0) { throw 'release commit failed' }

git push origin main
if ($LASTEXITCODE -ne 0) { throw 'push main failed' }

git tag $tag
git push origin $tag
if ($LASTEXITCODE -ne 0) { throw 'push tag failed' }

Write-Host ''
Write-Host "RELEASE TRIGGERED: $tag" -ForegroundColor Green
Write-Host 'GitHub Actions will verify, package Chrome/Edge ZIPs, compute SHA256, and create/update the GitHub Release.'
Read-Host 'Press Enter to close'
