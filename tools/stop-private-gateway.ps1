$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskPidFile = Join-Path $taskRoot '.private\private-gateway.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Output 'No gateway PID record.'; return }
$taskProcessId = [int](Get-Content -LiteralPath $taskPidFile -Raw)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $taskProcessId"
if ($null -eq $taskProcess) { Write-Output 'Recorded gateway is not running.'; return }
# PID 可能已被系统复用；必须同时核对本项目的完整脚本路径和 Node 进程名。
$taskScript = Join-Path $taskRoot 'tools\private-network.cjs'
if ($taskProcess.Name -ne 'node.exe' -or -not $taskProcess.CommandLine.Contains($taskScript) -or $taskProcess.CommandLine -notmatch '\bserve\b') {
    throw 'PID does not match this project gateway; no process was stopped.'
}
Stop-Process -Id $taskProcessId
Remove-Item -LiteralPath $taskPidFile
Write-Output 'Only this project gateway was stopped. Business backend and Tailscale were kept running.'
