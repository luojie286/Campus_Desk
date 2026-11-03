param(
    [string]$JavaHome = 'C:\Program Files\Zulu\zulu-21',
    [string]$AndroidSdk = 'E:\codex\l10reboot\.local\android-sdk',
    [string]$GradleCache = 'E:\codex\l10reboot\.local\gradle-cache'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskTools = Join-Path $taskRoot '.private\go-tools'
$taskGo = Join-Path $taskRoot 'mobile\tsnet-probe\go'
$taskAndroid = Join-Path $taskRoot 'mobile\android'
$taskAar = Join-Path $taskAndroid 'tsnetProbe\libs\probe.aar'
$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_NDK_HOME = Join-Path $AndroidSdk 'ndk\28.2.13676358'
$env:GRADLE_USER_HOME = $GradleCache
$env:GOBIN = $taskTools
$env:PATH = $taskTools + ';' + (Join-Path $JavaHome 'bin') + ';' + $env:PATH
$taskMobileVersion = 'v0.0.0-20261011034528-197770444867'
New-Item -ItemType Directory -Path $taskTools, (Split-Path $taskAar -Parent) -Force | Out-Null
Push-Location $taskGo
try {
    & go test .
    if ($LASTEXITCODE -ne 0) { throw 'Go transport checks failed' }
    & go install "golang.org/x/mobile/cmd/gomobile@$taskMobileVersion"
    if ($LASTEXITCODE -ne 0) { throw 'gomobile installation failed' }
    & gomobile init
    if ($LASTEXITCODE -ne 0) { throw 'gomobile initialization failed' }
    & gomobile bind -target android/arm64 -androidapi 26 -javapkg com.campusdesk.tsnet -o $taskAar .
    if ($LASTEXITCODE -ne 0) { throw 'Go bridge build failed' }
} finally { Pop-Location }
Push-Location $taskAndroid
try {
    & .\gradlew.bat :tsnetProbe:assembleDebug :tsnetProbe:lintDebug -PtsnetProbe=true --offline --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Android probe build failed' }
} finally { Pop-Location }
Write-Output 'Probe APK: mobile/android/tsnetProbe/build/outputs/apk/debug/tsnetProbe-debug.apk'
