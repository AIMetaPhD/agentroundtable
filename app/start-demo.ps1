if (-not $env:R2_PORT) { $env:R2_PORT = "8810" }
if (-not $env:R2_HUMAN_TOKEN) { $env:R2_HUMAN_TOKEN = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N") }
if (-not $env:R2_CC_MODEL) { $env:R2_CC_MODEL = "workbuddy/deepseek-v4.1-flash" }
$root = Split-Path $PSScriptRoot -Parent
$venv = Join-Path $root "R2\asr-venv\Scripts\python.exe"
$asr = Join-Path $PSScriptRoot "tools\asr-faster-whisper.py"
if (Test-Path $venv) {
  $env:R2_ASR_CMD = $venv
  $env:R2_ASR_ARGS = ConvertTo-Json @($asr) -Compress
  $env:R2_WHISPER_PROMPT = "KV cache，checkpoint，edge 节点，延迟，迁移"
  $snapRoot = Join-Path $env:USERPROFILE ".cache\huggingface\hub\models--Systran--faster-whisper-tiny\snapshots"
  if (Test-Path $snapRoot) {
    $snap = Get-ChildItem $snapRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($snap) { $env:R2_WHISPER_MODEL = $snap.FullName }
  }
}
Set-Location $PSScriptRoot
node server.js
