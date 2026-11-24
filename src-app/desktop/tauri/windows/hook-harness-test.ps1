# Runs the hook harness (hook-harness.nsi) on Windows through every path that
# needs no dialog and no click, each with a time limit, and checks what the hook
# decided (result.txt) and what it ran. Never installs anything: the elevated
# runs are whoami and echo. Elevated runs need an elevated session (no UAC
# prompt).
#
#   powershell -NoProfile -File hook-harness-test.ps1 -Harness <txr-harness.exe> -Work <empty dir>
#       [-Makensis <makensis.exe> -Nsi <hook-harness.nsi> -Hooks <installer-hooks.nsh>]
#
# With -Makensis it also checks that the hook's compile-time guards stop a build.
# The -Hooks path is passed straight into makensis' -DTXR_HOOKS=, so give an
# absolute path (or one relative to hook-harness.nsi's directory): makensis
# resolves !include relative to the .nsi's own directory, and from PowerShell
# the -D... argument must be quoted.
# Exit 0 when every case passes.
param(
  [Parameter(Mandatory = $true)][string]$Harness,
  [Parameter(Mandatory = $true)][string]$Work,
  [int]$TimeoutSec = 60,
  [string]$Makensis,
  [string]$Nsi,
  [string]$Hooks
)
$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Check($case, $what, $ok, $detail) {
  if ($ok) { $script:pass++ } else { $script:fail++; Write-Output "FAIL $case - $what ($detail)" }
}

function Run-Case([string]$Name, [string[]]$Codes, [string[]]$Flags, [hashtable]$Expect, [scriptblock]$Extra) {
  $dir = Join-Path $Work $Name
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory $dir | Out-Null
  $exe = Join-Path $dir 'txr-harness.exe'
  Copy-Item $Harness $exe
  $codesText = ($Codes | ForEach-Object { "$_`r`n" }) -join ''
  [IO.File]::WriteAllText((Join-Path $dir 'status-codes.txt'), $codesText)
  $p = Start-Process -FilePath $exe -ArgumentList (@("/WORK=$dir") + $Flags) -PassThru
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    $p.Kill()
    Check $Name 'finished in time' $false "killed after $TimeoutSec s"
    return
  }
  $resultFile = Join-Path $dir 'result.txt'
  if (-not (Test-Path $resultFile)) { Check $Name 'wrote result.txt' $false 'missing'; return }
  $r = @{}
  foreach ($line in Get-Content $resultFile) {
    $k, $v = $line -split '=', 2
    $r[$k] = $v
  }
  foreach ($k in $Expect.Keys) {
    Check $Name $k ($r[$k] -eq $Expect[$k]) "want '$($Expect[$k])', got '$($r[$k])'"
  }
  if ($Extra) { & $Extra $Name $dir $r }
  Write-Output ("ran  {0,-28} outcome={1} reboot={2}" -f $Name, $r['outcome'], $r['reboot'])
}

# The stand-in's command lines (PowerShell returns one line as a string: callers
# that index wrap the call in @()).
function Status-Calls($dir) {
  $f = Join-Path $dir 'status-calls.txt'
  if (Test-Path $f) { return @(Get-Content $f) } else { return @() }
}
# The wsl.exe stand-in's command lines (the same shape as Status-Calls).
function Wsl-Calls($dir) {
  $f = Join-Path $dir 'wsl-calls.txt'
  if (Test-Path $f) { return @(Get-Content $f) } else { return @() }
}

$calls = { param($case, $dir, $r)
  Check $case 'status not run' ((Status-Calls $dir).Count -eq 0) 'status-calls.txt exists'
}
$calledOnce = { param($case, $dir, $r)
  $lines = @(Status-Calls $dir)
  Check $case 'status run once' ($lines.Count -eq 1) "$($lines.Count) calls"
  $want = '"' + (Join-Path $dir 'txr-harness-app.exe') + '" --wsl-status'
  Check $case 'status command line' ($lines[0] -eq $want) "got '$($lines[0])'"
}

# This session's TOKEN_ELEVATION_TYPE: the harness started from here has the same.
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class TxrToken {
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr t, int c, out int v, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int ElevationType() {
    IntPtr t; int v, r;
    if (!OpenProcessToken(GetCurrentProcess(), 8, out t)) return -1;
    bool ok = GetTokenInformation(t, 18, out v, 4, out r);
    CloseHandle(t);
    return ok ? v : -2;
  }
}
"@
$elevation = "$([TxrToken]::ElevationType())"
Write-Output "this session's token elevation type: $elevation"

