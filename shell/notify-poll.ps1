# Lumen desktop island - Windows notification poller
# Reads the Windows notification platform database (wpndatabase.db) read-only through
# the in-box winsqlite3.dll, and prints new toast notifications as JSON lines.
#
# Why the database instead of UI Automation: on Win11 the toast host windows are not
# exposed to UIA clients at all (root element enumeration returns zero shell windows,
# window-opened events never fire). The database is the same source the notification
# center renders from, so it works with Do Not Disturb on and also gives us the app.
#
# Output shape (one line per batch):
#   {"ok":true,"items":[{"id":9884,"app":"QQ","title":"..","body":"..","at":1764...}]}
#   {"ok":true,"hb":1}
#   {"ok":false,"error":".."}
#
# ASCII-only source: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.

param([int]$Parent = 0, [int64]$Since = 0, [int64]$SinceTime = 0)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ProgressPreference = 'SilentlyContinue'

$dbPath = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Notifications\wpndatabase.db'
if (-not (Test-Path $dbPath)) {
  Write-Output '{"ok":false,"error":"no wpndatabase.db"}'
  exit 1
}

# --- winsqlite3 P/Invoke (read-only open; the WAL is read straight through) ----
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class LumenNotifyDb
{
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int nByte, out IntPtr stmt, IntPtr tail);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_step(IntPtr stmt);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr sqlite3_column_text(IntPtr stmt, int i);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_column_bytes(IntPtr stmt, int i);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern long sqlite3_column_int64(IntPtr stmt, int i);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_finalize(IntPtr stmt);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_close(IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr sqlite3_errmsg(IntPtr db);

    const int OPEN_READONLY = 1;
    const int STEP_ROW = 100;

    static string Col(IntPtr stmt, int i)
    {
        IntPtr p = sqlite3_column_text(stmt, i);
        int len = sqlite3_column_bytes(stmt, i);
        if (p == IntPtr.Zero || len <= 0) return "";
        byte[] buf = new byte[len];
        Marshal.Copy(p, buf, 0, len);
        return Encoding.UTF8.GetString(buf);
    }

    // Returns rows (each 4 strings) and sets err to "" on success.
    public static List<string[]> Rows(string path, string sql, out string err)
    {
        err = "";
        var rows = new List<string[]>();
        IntPtr db;
        byte[] fn = Encoding.UTF8.GetBytes(path + "\0");
        int rc = sqlite3_open_v2(fn, out db, OPEN_READONLY, IntPtr.Zero);
        if (rc != 0)
        {
            if (db != IntPtr.Zero)
            {
                err = "open rc=" + rc + " " + Marshal.PtrToStringAnsi(sqlite3_errmsg(db));
                sqlite3_close(db);
            }
            else err = "open rc=" + rc;
            return rows;
        }
        IntPtr stmt;
        byte[] sq = Encoding.UTF8.GetBytes(sql + "\0");
        rc = sqlite3_prepare_v2(db, sq, -1, out stmt, IntPtr.Zero);
        if (rc != 0)
        {
            err = "prepare " + Marshal.PtrToStringAnsi(sqlite3_errmsg(db));
            sqlite3_close(db);
            return rows;
        }
        try
        {
            while (sqlite3_step(stmt) == STEP_ROW)
            {
                string id = sqlite3_column_int64(stmt, 0).ToString();
                rows.Add(new string[] {
                    id,
                    Col(stmt, 1),                 // app user model id
                    sqlite3_column_int64(stmt, 2).ToString(),  // arrival (FILETIME)
                    Col(stmt, 3)                  // toast xml
                });
            }
        }
        finally
        {
            try { sqlite3_finalize(stmt); } catch { }
            try { sqlite3_close(db); } catch { }
        }
        return rows;
    }
}
'@ -ErrorAction Stop
} catch {
  Write-Output '{"ok":false,"error":"add-type failed"}'
  exit 1
}

function To-JsonStr([string]$s) {
  if ($null -eq $s) { return '""' }
  $s = $s -replace '\\', '\\'
  $s = $s -replace '"', '\"'
  $s = $s -replace "`r", ' '
  $s = $s -replace "`n", ' '
  $s = $s -replace "`t", ' '
  return '"' + $s + '"'
}

# AUMIDs that are pure Windows noise (system tips, defender, input switch...).
# Users expect QQ / WeChat / mail / downloads here, not OS housekeeping.
function Is-Noise([string]$aumid) {
  if ($aumid -eq '') { return $true }
  if ($aumid -like 'Windows.SystemToast.*') { return $true }
  if ($aumid -like 'Windows.System.*') { return $true }
  if ($aumid -like 'Microsoft.Windows.InputSwitchToastHandler*') { return $true }
  if ($aumid -like 'Windows.Defender*') { return $true }
  if ($aumid -like 'Microsoft.Windows.ParentalControls*') { return $true }
  if ($aumid -like 'Windows.Shell.*') { return $true }
  return $false
}

