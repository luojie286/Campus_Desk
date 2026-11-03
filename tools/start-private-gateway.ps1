$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskPrivate = Join-Path $taskRoot '.private'
$taskPidFile = Join-Path $taskPrivate 'private-gateway.pid'
$taskListeners = @(Get-NetTCPConnection -LocalPort 9090 -State Listen -ErrorAction SilentlyContinue)
if ($taskListeners.Count -gt 0) { throw 'Port 9090 is in use; inspect the existing listener first.' }
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskScript = Join-Path $taskRoot 'tools\private-network.cjs'
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList ('"' + $taskScript + '"'), 'serve' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskPrivate 'private-gateway.stdout.log') -RedirectStandardError (Join-Path $taskPrivate 'private-gateway.stderr.log')
Set-Content -LiteralPath $taskPidFile -Value $taskProcess.Id -Encoding ascii
for ($taskAttempt = 0; $taskAttempt -lt 20; $taskAttempt++) {
    Start-Sleep -Milliseconds 150
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) { throw 'Gateway exited; inspect .private/private-gateway.stderr.log locally.' }
    try {
        $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:9090/health' -TimeoutSec 1
        if ($taskHealth.service -eq 'mobile-gateway') { Write-Output 'Gateway ready on loopback. HTTPS requires Tailscale Serve setup.'; return }
    } catch { }
}
throw 'Gateway readiness not confirmed; inspect the private logs.'
