# Installs the Neuraxis mod as the organization's own on this machine. Not elevated
# itself: it validates the stage, runs admin-install.ps1 elevated and hidden (silent admin, brain
# feedback_server_admin_no_uac_prompt), validates the written managed file in place, then runs the verifier on NEW
# throwaway sessions. Sessions already running are not touched; they load the mod at their next start and stay
# inert there unless HAVOK_MOD_AGENT names an agent with a config file in their folder.
# Everything it uses (stage, scripts, log) is next to this script, so a copied release folder installs its own stage.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <release folder>\install.ps1
#   -NeedPlugin X.Y.Z   the brain plugin version this release needs (machine-update passes the manifest's parts.plugin)
#   -Force              install although the brain plugin or the brain server is not there (a deliberate install)
param([switch]$SkipVerify, [string]$NeedPlugin = '', [switch]$Force)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
# A mod installed before the brain plugin it needs, or while the brain server does not answer /layers/versions, runs in
# its degraded modes (seed layers, no recall). The check is the brain's own (machine-update.mjs --needs).
$installed = Join-Path $env:USERPROFILE '.claude\plugins\installed_plugins.json'
$brainRoot = ''
try { $brainRoot = [string](((Get-Content -Raw -LiteralPath $installed | ConvertFrom-Json).plugins.'havok-brain@havok-brain' | Where-Object { $_.installPath } | Select-Object -First 1).installPath) } catch { }
$needs = if ($brainRoot) { Join-Path $brainRoot 'tools\machine-update.mjs' } else { '' }
if ($env:HAVOK_INSTALL_CHECKED -eq '1') {
  # machine-update.mjs ran this check itself (with the manifest's plugin version) before calling this script.
} elseif ($needs -and (Test-Path -LiteralPath $needs)) {
  $why = & $node $needs --needs --plugin $NeedPlugin 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    if (-not $Force) { throw "not installed: $($why.Trim()). Install with -Force to do it anyway." }
    Write-Host "Installing anyway (-Force): $($why.Trim())" -ForegroundColor Yellow
  }
} elseif (-not $Force) { throw 'not installed: no havok-brain plugin is installed here. Install with -Force to do it anyway.' }
$stage = Join-Path $here 'stage'
if (-not (Test-Path -LiteralPath (Join-Path $stage 'managed-settings.json'))) { throw 'no stage: run node release\build.mjs first' }
& $node (Join-Path $here 'validate-managed.mjs') (Join-Path $stage 'managed-settings.json') --marketplace (Join-Path $stage 'claude-plugins')
if ($LASTEXITCODE -ne 0) { throw 'the staged managed settings do not validate' }
$log = Join-Path $here 'out\admin-install.log'
New-Item -ItemType Directory -Force -Path (Join-Path $here 'out') | Out-Null
$q = { param($s) $s.Replace("'", "''") }
$script = "& '" + (& $q (Join-Path $here 'admin-install.ps1')) + "' -Stage '" + (& $q $stage) + "' -Log '" + (& $q $log) + "'; exit `$LASTEXITCODE"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $enc" -PassThru
# Not waited for forever: robocopy now gives up on a locked file in seconds, so 5 minutes means something else is stuck.
if (-not $p.WaitForExit(300000)) {
  # Stopped before the throw, so a rollback never runs while robocopy still copies. Stopping an elevated process from
  # this one may be refused; the throw then says so, and its children (robocopy) are asked to stop as well.
  $stopped = $true
  foreach ($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" -OperationTimeoutSec 15 -ErrorAction SilentlyContinue)) { try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop } catch { $stopped = $false } }
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { $stopped = $false }
  $gone = $p.WaitForExit(10000)
  throw "the elevated install did not finish in 5 minutes (pid $($p.Id)); $(if ($gone) { 'it was stopped' } elseif ($stopped) { 'it was told to stop but is still running' } else { 'it could not be stopped from here: end it before any rollback' }); see $log"
}
Get-Content -LiteralPath $log -Tail 14
if ($p.ExitCode -ne 0) { throw "admin-install.ps1 ended with exit $($p.ExitCode); see $log" }
& $node (Join-Path $here 'validate-managed.mjs') 'C:\Program Files\ClaudeCode\managed-settings.json'
if ($LASTEXITCODE -ne 0) { throw 'the installed managed settings do not validate: run uninstall.ps1 now' }
# The status line ships with the release: the one in ~/.claude is replaced and the old one kept, never overwriting a
# backup (statusline-backup.mjs; uninstall.ps1 puts the original back). An automatic update used to leave it old.
$slSource = Join-Path $here 'statusline.mjs'
if (Test-Path -LiteralPath $slSource) { & $node (Join-Path $here 'statusline-backup.mjs') install $slSource (Join-Path $env:USERPROFILE '.claude\statusline.mjs') }
# A standalone install (org.json names an engine folder): the user's hooks that the mod does in its place are taken
# out, others that run an old brain folder are repointed at the engine, a hook with no shell gets PowerShell where Git
# Bash is missing, and settings env HAVOK_SERVER_URL is set to the engine server; a backup is kept (repoint-hooks.mjs).
# Ours names no engine folder: nothing changes.
$orgFile = Join-Path $stage 'claude-plugins\plugins\havok-mod\org.json'
$repoint = Join-Path $here 'repoint-hooks.mjs'
if ((Test-Path -LiteralPath $orgFile) -and (Test-Path -LiteralPath $repoint)) { & $node $repoint $orgFile }
if (-not $SkipVerify) {
  & $node (Join-Path $here 'verify.mjs') --mode org
  if ($LASTEXITCODE -ne 0) { Write-Host 'Verification failed: run uninstall.ps1 if new sessions misbehave.' -ForegroundColor Red; exit 1 }
}
Write-Host 'Installed. New sessions load havok-mod@havok-org in tier prepend; inert unless HAVOK_MOD_AGENT names an agent.' -ForegroundColor Green
