# Takes the organization install of the Neuraxis mod off this machine. Runs admin-uninstall.ps1 elevated
# and hidden (managed-settings.json removed only if it is the one this release wrote), then removes the havok-org
# entry Claude Code's background reconcile wrote into ~/.claude/plugins/known_marketplaces.json (the org test of
# 2026-11-01 found it stays after the managed file is gone) and havok-mod@havok-org from installed_plugins.json
# (forget-user.mjs; audit 2026-11-01), keeping backups. -RemoveFolder also deletes
# C:\Program Files\Havok\claude-plugins. Running sessions keep the mod until they restart.
param([switch]$RemoveFolder)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$log = Join-Path $here 'out\admin-uninstall.log'
New-Item -ItemType Directory -Force -Path (Join-Path $here 'out') | Out-Null
$q = { param($s) $s.Replace("'", "''") }
$script = "& '" + (& $q (Join-Path $here 'admin-uninstall.ps1')) + "' -Stage '" + (& $q (Join-Path $here 'stage')) + "' -Log '" + (& $q $log) + "'" + $(if ($RemoveFolder) { ' -RemoveFolder' } else { '' }) + "; exit `$LASTEXITCODE"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $enc" -PassThru
if (-not $p.WaitForExit(300000)) { throw "the elevated uninstall did not finish in 5 minutes (pid $($p.Id)); see $log" }
Get-Content -LiteralPath $log -Tail 8
if ($p.ExitCode -ne 0) { throw "admin-uninstall.ps1 ended with exit $($p.ExitCode); see $log" }
# havok-org in known_marketplaces.json and havok-mod@havok-org in installed_plugins.json, backups kept (node keeps
# every other entry exactly; the audit of 2026-11-01 found the second entry left behind).
& (Get-Command node -ErrorAction Stop).Source (Join-Path $here 'forget-user.mjs') (Join-Path $env:USERPROFILE '.claude')
if ($LASTEXITCODE -ne 0) { throw 'could not remove the havok-org entries from the user plugin files' }
# The status line install.ps1 replaced comes back: the backup of the oldest version, the one from before the releases.
& (Get-Command node -ErrorAction Stop).Source (Join-Path $here 'statusline-backup.mjs') restore (Join-Path $env:USERPROFILE '.claude\statusline.mjs')
# Recall comes back without the mod: keepPreTurn true in machine.json lets the brain's session start (0.4.82 and
# later) put the per-turn hook back into settings.json at the next start. Left as it was, a machine with no mod and no
# hook has no recall and nothing says so (review of brain 0.4.82, 2026-11-03).
$machine = Join-Path $env:USERPROFILE '.claude\havok-mod\machine.json'
if (Test-Path -LiteralPath $machine) {
  try { $m = Get-Content -Raw -LiteralPath $machine | ConvertFrom-Json } catch { $m = $null }
  if ($m -is [psobject] -and -not ($m -is [array])) {
    Copy-Item -LiteralPath $machine -Destination ($machine + '.bak-uninstall') -Force
    $m | Add-Member -NotePropertyName keepPreTurn -NotePropertyValue $true -Force
    [IO.File]::WriteAllText($machine, ($m | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
    Write-Host 'machine.json: keepPreTurn true, so the next session start puts the recall hook back.'
  }
}
Write-Host 'Uninstalled. New sessions start without the Neuraxis mod.' -ForegroundColor Green
