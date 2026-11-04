# Keep this script ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
# Some Chinese comments can then consume the next line during tokenization.
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    throw 'Run this script as a file, for example: powershell.exe -File tools/start-napcat.ps1'
}
$taskRoot = [System.IO.Directory]::GetParent($PSScriptRoot).FullName
$taskVendor = Join-Path $taskRoot '.private/vendor/napcat-4.18.41'
$taskLauncher = Join-Path $taskVendor 'NapCatWinBootMain.exe'
$taskQQ = 'D:\QQ.exe'
$taskPatch = Join-Path $taskVendor 'qqnt.json'
$taskLoad = Join-Path $taskVendor 'loadNapCat.js'
$taskInject = Join-Path $taskVendor 'NapCatWinBootHook.dll'
$taskMain = Join-Path $taskVendor 'napcat.mjs'
foreach ($taskRequired in @($taskLauncher, $taskQQ, $taskPatch, $taskLoad, $taskInject, $taskMain)) {
    if (-not (Test-Path -LiteralPath $taskRequired -PathType Leaf)) {
        throw "Required file missing: $taskRequired"
    }
}

# Do not overwrite the running instance's logs or start another QQ adapter.
foreach ($taskPort in @(6099, 9088)) {
    if (@(Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
        throw "Port $taskPort is already in use. Check the existing NapCat instance before starting another."
    }
}
if (-not $PSCmdlet.ShouldProcess('Project NapCat adapter', 'Start hidden launcher')) { return }

$env:NAPCAT_PATCH_PACKAGE = $taskPatch
$env:NAPCAT_LOAD_PATH = $taskLoad
$env:NAPCAT_INJECT_PATH = $taskInject
$env:NAPCAT_MAIN_PATH = $taskMain
$taskArguments = @(('"{0}"' -f $taskQQ), ('"{0}"' -f $taskInject))
$taskProcess = Start-Process -FilePath $taskLauncher -ArgumentList $taskArguments -WorkingDirectory $taskVendor -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot '.private/napcat.stdout.log') -RedirectStandardError (Join-Path $taskRoot '.private/napcat.stderr.log') -PassThru -ErrorAction Stop
if ($null -eq $taskProcess -or $taskProcess.Id -le 0) { throw 'NapCat launcher did not return a process ID.' }
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskRoot '.private/napcat.pid')
Write-Output "NapCat launcher started: PID $($taskProcess.Id). Private logs: .private/napcat.*.log"
Write-Output 'Launcher startup does not confirm QQ login. Open http://127.0.0.1:6099/webui to check.'
