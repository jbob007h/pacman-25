# Deploys the Maze Royale game server to Fly.io.
# Safe to run again: it reuses the app it created the first time (saved in .fly-app).
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
Start-Transcript -Path (Join-Path $PSScriptRoot 'deploy-log.txt') -Force | Out-Null

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) {
  Write-Host ""; Write-Host "DEPLOY FAILED: $msg" -ForegroundColor Red
  Stop-Transcript | Out-Null
  Read-Host "Press Enter to close"
  exit 1
}

# 1. Fly's command-line tool
$flyBin = Join-Path $env:USERPROFILE '.fly\bin'
$env:Path = "$flyBin;$env:Path"
if (-not (Get-Command flyctl -ErrorAction SilentlyContinue)) {
  Step "Installing the Fly command-line tool (flyctl)"
  Invoke-WebRequest https://fly.io/install.ps1 -UseBasicParsing | Invoke-Expression
  $env:Path = "$flyBin;$env:Path"
  if (-not (Get-Command flyctl -ErrorAction SilentlyContinue)) { Fail "flyctl didn't install." }
}
flyctl version

# 2. Sign in (opens your browser if this computer isn't signed in yet)
Step "Checking your Fly sign-in"
flyctl auth whoami
if ($LASTEXITCODE -ne 0) {
  Write-Host "Your browser will open: click Continue / Authorize there, then come back." -ForegroundColor Yellow
  flyctl auth login
  flyctl auth whoami
  if ($LASTEXITCODE -ne 0) { Fail "Not signed in to Fly." }
}

# 3. The app (one per game server)
$appFile = Join-Path $PSScriptRoot '.fly-app'
$app = if (Test-Path $appFile) { (Get-Content $appFile -Raw).Trim() } else { $null }
if (-not $app) {
  $suffix = -join ((97..122) + (48..57) | Get-Random -Count 5 | ForEach-Object { [char]$_ })
  $app = "maze-royale-$suffix"
  Step "Creating the Fly app $app"
  flyctl apps create $app
  if ($LASTEXITCODE -ne 0) { Fail "Couldn't create the app (see above)." }
  Set-Content -Path $appFile -Value $app
}

# 4. Build on Fly's servers and start exactly one machine (matches live in its memory)
Step "Building and deploying $app (takes a few minutes the first time)"
flyctl deploy --app $app --ha=false --remote-only
if ($LASTEXITCODE -ne 0) { Fail "The deploy didn't finish (see above)." }

Step "Status"
flyctl status --app $app

$url = "https://$app.fly.dev"
Write-Host ""
Write-Host "DEPLOYED: $url" -ForegroundColor Green
Stop-Transcript | Out-Null
Start-Process $url
Read-Host "Press Enter to close"
