$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $ProjectRoot '.local/bridge.pid'
if (-not (Test-Path $pidFile)) { Write-Host 'Bridge is not running.'; exit 0 }
$bridgePid = [int](Get-Content $pidFile)
$process = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
if ($process) { Stop-Process -Id $bridgePid -Force; Write-Host "Bridge stopped (PID $bridgePid)." }
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