$win = $env:SystemRoot
$production = @{
  status_cmd     = '"' + "$Work" + '\{0}\txr-harness-app.exe" --wsl-status'
  elev_file      = "$win\SysWOW64\cmd.exe"
  install_params = "/d /s /c `"`"$win\Sysnative\wsl.exe`" --install --no-distribution`""
  update_params  = "/d /s /c `"`"$win\Sysnative\wsl.exe`" --update && `"$win\Sysnative\wsl.exe`" --install --no-distribution`""
}

# 1. The production hook never runs the check on an update or an unattended install,
#    and decides so before anything else (the token is not even read).
foreach ($c in @(
    @{ n = 'hook-update-passive'; f = @('/SCENARIO=hook', '/P', '/UPDATE', '/AUTO') },
    @{ n = 'hook-update-silent'; f = @('/SCENARIO=hook', '/S', '/UPDATE') },
    @{ n = 'hook-update-basicui'; f = @('/SCENARIO=hook', '/UPDATE', '/AUTO') },
    @{ n = 'hook-silent'; f = @('/SCENARIO=hook', '/S') },
    @{ n = 'hook-passive'; f = @('/SCENARIO=hook', '/P', '/AUTO') })) {
  Run-Case $c.n @('21') $c.f @{ skipped = '1'; outcome = 'skipped'; reboot = '0'; started = ''; elevation = '' } $calls
}

# 2. The production hook on an interactive install, on the paths without a dialog.
#    It reads its token's elevation type and runs the check only when that is
#    1 (UAC off) or 3 (the usual start); 2 (run as administrator) skips, and so
#    does a type Windows did not give.
if ($elevation -eq '2') {
  Run-Case 'hook-elevated' @('0') @('/SCENARIO=hook', '/AUTO') @{
    skipped = '1'; outcome = 'skipped-elevated'; elevation = '2'; reboot = '0'; started = '' } $calls
} elseif ($elevation -ne '1' -and $elevation -ne '3') {
  Run-Case 'hook-elevation-unknown' @('0') @('/SCENARIO=hook', '/AUTO') @{
    skipped = '1'; outcome = 'skipped-elevation-unknown'; reboot = '0'; started = '' } $calls
} else {
  foreach ($c in @(
      @{ n = 'hook-ready'; code = '0'; f = @(); e = @{ first = '0'; code = '0'; outcome = 'ready' }; x = $calledOnce },
      @{ n = 'hook-check-missing'; code = '0'; f = @('/NOAPP'); e = @{ first = 'error'; code = 'error'; outcome = 'unknown' }; x = $calls })) {
    $e = $c.e.Clone()
    $e['skipped'] = '0'
    $e['elevation'] = $elevation
    $e['reboot'] = '0'
    $e['shortcut'] = '0'
    $e['action'] = ''
    $e['started'] = ''
    $e['status_cmd'] = $production.status_cmd -f $c.n
    $e['elev_file'] = $production.elev_file
    $e['install_params'] = $production.install_params
    $e['update_params'] = $production.update_params
    Run-Case $c.n @($c.code) (@('/SCENARIO=hook', '/AUTO') + $c.f) $e $c.x
  }
}

# 3. Every status through the flow, silent: questions take their default "No".
foreach ($c in @(
    @{ code = '0'; o = 'ready' }, @{ code = '20'; o = 'declined' },
    @{ code = '21'; o = 'declined' }, @{ code = '22'; o = 'declined' },
    @{ code = '23'; o = 'declined' }, @{ code = '24'; o = 'no-wsl-exe' },
    @{ code = '25'; o = 'emulated' }, @{ code = '26'; o = 'policy' },
    @{ code = '2'; o = 'unknown' }, @{ code = '1'; o = 'unknown' },
    @{ code = '101'; o = 'unknown' })) {
  Run-Case "flow-$($c.code)" @($c.code) @('/SCENARIO=flow', '/S') @{
    first = $c.code; outcome = $c.o; reboot = '0'; action = ''; started = '' } $calledOnce
}

