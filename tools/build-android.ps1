param(
    [string]$JavaHome = 'C:\Program Files\Zulu\zulu-21',
    [string]$AndroidSdk = 'E:\codex\l10reboot\.local\android-sdk',
    [string]$GradleCache = 'E:\codex\l10reboot\.local\gradle-cache',
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskAndroid = Join-Path $taskRoot 'mobile\android'
if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))) { throw 'JDK not found; provide -JavaHome.' }
if (-not (Test-Path -LiteralPath (Join-Path $AndroidSdk 'platforms\android-36'))) { throw 'Android SDK 36 not found; provide -AndroidSdk.' }
$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidSdk
$env:GRADLE_USER_HOME = $GradleCache
$taskBridge = Join-Path $taskAndroid 'tsnetProbe\libs\probe.aar'
$taskBridgeSources = @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'mobile\tsnet-probe\go') -File | Where-Object { $_.Extension -eq '.go' -or $_.Name -in @('go.mod','go.sum') })
$taskRebuildBridge = -not (Test-Path -LiteralPath $taskBridge)
if (-not $taskRebuildBridge) {
    $taskBridgeTime = (Get-Item -LiteralPath $taskBridge).LastWriteTimeUtc
    $taskRebuildBridge = @($taskBridgeSources | Where-Object { $_.LastWriteTimeUtc -gt $taskBridgeTime }).Count -gt 0
}
if ($taskRebuildBridge) {
    & (Join-Path $PSScriptRoot 'build-tsnet-probe.ps1') -JavaHome $JavaHome -AndroidSdk $AndroidSdk -GradleCache $GradleCache
}
# local.properties 只描述本机 SDK，不保存凭证，且已被 Git 忽略。
$taskSdkProperty = $AndroidSdk.Replace('\', '/').Replace(':', '\:')
Set-Content -LiteralPath (Join-Path $taskAndroid 'local.properties') -Value "sdk.dir=$taskSdkProperty" -Encoding utf8
Push-Location $taskAndroid
try {
    $taskArguments = @('testDebugUnitTest', 'lintDebug', 'assembleDebug', '--console=plain')
    if ($Offline) { $taskArguments += '--offline' }
    & .\gradlew.bat @taskArguments
    if ($LASTEXITCODE -ne 0) { throw 'Android checks failed; inspect the Gradle output.' }
    $taskApk = Join-Path $taskAndroid 'app\build\outputs\apk\debug\app-debug.apk'
    Get-Item -LiteralPath $taskApk | Select-Object FullName, Length
    $taskHash = Get-FileHash -LiteralPath $taskApk -Algorithm SHA256
    Set-Content -LiteralPath ($taskApk + '.sha256') -Value ($taskHash.Hash.ToLowerInvariant() + '  app-debug.apk') -Encoding ascii
    $taskHash
} finally { Pop-Location }
