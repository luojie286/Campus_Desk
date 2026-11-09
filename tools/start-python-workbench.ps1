param(
    [switch]$CopyToken,
    [ValidateSet('crossref','brave')][string]$SearchProvider,
    [switch]$QQAbility,
    [switch]$QQHistorySuggestions,
    [switch]$Sheets,
    [switch]$ExecuteSheets
)

$ErrorActionPreference = 'Stop'
# A child Windows PowerShell can inherit a module path from PowerShell 7.
# Load the DPAPI cmdlets from the current engine's own installation.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.venv/Scripts/python.exe'
$private = Join-Path $project '.private'
$tokenFile = Join-Path $private 'python-workbench-token.dpapi'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'Install the Python requirements in .venv first.'
}
if (-not (Test-Path -LiteralPath (Join-Path $private 'poc.sqlite') -PathType Leaf)) {
    throw 'Initialize a knowledge workspace before starting the Python host.'
}
if (Get-NetTCPConnection -LocalPort 9089 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 9089 already has a listener.'
}
$previous = $env:CAMPUSDESK_KNOWLEDGE_TOKEN
if (-not $previous) {
    if (-not (Test-Path -LiteralPath $tokenFile)) {
        $bytes = New-Object byte[] 32
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
        $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
        ConvertTo-SecureString -String $token -AsPlainText -Force |
            ConvertFrom-SecureString | Set-Content -LiteralPath $tokenFile -Encoding ASCII
        Remove-Variable token
    }
    $protected = (Get-Content -LiteralPath $tokenFile -Raw).Trim() | ConvertTo-SecureString
    $env:CAMPUSDESK_KNOWLEDGE_TOKEN = [Net.NetworkCredential]::new('', $protected).Password
}
Push-Location -LiteralPath $project
try {
    if ($CopyToken) {
        Set-Clipboard -Value $env:CAMPUSDESK_KNOWLEDGE_TOKEN
        Write-Output 'Python workbench token copied to clipboard.'
    }
    $options = @()
    if ($SearchProvider) { $options += @('--search-provider', $SearchProvider) }
    if ($QQAbility) { $options += '--qq-ability' }
    if ($QQHistorySuggestions) { $options += '--qq-history-suggestions' }
    if ($Sheets) { $options += '--sheets' }
    if ($ExecuteSheets) { $options += '--execute-sheets' }
    & $python -m campusdesk --root $project serve-knowledge @options
    exit $LASTEXITCODE
} finally {
    Pop-Location
    $env:CAMPUSDESK_KNOWLEDGE_TOKEN = $previous
}
