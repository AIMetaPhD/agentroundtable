param(
  [Parameter(Mandatory=$true)][string]$WavFile,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$Culture = 'zh-CN'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$ri = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
      Where-Object { $_.Culture.Name -eq $Culture } |
      Select-Object -First 1
if (-not $ri) { throw "no installed recognizer for $Culture" }
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($ri.Id)
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$rec.SetInputToWaveFile($WavFile)
$parts = New-Object System.Collections.Generic.List[string]
while ($true) {
  $r = $null
  try { $r = $rec.Recognize() } catch { break }
  if ($null -eq $r) { break }
  if ($r.Text) { $parts.Add($r.Text) }
}
$rec.Dispose()
[System.IO.File]::WriteAllText($OutFile, ($parts -join ''), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('STT_OK ' + $parts.Count)