# 4. The elevated run itself: Windows' 32-bit cmd.exe as administrator reaches the
#    native System32 through Sysnative, and its exit code comes back.
Run-Case 'elevate' @() @('/SCENARIO=elevate', '/S') @{ started = '1'; error = '0'; exit = '7' } {
  param($case, $dir, $r)
  $g = Join-Path $dir 'elev-groups.txt'
  Check $case 'elevated child wrote its groups' (Test-Path $g) 'elev-groups.txt missing'
  if (Test-Path $g) {
    Check $case 'elevated child is high integrity' ((Get-Content $g -Raw) -match 'S-1-16-12288') 'no High Mandatory Level SID'
  }
}

# 5. The "Yes" path: each action runs its own parameters (the stand-ins write the
#    action's name), carries its own messages, and the second check and the
#    setup's exit code decide the outcome and the restart.
$messages = @{
  install   = @{ msg_no_permission = 'WSL 2 was not set up because'; msg_failed = 'WSL 2 could not be set up.' }
  'turn-on' = @{ msg_no_permission = 'WSL 2 was not set up because'; msg_failed = 'The Windows component WSL 2 needs' }
  update    = @{ msg_no_permission = 'WSL was not updated because'; msg_failed = 'WSL could not be updated.' }
}
# Turning the Virtual Machine Platform on runs the install parameters.
$paramsOf = @{ install = 'install'; 'turn-on' = 'install'; update = 'update' }
# The action is the one the case expects (checked with the other keys).
$actChecks = { param($case, $dir, $r, $ran)
  $action = $r['action']
  foreach ($k in @('msg_no_permission', 'msg_failed')) {
    $want = $messages[$action][$k]
    Check $case $k ($r[$k].StartsWith($want)) "want '$want...', got '$($r[$k])'"
  }
  $f = Join-Path $dir 'elev-ran.txt'
  $params = $paramsOf[$action]
  if ($ran) {
    $got = if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { '(none)' }
    Check $case 'the action ran its own parameters' ($got -eq $params) "ran '$got'"
    Check $case 'elev_params' ($r['elev_params'] -eq $r["$($params)_params"]) "got '$($r['elev_params'])'"
  } else {
    Check $case 'nothing ran' (-not (Test-Path $f)) 'elev-ran.txt exists'
  }
}
foreach ($c in @(
    @{ n = 'act-missing-ready'; a = 'install'; codes = @('21', '0'); x = '0'; o = 'set-up'; b = '1' },
    @{ n = 'act-missing-restart'; a = 'install'; codes = @('21', '20'); x = '0'; o = 'set-up'; b = '1' },
    @{ n = 'act-turn-on-restart'; a = 'turn-on'; codes = @('20', '20'); x = '0'; o = 'set-up'; b = '1' },
    @{ n = 'act-turn-on-ready'; a = 'turn-on'; codes = @('20', '0'); x = '0'; o = 'set-up'; b = '0' },
    @{ n = 'act-old-ready'; a = 'update'; codes = @('22', '0'); x = '0'; o = 'set-up'; b = '0' },
    @{ n = 'act-old-restart'; a = 'update'; codes = @('22', '20'); x = '0'; o = 'set-up'; b = '1' },
    @{ n = 'act-legacy-ready'; a = 'update'; codes = @('23', '0'); x = '0'; o = 'set-up'; b = '1' },
    @{ n = 'act-missing-pending'; a = 'install'; codes = @('21', '21'); x = '0'; o = 'restart-pending'; b = '1' },
    @{ n = 'act-missing-pending-23'; a = 'install'; codes = @('21', '23'); x = '0'; o = 'restart-pending'; b = '1' },
    @{ n = 'act-legacy-pending'; a = 'update'; codes = @('23', '23'); x = '0'; o = 'restart-pending'; b = '1' },
    @{ n = 'act-legacy-pending-21'; a = 'update'; codes = @('23', '21'); x = '0'; o = 'restart-pending'; b = '1' },
    @{ n = 'act-missing-failed'; a = 'install'; codes = @('21', '21'); x = '5'; o = 'failed'; b = '0' },
    @{ n = 'act-legacy-failed'; a = 'update'; codes = @('23', '23'); x = '1'; o = 'failed'; b = '0' },
    @{ n = 'act-old-still'; a = 'update'; codes = @('22', '22'); x = '0'; o = 'failed'; b = '0' },
    @{ n = 'act-missing-then-old'; a = 'install'; codes = @('21', '22'); x = '0'; o = 'failed'; b = '0' },
    @{ n = 'act-turn-on-then-missing'; a = 'turn-on'; codes = @('20', '21'); x = '0'; o = 'failed'; b = '0' },
    # A second check of 20 counts only after a setup without an error: a
    # failed turn-on (or a closed window) is reported, with no restart offer,
    # and so is a failed install or update, whatever the first check said.
    @{ n = 'act-turn-on-failed'; a = 'turn-on'; codes = @('20', '20'); x = '1'; o = 'failed'; b = '0' },
    @{ n = 'act-turn-on-window-closed'; a = 'turn-on'; codes = @('20', '20'); x = '-1073741510'; o = 'failed'; b = '0' },
    @{ n = 'act-missing-failed-20'; a = 'install'; codes = @('21', '20'); x = '1'; o = 'failed'; b = '0' },
    @{ n = 'act-old-failed-20'; a = 'update'; codes = @('22', '20'); x = '1'; o = 'failed'; b = '0' },
    @{ n = 'act-legacy-failed-20'; a = 'update'; codes = @('23', '20'); x = '1'; o = 'failed'; b = '0' },
    # A check that finds WSL 2 working wins over the exit code.
    @{ n = 'act-turn-on-failed-ready'; a = 'turn-on'; codes = @('20', '0'); x = '1'; o = 'set-up'; b = '0' },
    @{ n = 'act-missing-check-gone'; a = 'install'; codes = @('21'); x = '0'; o = 'failed'; b = '0' },
    # The hook waits for the setup however long it takes (here about 5 s).
    @{ n = 'act-slow-setup'; a = 'install'; codes = @('21', '0'); x = '3'; o = 'set-up'; b = '1'; slow = $true })) {
  $want = @{
    first = $c.codes[0]; outcome = $c.o; reboot = $c.b; shortcut = $c.b; action = $c.a
    started = '1'; error = '0'; exit = $c.x
  }
  # A check with no code left exits 99, as an unknown code would.
  $want['code'] = if ($c.codes.Count -gt 1) { $c.codes[1] } else { '99' }
  $flags = @('/SCENARIO=act', '/S', "/ACTION=$($c.a)", "/EXIT=$($c.x)")
  if ($c.slow) { $flags += '/SLOW' }
  Run-Case $c.n $c.codes $flags $want {
    param($case, $dir, $r)
    & $actChecks $case $dir $r $true
    Check $case 'status run twice' ((Status-Calls $dir).Count -eq 2) "$((Status-Calls $dir).Count) calls"
  }
}

