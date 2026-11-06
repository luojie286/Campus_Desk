param(
    [switch]$CopyDesktopToken,
    [switch]$PrepareOnly,
    [switch]$Background,
    [switch]$WithLegacy,
    [switch]$WithQQ,
    [switch]$WithSheets,
    [switch]$WithBriefings
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDirectory
$runtimeExe = Join-Path $projectDirectory '.private/runtime/node-v24.22.2/node.exe'
$checksumFile = Join-Path (Split-Path -Parent $runtimeExe) 'SHASUMS256.txt'
if (-not (Test-Path -LiteralPath $runtimeExe) -or -not (Test-Path -LiteralPath $checksumFile)) {
    throw 'Install the verified Node 24.22.2 runtime in .private/runtime/node-v24.22.2.'
}
$expectedHash = (Select-String -LiteralPath $checksumFile -Pattern '^([a-f0-9]{64})\s+win-x64/node\.exe$').Matches[0].Groups[1].Value
if ((Get-FileHash -LiteralPath $runtimeExe -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'Node runtime checksum mismatch.'
}
$assistantTokenFile = Join-Path $projectDirectory '.private/assistant-token.dpapi'
if (-not (Test-Path -LiteralPath '.private/assistant.config.json')) { throw 'Assistant setup is incomplete.' }
if (-not (Test-Path -LiteralPath $assistantTokenFile)) {
    $tokenBytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($tokenBytes) } finally { $generator.Dispose() }
    $plainToken = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    ConvertTo-SecureString -String $plainToken -AsPlainText -Force |
        ConvertFrom-SecureString | Set-Content -LiteralPath $assistantTokenFile -Encoding ASCII
    Remove-Variable plainToken
}
$secureToken = (Get-Content -LiteralPath $assistantTokenFile -Raw).Trim() | ConvertTo-SecureString
$assistantSecret = [Net.NetworkCredential]::new('', $secureToken).Password
if ($CopyDesktopToken) {
    Set-Clipboard -Value $assistantSecret
    Write-Output 'Desktop assistant token copied to clipboard.'
}
if ($PrepareOnly) { return }
$servicePort = (Get-Content -LiteralPath '.private/config.json' -Raw | ConvertFrom-Json).port
if (Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue) {
    throw 'The configured loopback port already has a listener.'
}
$previousAssistantToken = $env:CAMPUS_DESK_ASSISTANT_TOKEN
$env:CAMPUS_DESK_ASSISTANT_TOKEN = $assistantSecret
$serveCommand = if ($WithLegacy) { 'serve' } else { 'serve-assistant' }
$serveArguments = @('src/poc.cjs', $serveCommand)
if ($WithQQ) { $serveArguments += '--qq' }
if ($WithSheets) { $serveArguments += '--sheets' }
if ($WithBriefings) { $serveArguments += '--briefings' }
try {
    if ($Background) {
        Start-Process -FilePath $runtimeExe -ArgumentList $serveArguments -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru |
            Select-Object -ExpandProperty Id
    } else {
        & $runtimeExe @serveArguments
        exit $LASTEXITCODE
    }
} finally {
    $env:CAMPUS_DESK_ASSISTANT_TOKEN = $previousAssistantToken
}
