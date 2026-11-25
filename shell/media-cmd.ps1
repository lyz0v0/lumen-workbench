# Lumen desktop island - media transport commands
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File media-cmd.ps1 -Action toggle
#        -Action next | prev | toggle | seek (seek needs -Pos <seconds>)
# Prints {"ok":true,"action":"toggle","result":true}
# ASCII-only source (Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI).

param(
  [string]$Action = 'toggle',
  [double]$Pos = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try { Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null }
catch { Write-Output '{"ok":false,"error":"no System.Runtime.WindowsRuntime"}'; exit 1 }

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

try {
  $t = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $mgr = Await ($t::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $cur = $mgr.GetCurrentSession()
  if ($null -eq $cur) { Write-Output '{"ok":true,"action":"' + $Action + '","result":false,"noSession":true}'; exit 0 }

  $r = $false
  switch ($Action) {
    'toggle' { $r = Await ($cur.TryTogglePlayPauseAsync()) ([bool]) }
    'next'   { $r = Await ($cur.TrySkipNextAsync()) ([bool]) }
    'prev'   { $r = Await ($cur.TrySkipPreviousAsync()) ([bool]) }
    'seek'   { $r = Await ($cur.TryChangePlaybackPositionAsync([int64]($Pos * 10000000))) ([bool]) }
    default  { $r = $false }
  }
  $okJson = 'true'
  if ($r -eq $false) { $okJson = 'false' }
  Write-Output ('{"ok":true,"action":"' + $Action + '","result":' + $okJson + '}')
} catch {
  $msg = [string]$_.Exception.Message
  $msg = $msg.Replace('\', '\\').Replace('"', '\"').Replace("`r", ' ').Replace("`n", ' ')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
  exit 0
}