# 6. The setup could not start (here: the program does not exist; Windows error
#    2, not 1223): the "failed" message of the action, no second check.
foreach ($c in @(
    @{ n = 'act-not-started-install'; a = 'install'; code = '21' },
    @{ n = 'act-not-started-turn-on'; a = 'turn-on'; code = '20' },
    @{ n = 'act-not-started-update'; a = 'update'; code = '22' })) {
  Run-Case $c.n @($c.code, '0') @('/SCENARIO=act', '/S', "/ACTION=$($c.a)", '/NOELEVFILE') @{
    first = $c.code; code = $c.code; action = $c.a; outcome = 'not-started'; started = '0'; error = '2'
    exit = ''; reboot = '0'; shortcut = '0' } {
    param($case, $dir, $r)
    & $actChecks $case $dir $r $false
    Check $case 'status run once' ((Status-Calls $dir).Count -eq 1) "$((Status-Calls $dir).Count) calls"
  }
}

# 7. The token's elevation type, as the hook reads it, is the one Windows reports.
Run-Case 'elevation' @() @('/SCENARIO=elevation', '/S') @{ elevation = $elevation; outcome = '' } $calls

# 8. The uninstall scenario: with the "Delete app data" box ticked and outside
#    an update, the app's own distro is unregistered through the stand-in
#    wsl.exe — one call, `--unregister TxResBench`; not ticked, an update
#    (/UPDATE, as the real updater passes it), no TxResBench entry, or only
#    another distro's entry make no call. Every case must leave the harness's
#    own key gone.
$unregKeyGone = { param($case, $dir, $r)
  Check $case 'harness key removed' (-not (Test-Path 'HKCU:\Software\TxResBenchHarness')) 'HKCU\Software\TxResBenchHarness is still there'
}
$unregCalled = { param($case, $dir, $r)
  $lines = @(Wsl-Calls $dir)
  Check $case 'wsl called once' ($lines.Count -eq 1) "$($lines.Count) calls"
  if ($lines.Count -eq 1) { $got = $lines[0] } else { $got = '' }
  Check $case 'wsl --unregister TxResBench' $got.EndsWith('--unregister TxResBench') "got '$got'"
  & $unregKeyGone $case $dir $r
}
$unregQuiet = { param($case, $dir, $r)
  $lines = @(Wsl-Calls $dir)
  Check $case 'no wsl call' ($lines.Count -eq 0) "$($lines.Count) calls"
  & $unregKeyGone $case $dir $r
}
$unregBasePath = @{ 'registered' = 'no'; 'extra-file' = 'yes'; 'wsl-fails' = 'yes'; 'no-tick' = 'yes'; 'update' = 'yes'; 'absent' = 'no'; 'other-distro' = 'no' }
foreach ($c in @(
    @{ n = 'unreg-registered';   c = 'registered';   x = $unregCalled; exitK = '0' },
    @{ n = 'unreg-extra-file';   c = 'extra-file';   x = $unregCalled; exitK = '0' },
    @{ n = 'unreg-wsl-fails';    c = 'wsl-fails';    x = $unregCalled; exitK = '1' },
    @{ n = 'unreg-no-tick';      c = 'no-tick';      x = $unregQuiet },
    @{ n = 'unreg-update';       c = 'update';       x = $unregQuiet; update = $true },
    @{ n = 'unreg-absent';       c = 'absent';       x = $unregQuiet },
    @{ n = 'unreg-other-distro'; c = 'other-distro'; x = $unregQuiet })) {
  $flags = @('/SCENARIO=uninstall', '/S', "/CASE=$($c.c)")
  if ($c.update) { $flags += '/UPDATE' }
  $tick = '1'
  if ($c.c -eq 'no-tick') { $tick = '0' }
  $mode = '0'
  if ($c.update) { $mode = '1' }
  $e = @{ 'case' = $c.c; 'delete_app_data' = $tick; 'update_mode' = $mode; 'base_path_after' = $unregBasePath[$c.c] }
  if ($c.exitK) { $e['unreg_exit'] = $c.exitK }
  Run-Case $c.n @() $flags $e $c.x
}

