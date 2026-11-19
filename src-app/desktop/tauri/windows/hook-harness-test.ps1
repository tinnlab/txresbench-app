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
#    It reads its token's elevation type and, unless that is 2 (run as
#    administrator, skipped), runs the check.
if ($elevation -eq '2') {
  Run-Case 'hook-elevated' @('0') @('/SCENARIO=hook', '/AUTO') @{
    skipped = '1'; outcome = 'skipped-elevated'; elevation = '2'; reboot = '0'; started = '' } $calls
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
  install = @{ msg_no_permission = 'WSL 2 was not set up because'; msg_failed = 'WSL 2 could not be set up.' }
  update  = @{ msg_no_permission = 'WSL was not updated because'; msg_failed = 'WSL could not be updated.' }
}
# The action is the one the case expects (checked with the other keys).
$actChecks = { param($case, $dir, $r, $ran)
  $action = $r['action']
  foreach ($k in @('msg_no_permission', 'msg_failed')) {
    $want = $messages[$action][$k]
    Check $case $k ($r[$k].StartsWith($want)) "want '$want...', got '$($r[$k])'"
  }
  $f = Join-Path $dir 'elev-ran.txt'
  if ($ran) {
    $got = if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { '(none)' }
    Check $case 'the action ran its own parameters' ($got -eq $action) "ran '$got'"
    Check $case 'elev_params' ($r['elev_params'] -eq $r["$($action)_params"]) "got '$($r['elev_params'])'"
  } else {
    Check $case 'nothing ran' (-not (Test-Path $f)) 'elev-ran.txt exists'
  }
}
foreach ($c in @(
    @{ n = 'act-missing-ready'; a = 'install'; codes = @('21', '0'); x = '0'; o = 'set-up'; b = '1' },
    @{ n = 'act-missing-restart'; a = 'install'; codes = @('21', '20'); x = '0'; o = 'set-up'; b = '1' },
    @{ n = 'act-turn-on-restart'; a = 'install'; codes = @('20', '20'); x = '0'; o = 'set-up'; b = '1' },
    @{ n = 'act-turn-on-ready'; a = 'install'; codes = @('20', '0'); x = '0'; o = 'set-up'; b = '0' },
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
    @{ n = 'act-turn-on-then-missing'; a = 'install'; codes = @('20', '21'); x = '0'; o = 'failed'; b = '0' },
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

# 8. The compile-time guards: a template without MAINBINARYNAME, or one that
#    includes the hook after its finish page, does not build.
if ($Makensis) {
  foreach ($c in @(
      @{ n = 'guard-no-mainbinaryname'; d = '-DTXR_TEST_NO_MAINBINARYNAME'; want = 'no longer defines MAINBINARYNAME' },
      @{ n = 'guard-finish-page-first'; d = '-DTXR_TEST_FINISH_PAGE_FIRST'; want = 'is included after the finish page' })) {
    $dir = Join-Path $Work $c.n
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory $dir | Out-Null
    Push-Location $dir
    $ErrorActionPreference = 'Continue'
    $out = & $Makensis /NOCD -V2 -WX "-DTXR_HOOKS=$Hooks" $c.d $Nsi 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Pop-Location
    Check $c.n 'makensis fails' ($code -ne 0) "exit $code"
    Check $c.n 'with the guard''s message' ($out.Contains($c.want)) (($out.Trim() -split "`n" | Select-Object -Last 3) -join ' | ')
    Check $c.n 'no harness built' (-not (Test-Path (Join-Path $dir 'txr-harness.exe'))) 'txr-harness.exe exists'
    Write-Output ("ran  {0,-28} makensis exit={1}" -f $c.n, $code)
  }
}

Write-Output "passed $($script:pass) checks, failed $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
exit 0
