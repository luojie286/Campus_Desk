param([switch]$CopyToken)

$ErrorActionPreference = 'Stop'
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
    & $python -m campusdesk --root $project serve-knowledge
    exit $LASTEXITCODE
} finally {
    Pop-Location
    $env:CAMPUSDESK_KNOWLEDGE_TOKEN = $previous
}