function Parse-Toast([string]$xmlText) {
  $title = ''
  $bodyParts = New-Object System.Collections.Generic.List[string]
  if ($xmlText -notmatch '<toast') { return @('', '') }
  try {
    $x = New-Object System.Xml.XmlDocument
    $x.XmlResolver = $null
    $x.LoadXml($xmlText)
    $nodes = $x.SelectNodes('//*[local-name()="text"]')
    foreach ($n in $nodes) {
      $v = [string]$n.InnerText
      if ($null -eq $v) { continue }
      $v = $v.Trim()
      if ($v -eq '') { continue }
      if ($title -eq '') { $title = $v } else { $bodyParts.Add($v) }
    }
  } catch {
    $ms = [regex]::Matches($xmlText, '<text[^>]*>([^<]*)</text>')
    foreach ($m in $ms) {
      $v = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value).Trim()
      if ($v -eq '') { continue }
      if ($title -eq '') { $title = $v } else { $bodyParts.Add($v) }
    }
  }
  return @($title, ($bodyParts -join ' '))
}

$lastId = [int64]$Since
$lastEmit = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$lastParentCheck = 0
$failed = 0
$baselined = $false
# Baseline by arrival time, not by MAX(Id): Add-Type needs a few seconds on the first
# run, and any notification landing during that window would be swallowed by a
# MAX(Id) baseline -- that is exactly the "first message right after launch" case.
if ($SinceTime -le 0) { $SinceTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$beginFt = ([DateTimeOffset]::FromUnixTimeMilliseconds($SinceTime)).UtcDateTime.ToFileTime()

while ($true) {
  # Parent watchdog: never leave a helper behind if Electron is force-killed.
  if ($Parent -gt 0) {
    $pt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (($pt - $lastParentCheck) -ge 3000) {
      $lastParentCheck = $pt
      if ($null -eq (Get-Process -Id $Parent -ErrorAction SilentlyContinue)) { break }
    }
  }

  try {
    $first = -not $baselined
    $sql = ''
    if ($first) {
      # first run after the island started: everything that arrived from then on
      $sql = 'SELECT n.Id, IFNULL(h.PrimaryId,''''), n.ArrivalTime, CAST(n.Payload AS TEXT) ' +
             'FROM Notification n LEFT JOIN NotificationHandler h ON h.RecordId = n.HandlerId ' +
             "WHERE n.ArrivalTime >= $beginFt AND n.Type = 'toast' ORDER BY n.Id ASC LIMIT 40"
    } else {
      $sql = 'SELECT n.Id, IFNULL(h.PrimaryId,''''), n.ArrivalTime, CAST(n.Payload AS TEXT) ' +
             'FROM Notification n LEFT JOIN NotificationHandler h ON h.RecordId = n.HandlerId ' +
             "WHERE n.Id > $lastId AND n.Type = 'toast' ORDER BY n.Id ASC LIMIT 40"
    }
    $err = ''
    $rows = [LumenNotifyDb]::Rows($dbPath, $sql, [ref]$err)
    if ($err -ne '') { throw $err }

    # First round with zero rows: we must lift lastId to the current MAX(Id),
    # otherwise the next round falls into the incremental branch with Id > 0 and
    # dumps the whole history table into the island (hit on a real machine).
    if ($first) {
      $baselined = $true
      if ($rows.Count -eq 0) {
        $err2 = ''
        $mx = [LumenNotifyDb]::Rows($dbPath, 'SELECT IFNULL(MAX(Id),0),0,0,0 FROM Notification', [ref]$err2)
        $mxId = [int64]0
        if ($mx.Count -gt 0) { [int64]::TryParse($mx[0][0], [ref]$mxId) | Out-Null }
        if ($mxId -gt $lastId) { $lastId = $mxId }
      }
    }

    $items = New-Object System.Collections.Generic.List[string]
    foreach ($r in $rows) {
      $id = [int64]$r[0]
      if ($id -gt $lastId) { $lastId = $id }
      $app = $r[1]
      if (Is-Noise $app) { continue }
      $parsed = Parse-Toast $r[3]
      $title = [string]$parsed[0]
      $body = [string]$parsed[1]
      if ($title -eq '' -and $body -eq '') { continue }
      $ft = [int64]0
      [int64]::TryParse($r[2], [ref]$ft) | Out-Null
      $ms = 0
      if ($ft -gt 0) {
        try { $ms = ([DateTimeOffset]([DateTime]::FromFileTime($ft))).ToUnixTimeMilliseconds() } catch { $ms = 0 }
      }
      $items.Add('{"id":' + $id + ',"app":' + (To-JsonStr $app) +
                 ',"title":' + (To-JsonStr $title) + ',"body":' + (To-JsonStr $body) +
                 ',"at":' + $ms + '}')
    }

    if ($items.Count -gt 0) {
      Write-Output ('{"ok":true,"items":[' + ($items -join ',') + ']}')
      $lastEmit = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } elseif (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $lastEmit) -ge 10000) {
      Write-Output '{"ok":true,"hb":1}'
      $lastEmit = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $failed = 0
  } catch {
    $failed++
    if ($failed -le 2) {
      $msg = [string]$_.Exception.Message
      $msg = $msg.Replace('\', '\\').Replace('"', '\"').Replace("`r", ' ').Replace("`n", ' ')
      Write-Output ('{"ok":false,"error":"' + $msg + '"}')
    }
    Start-Sleep -Milliseconds 1500
  }
  Start-Sleep -Milliseconds 1200
}
