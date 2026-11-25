# Lumen desktop island - system media session poller
# Reads Windows SMTC (GlobalSystemMediaTransportControlsSessionManager) and prints
# one JSON object per line on stdout. ASCII-only source: Windows PowerShell 5.1 reads
# .ps1 without BOM as ANSI, so never put non-ASCII literals in this file.
#
# Output shape:
#   {"ok":true,"session":null}
#   {"ok":true,"app":"kugou","title":"..","artist":"..","album":"..","status":"Playing",
#    "pos":12.3,"dur":240.0,"canPlay":true,"canNext":true,"canPrev":true,
#    "art":"data:image/jpeg;base64,....."}   # art only when the track changes
#   {"ok":false,"error":"..."}

param([int]$Parent = 0, [string]$Queue = '')

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ProgressPreference = 'SilentlyContinue'

try { Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null }
catch {
  Write-Output '{"ok":false,"error":"no System.Runtime.WindowsRuntime"}'
  exit 1
}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

function Get-Mgr {
  $t = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  Await ($t::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Read-Art($props) {
  # Returns a data: URL (or '' when unavailable). Uses the sync stream adapter so we
  # do not have to await a second WinRT operation.
  try {
    if ($null -eq $props.Thumbnail) { return '' }
    $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $stream) { return '' }
    $size = [int64]$stream.Size
    if ($size -le 0 -or $size -gt 2000000) { return '' }
    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $ms = New-Object System.IO.MemoryStream
    $net.CopyTo($ms)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    $net.Dispose()
    try { $stream.Close() } catch {}
    if ($bytes.Length -eq 0) { return '' }
    $mime = 'image/png'
    if ($bytes.Length -gt 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { $mime = 'image/jpeg' }
    elseif ($bytes.Length -gt 3 -and $bytes[0] -eq 0x47 -and $bytes[1] -eq 0x49) { $mime = 'image/gif' }
    elseif ($bytes.Length -gt 3 -and $bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49) { $mime = 'image/webp' }
    return 'data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes)
  } catch {
    return ''
  }
}

$mgr = $null
$lastSig = ''
$lastEmit = 0
$artKey = ''
$art = ''
$failed = 0
$lastParentCheck = 0

# --- Foreground window snapshot (for the island's smart hide) ---------------
# One JSON line is emitted only when the foreground window changes (or every 5s),
# so this costs almost nothing. Coordinates are physical pixels.
try {
  Add-Type -Namespace LumenFg -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@ -ErrorAction Stop
  $fgReady = $true
} catch { $fgReady = $false }

function Get-FgLine {
  if (-not $fgReady) { return '' }
  try {
    $h = [LumenFg.Native]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { return '' }
    $r = New-Object LumenFg.Native+RECT
    if (-not [LumenFg.Native]::GetWindowRect($h, [ref]$r)) { return '' }
    $owner = 0
    [void][LumenFg.Native]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -le 0) { return '' }
    $nm = ''
    try { $nm = (Get-Process -Id $owner -ErrorAction Stop).ProcessName } catch { }
    $nm = $nm -replace '[^A-Za-z0-9_.-]', ''
    return '{"ok":true,"fg":{"p":' + $owner + ',"n":"' + $nm + '","l":' + $r.Left + ',"t":' + $r.Top + ',"r":' + $r.Right + ',"b":' + $r.Bottom + '}}'
  } catch { return '' }
}

$lastFg = ''
$lastFgAt = 0

while ($true) {
  # If the Electron main process is force-killed, this long-lived helper must not be
  # left behind in Task Manager: verify every 3s and exit when the parent is gone.
  if ($Parent -gt 0) {
    $pt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (($pt - $lastParentCheck) -ge 3000) {
      $lastParentCheck = $pt
      if ($null -eq (Get-Process -Id $Parent -ErrorAction SilentlyContinue)) { break }
    }
  }

  try {
    if ($null -eq $mgr) { $mgr = Get-Mgr }
    $cur = $mgr.GetCurrentSession()
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    # Smart hide needs the foreground window even when nothing is playing,
    # so this runs before the "no session" early-continue below.
    $fgLine = Get-FgLine
    if ($fgLine -ne '' -and ($fgLine -ne $lastFg -or ($now - $lastFgAt) -ge 5000)) {
      Write-Output $fgLine
      $lastFg = $fgLine
      $lastFgAt = $now
    }

    # Transport commands arrive as a one-line file (written by the Electron side).
    # Handling them here avoids spawning a fresh PowerShell (~2s) for every tap.
    if ($Queue -ne '' -and (Test-Path $Queue)) {
      $line = ''
      try { $line = [string](Get-Content -Path $Queue -Raw -ErrorAction Stop) } catch { }
      Remove-Item -Path $Queue -Force -ErrorAction SilentlyContinue
      $line = $line.Trim()
      if ($line -ne '' -and $null -ne $cur) {
        $sp = $line.Split(' ')
        try {
          switch ($sp[0]) {
            'toggle' { $null = Await ($cur.TryTogglePlayPauseAsync()) ([bool]) }
            'next'   { $null = Await ($cur.TrySkipNextAsync()) ([bool]) }
            'prev'   { $null = Await ($cur.TrySkipPreviousAsync()) ([bool]) }
            'seek'   {
              if ($sp.Length -gt 1) {
                $sec = [double]$sp[1]
                $null = Await ($cur.TryChangePlaybackPositionAsync([int64]($sec * 10000000))) ([bool])
              }
            }
          }
        } catch { }
      }
    }

    if ($null -eq $cur) {
      if ($lastSig -ne 'none') {
        Write-Output '{"ok":true,"session":null}'
        $lastSig = 'none'
        $lastEmit = $now
        $artKey = ''
        $art = ''
      } elseif (($now - $lastEmit) -ge 10000) {
        Write-Output '{"ok":true,"hb":1}'
        $lastEmit = $now
      }
      $failed = 0
      Start-Sleep -Milliseconds 900
      continue
    }

    $info = $cur.GetPlaybackInfo()
    $status = [string]$info.PlaybackStatus
    $props = Await ($cur.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])

    $app = [string]$cur.SourceAppUserModelId
    $title = [string]$props.Title
    $artist = [string]$props.Artist
    $album = [string]$props.AlbumTitle
    $key = $app + [char]31 + $title + [char]31 + $artist

    if ($key -ne $artKey) {
      $art = Read-Art $props
      $artKey = $key
    }

    $tl = $cur.GetTimelineProperties()
    $pos = [math]::Round([double]$tl.Position.TotalSeconds, 1)
    $dur = [math]::Round([double]$tl.EndTime.TotalSeconds, 1)
    if ($dur -lt 0) { $dur = 0 }

    $controls = $info.Controls
    $sig = $key + [char]31 + $status + [char]31 + [string]$controls.IsPlayPauseToggleEnabled +
           [char]31 + [string]$controls.IsNextEnabled + [char]31 + [string]$controls.IsPreviousEnabled

    $due = $false
    if ($sig -ne $lastSig) { $due = $true }
    elseif ($status -eq 'Playing' -and ($now - $lastEmit) -ge 1000) { $due = $true }

    if ($due) {
      $o = [ordered]@{
        ok      = $true
        app     = $app
        title   = $title
        artist  = $artist
        album   = $album
        status  = $status
        pos     = $pos
        dur     = $dur
        canPlay = [bool]$controls.IsPlayPauseToggleEnabled
        canNext = [bool]$controls.IsNextEnabled
        canPrev = [bool]$controls.IsPreviousEnabled
      }
      if ($key -ne $lastSig -and $art -ne '') { $o.art = $art }
      if ($sig -ne $lastSig) { $o.track = $true }
      Write-Output ($o | ConvertTo-Json -Compress)
      $lastSig = $sig
      $lastEmit = $now
    } elseif (($now - $lastEmit) -ge 10000) {
      Write-Output '{"ok":true,"hb":1}'
      $lastEmit = $now
    }
    $failed = 0
  } catch {
    $failed++
    if ($failed -le 2) {
      $msg = [string]$_.Exception.Message
      $msg = $msg.Replace('\', '\\').Replace('"', '\"').Replace("`r", ' ').Replace("`n", ' ')
      Write-Output ('{"ok":false,"error":"' + $msg + '"}')
    }
    $mgr = $null
    Start-Sleep -Milliseconds 1200
  }
  Start-Sleep -Milliseconds 550
}
