# Runs ELEVATED (release/install.ps1 starts it). Installs the Neuraxis mod as the organization's own on this machine:
#   1. <Root> (default C:\Program Files\Havok\claude-plugins): the staged marketplace havok-org with havok-mod, folder
#      admin-only (Administrators and SYSTEM full, Users read and execute, owner Administrators).
#   2. <ManagedDir>\managed-settings.json (default C:\Program Files\ClaudeCode): the staged file, validated before and
#      after the write. An invalid file there stops every Claude Code on the machine from starting, so it is written
#      to a temporary name first, validated there, then moved. An existing managed file that is not ours is never
#      overwritten: the script stops (exit 2) and says so.
# The stage and the log default to the ones next to this script, so a copied release folder installs its own stage.
# -Test rehearses on other folders without elevation (ACL owner change may fail there and is only logged).
param(
  [string]$Stage = (Join-Path $PSScriptRoot 'stage'),
  [string]$Root = 'C:\Program Files\Havok\claude-plugins',
  [string]$ManagedDir = 'C:\Program Files\ClaudeCode',
  [string]$Log = (Join-Path $PSScriptRoot 'out\admin-install.log'),
  [switch]$Test
)
$ErrorActionPreference = 'Stop'
# The log and the stage sit under D:, where other accounts can write. This runs elevated: a link at the log path would
# carry each log line into whatever it points to (managed-settings.json, and no Claude Code starts), and a link or
# junction in the stage would copy what it points to into the folder every user reads. Refused before any write
# (audit 2026-11-01).
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
$node = (Get-Command node -ErrorAction Stop).Source
$validator = Join-Path $PSScriptRoot 'validate-managed.mjs'
function Validate($file, $market) {
  $out = & $node $validator $file '--marketplace' $market 2>&1 | Out-String
  L ("validate {0}: {1}" -f $file, $out.Trim())
  if ($LASTEXITCODE -ne 0 -or $out -notmatch '^OK') { throw "managed settings did not validate: $file" }
}
try {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  L ("start: admin={0} test={1} stage={2} root={3} managed={4}" -f $admin, [bool]$Test, $Stage, $Root, $ManagedDir)
  if (-not $admin -and -not $Test) { throw 'not elevated' }
  $src = Join-Path $Stage 'claude-plugins'
  $staged = Join-Path $Stage 'managed-settings.json'
  $links = @(Get-ChildItem -LiteralPath $Stage -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)
  if ((IsLink $Stage) -or $links.Count) { throw ("the stage holds a link or junction: " + (($links | ForEach-Object { $_.FullName }) -join ', ')) }
  Validate $staged $src

  # 1. The marketplace folder, admin-only. SIDs, not names, so it does not depend on the display language.
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  if ($Test) {
    # A rehearsal runs without elevation: admin-only rights would lock its own folder (seen 2026-11-01).
    L 'test: folder rights left as they are'
  } else {
    L (icacls $Root /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' 2>&1 | Out-String).Trim()
    $own = icacls $Root /setowner '*S-1-5-32-544' 2>&1 | Out-String
    L ("setowner: {0}" -f $own.Trim())
    if ($LASTEXITCODE -ne 0) { throw 'could not make Administrators the owner' }
  }
  $rc = robocopy $src $Root /MIR /XJ /R:2 /W:2 /XD types /NFL /NDL /NJH /NP 2>&1 | Out-String
  # 2 retries, 2 s apart: the default (1,000,000 times 30 s) hangs the hidden admin process on a locked file (audit R6).
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $rc" }
  L ("robocopy exit {0}" -f $LASTEXITCODE)
  # Every staged file arrived byte for byte, and nothing else is there.
  $want = Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object { $_.FullName.Substring($src.Length) }
  $have = Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object { $_.FullName.Substring($Root.Length) }
  if (Compare-Object $want $have) { throw ("files differ: " + ((Compare-Object $want $have | ForEach-Object { $_.InputObject + $_.SideIndicator }) -join ', ')) }
  foreach ($rel in $want) {
    if ((Get-FileHash -LiteralPath (Join-Path $src $rel)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Root $rel)).Hash) { throw "hash differs: $rel" }
  }
  L ("marketplace installed: {0} files, hashes equal" -f $want.Count)

  # 2. The managed settings.
  New-Item -ItemType Directory -Force -Path $ManagedDir | Out-Null
  $dst = Join-Path $ManagedDir 'managed-settings.json'
  $sha = (Get-FileHash -LiteralPath $staged).Hash
  if (Test-Path -LiteralPath $dst) {
    if ((Get-FileHash -LiteralPath $dst).Hash -eq $sha) { L 'managed settings already in place and identical; left as they are'; Validate $dst $Root; L 'DONE (unchanged)'; exit 0 }
    $bak = "$dst.bak-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    Copy-Item -LiteralPath $dst -Destination $bak
    L ("STOP: a different managed-settings.json is already there (copied to {0}); it is not overwritten. Merge by hand." -f $bak)
    exit 2
  }
  $tmp = Join-Path $ManagedDir ("managed-settings.json.tmp-" + $PID)
  Copy-Item -LiteralPath $staged -Destination $tmp
  try {
    $null = Get-Content -Raw -LiteralPath $tmp | ConvertFrom-Json
    Validate $tmp $Root
    if ((Get-FileHash -LiteralPath $tmp).Hash -ne $sha) { throw 'the temporary copy differs from the staged file' }
    Move-Item -LiteralPath $tmp -Destination $dst
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  }
  $null = Get-Content -Raw -LiteralPath $dst | ConvertFrom-Json
  Validate $dst $Root
  if ((Get-FileHash -LiteralPath $dst).Hash -ne $sha) { Remove-Item -LiteralPath $dst -Force; throw 'written file differs from the staged one; removed' }
  L ("WRITTEN {0} sha256={1}" -f $dst, $sha)
  L 'DONE'
  exit 0
} catch {
  L ("ERROR {0}" -f $_)
  exit 1
}
