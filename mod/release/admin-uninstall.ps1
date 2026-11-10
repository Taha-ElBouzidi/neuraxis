# Runs ELEVATED (release/uninstall.ps1 starts it). Takes the organization install of the Neuraxis mod off this machine:
# removes managed-settings.json only when it is the one this release wrote (else stops, exit 2), removes the empty
# ClaudeCode folder, and with -RemoveFolder the marketplace folder too. Sessions already running keep the mod until
# they restart; new sessions start without it.
param(
  [string]$Stage = (Join-Path $PSScriptRoot 'stage'),
  [string]$Root = 'C:\Program Files\Havok\claude-plugins',
  [string]$ManagedDir = 'C:\Program Files\ClaudeCode',
  [string]$Log = (Join-Path $PSScriptRoot 'out\admin-uninstall.log'),
  [switch]$RemoveFolder,
  [switch]$Test
)
$ErrorActionPreference = 'Stop'
# Runs elevated and appends its log under D:: a link at the log path is refused before any write (see admin-install.ps1).
function IsLink($p) { (Test-Path -LiteralPath $p) -and [bool]((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
foreach ($p in @($Log, (Split-Path -Parent $Log))) { if (IsLink $p) { [Console]::Error.WriteLine("refused: $p is a link"); exit 3 } }
# A log line never stops the install (laptop 2026-11-03: a write to a log another process held threw, the error
# handler's own write threw again, and the step ended 1 with nothing said). Retried, then written beside the log.
function L($t) {
  $line = "{0}  {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $t
  for ($i = 0; $i -lt 5; $i++) {
    try { Add-Content -LiteralPath $Log -Value $line -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 200 }
  }
  try { Add-Content -LiteralPath ($Log + '.alt') -Value $line -ErrorAction Stop } catch { }
}
try {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  L ("start: admin={0} test={1}" -f $admin, [bool]$Test)
  if (-not $admin -and -not $Test) { throw 'not elevated' }
  $dst = Join-Path $ManagedDir 'managed-settings.json'
  if (Test-Path -LiteralPath $dst) {
    $ours = (Get-FileHash -LiteralPath $dst).Hash -eq (Get-FileHash -LiteralPath (Join-Path $Stage 'managed-settings.json')).Hash
    if (-not $ours) { L 'STOP: managed-settings.json is not the one this release wrote; left in place'; exit 2 }
    Remove-Item -LiteralPath $dst -Force
    L ("REMOVED {0}" -f $dst)
  } else { L 'no managed-settings.json' }
  if ((Test-Path -LiteralPath $ManagedDir) -and -not (Get-ChildItem -LiteralPath $ManagedDir -Force)) { Remove-Item -LiteralPath $ManagedDir -Force; L 'removed the empty ClaudeCode folder' }
  if ($RemoveFolder -and (Test-Path -LiteralPath $Root)) {
    Remove-Item -LiteralPath $Root -Recurse -Force
    L ("removed {0}" -f $Root)
    $parent = Split-Path -Parent $Root
    if ((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force)) { Remove-Item -LiteralPath $parent -Force; L ("removed the empty {0}" -f $parent) }
  }
  L 'DONE'
  exit 0
} catch {
  L ("ERROR {0}" -f $_)
  exit 1
}
