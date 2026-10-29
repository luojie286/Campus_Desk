param([ValidateSet('switch-qq','relogin-qq','relogin-document')][string]$Mode='switch-qq')
$taskRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $taskRoot
# 只停止已验证是本项目实例的后台服务；不结束用户的普通 Edge。
foreach($taskPidFile in @('.private/server.pid','.private/login.pid')){
  if(Test-Path -LiteralPath $taskPidFile){
    $taskPid=[int](Get-Content -LiteralPath $taskPidFile)
    $taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
    if($taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine -match 'src[/\\]poc\.cjs'){
      if($taskProcess.CommandLine -match '\blogin\b'){throw 'Close the dedicated document login window before switching accounts.'}
      Stop-Process -Id $taskPid
    }
  }
}
node tools/accounts.cjs $Mode
if($LASTEXITCODE -ne 0){throw 'Failed to prepare account settings'}
if($Mode -ne 'relogin-document'){
  $taskPid=[int](Get-Content '.private/napcat.pid')
  $taskAdapter=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
  if($taskAdapter.Name -eq 'NapCatWinBootMain.exe'){
    taskkill /PID $taskPid /T /F | Out-Null
  }
  $taskWebPath='.private/vendor/napcat-4.18.41/config/webui.json'
  $taskWeb=Get-Content -LiteralPath $taskWebPath -Raw | ConvertFrom-Json
  $taskWeb.autoLoginAccount=''
  $taskWeb | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskWebPath -Encoding utf8NoBOM
  & './tools/start-napcat.ps1'
}
Write-Output 'Automatic writing is paused. Complete account login and source binding before enabling execution.'
