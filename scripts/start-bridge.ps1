$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
if (-not (Test-Path (Join-Path $ProjectRoot 'dist/server.js'))) { npm run build }
$pidFile = Join-Path $ProjectRoot '.local/bridge.pid'
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) { Write-Host "Bridge already running with PID $oldPid"; exit 0 }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
$process = Start-Process -FilePath 'node' -ArgumentList 'dist/server.js' -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath $pidFile
Write-Host "Bridge started at http://127.0.0.1:3000 (PID $($process.Id))"