# 9. The compile-time guards: a template without MAINBINARYNAME, one that
#    includes the hook after its finish page, one whose finish page cannot offer
#    a restart, and one without a finish page do not build; the harness as it is
#    builds, with no warning.
if ($Makensis) {
  $noRestart = 'has no finish page that can offer a restart'
  foreach ($c in @(
      @{ n = 'guard-normal-build'; d = '-DTXR_TEST_NONE'; want = '' },
      @{ n = 'guard-no-mainbinaryname'; d = '-DTXR_TEST_NO_MAINBINARYNAME'; want = 'no longer defines MAINBINARYNAME' },
      @{ n = 'guard-finish-page-first'; d = '-DTXR_TEST_FINISH_PAGE_FIRST'; want = 'is included after the finish page' },
      @{ n = 'guard-no-reboot-support'; d = '-DTXR_TEST_NO_REBOOT_SUPPORT'; want = $noRestart },
      @{ n = 'guard-no-finish-page'; d = '-DTXR_TEST_NO_FINISH_PAGE'; want = $noRestart })) {
    $dir = Join-Path $Work $c.n
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory $dir | Out-Null
    Push-Location $dir
    $ErrorActionPreference = 'Continue'
    $out = & $Makensis /NOCD -V2 -WX "-DTXR_HOOKS=$Hooks" $c.d $Nsi 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Pop-Location
    $built = Test-Path (Join-Path $dir 'txr-harness.exe')
    $tail = ($out.Trim() -split "`n" | Select-Object -Last 3) -join ' | '
    if ($c.want -eq '') {
      Check $c.n 'makensis succeeds' ($code -eq 0) "exit $code - $tail"
      Check $c.n 'harness built' $built 'txr-harness.exe missing'
    } else {
      Check $c.n 'makensis fails' ($code -ne 0) "exit $code"
      Check $c.n 'with the guard''s message' ($out.Contains($c.want)) $tail
      Check $c.n 'no harness built' (-not $built) 'txr-harness.exe exists'
    }
    Write-Output ("ran  {0,-28} makensis exit={1}" -f $c.n, $code)
  }
}

Write-Output "passed $($script:pass) checks, failed $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
exit 0
