# 从当前项目的已校验发布包启动非提权适配进程；不修改 QQ 安装文件。
# 某些工具执行上下文不会设置 $PSScriptRoot；此时按当前工作目录定位项目根目录。
$taskRoot = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { (Get-Location).Path }
$taskVendor = Join-Path $taskRoot '.private/vendor/napcat-4.18.41'
$taskLauncher = Join-Path $taskVendor 'NapCatWinBootMain.exe'
if (-not (Test-Path -LiteralPath $taskLauncher)) { throw 'Download and verify the pinned NapCat release first.' }
$env:NAPCAT_PATCH_PACKAGE = Join-Path $taskVendor 'qqnt.json'
$env:NAPCAT_LOAD_PATH = Join-Path $taskVendor 'loadNapCat.js'
$env:NAPCAT_INJECT_PATH = Join-Path $taskVendor 'NapCatWinBootHook.dll'
$env:NAPCAT_MAIN_PATH = Join-Path $taskVendor 'napcat.mjs'
$taskProcess = Start-Process -FilePath $taskLauncher -ArgumentList 'D:\QQ.exe', $env:NAPCAT_INJECT_PATH -WorkingDirectory $taskVendor -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot '.private/napcat.stdout.log') -RedirectStandardError (Join-Path $taskRoot '.private/napcat.stderr.log') -PassThru
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskRoot '.private/napcat.pid')
Write-Output "NapCat launcher started: PID $($taskProcess.Id). Private logs: .private/napcat.*.log"
