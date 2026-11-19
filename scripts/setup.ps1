$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot '.local') | Out-Null
npm install
npm run build
Set-Location (Join-Path $ProjectRoot 'vscode-extension')
npm install
npm run build
npm run package
Write-Host 'AI Dev Bridge setup complete. Run scripts/start-bridge.ps1 to start the local service.'
