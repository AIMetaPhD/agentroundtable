$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root 'app'
$data = Join-Path $root 'data'
if (-not (Test-Path $data)) { New-Item -ItemType Directory -Path $data | Out-Null }
$tokenFile = Join-Path $data 'room-token.txt'
if (Test-Path $tokenFile) {
  $env:R2_HUMAN_TOKEN = (Get-Content -Raw -Encoding UTF8 $tokenFile).Trim()
} else {
  $env:R2_HUMAN_TOKEN = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
}
$env:R2_PORT = '8820'
$env:R2_DATA_DIR = $data
$env:R2_CC_MODEL = 'group/openrouter'
Set-Location $app
Write-Host 'Agent Roundtable RC'
Write-Host ('URL: http://127.0.0.1:8820/#token=' + $env:R2_HUMAN_TOKEN)
Write-Host ('Token file: ' + $tokenFile)
node server.js
