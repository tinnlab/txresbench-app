# Runs the hook harness (hook-harness.nsi) on Windows through every path that
# needs no dialog and no click, each with a time limit, and checks what the hook
# decided (result.txt) and what it ran. Never installs anything: the elevated
# runs are whoami. Elevated runs need an elevated session (no UAC prompt).
#
#   powershell -NoProfile -File hook-harness-test.ps1 -Harness <txr-harness.exe> -Work <empty dir>
#
# Exit 0 when every case passes.
param(
  [Parameter(Mandatory = $true)][string]$Harness,
  [Parameter(Mandatory = $true)][string]$Work,
  [int]$TimeoutSec = 60
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
  Write-Output ("ran  {0,-26} outcome={1} reboot={2}" -f $Name, $r['outcome'], $r['reboot'])
}

$calls = { param($case, $dir, $r)
  $f = Join-Path $dir 'status-calls.txt'
  Check $case 'status not run' (-not (Test-Path $f)) 'status-calls.txt exists'
}
$calledOnce = { param($case, $dir, $r)
  $f = Join-Path $dir 'status-calls.txt'
  $lines = @(Get-Content $f)
  Check $case 'status run once' ($lines.Count -eq 1) "$($lines.Count) calls"
  $want = '"' + (Join-Path $dir 'txr-harness-app.exe') + '" --wsl-status'
  Check $case 'status command line' ($lines[0] -eq $want) "got '$($lines[0])'"
}

$win = $env:SystemRoot
$production = @{
  status_cmd     = '"' + "$Work" + '\{0}\txr-harness-app.exe" --wsl-status'
  elev_file      = "$win\SysWOW64\cmd.exe"
  install_params = "/d /s /c `"`"$win\Sysnative\wsl.exe`" --install --no-distribution`""
  update_params  = "/d /s /c `"`"$win\Sysnative\wsl.exe`" --update && `"$win\Sysnative\wsl.exe`" --install --no-distribution`""
}

# 1. The production hook never runs the check on an update or an unattended install.
foreach ($c in @(
    @{ n = 'hook-update-passive'; f = @('/SCENARIO=hook', '/P', '/UPDATE', '/AUTO') },
    @{ n = 'hook-update-silent'; f = @('/SCENARIO=hook', '/S', '/UPDATE') },
    @{ n = 'hook-update-basicui'; f = @('/SCENARIO=hook', '/UPDATE', '/AUTO') },
    @{ n = 'hook-silent'; f = @('/SCENARIO=hook', '/S') },
    @{ n = 'hook-passive'; f = @('/SCENARIO=hook', '/P', '/AUTO') })) {
  Run-Case $c.n @('21') $c.f @{ skipped = '1'; outcome = 'skipped'; reboot = '0'; started = '' } $calls
}

# 2. The production hook on an interactive install, on the paths without a dialog.
foreach ($c in @(
    @{ n = 'hook-ready'; code = '0'; e = @{ skipped = '0'; first = '0'; outcome = 'ready'; reboot = '0'; shortcut = '0' } },
    @{ n = 'hook-restart'; code = '20'; e = @{ skipped = '0'; first = '20'; outcome = 'restart'; reboot = '1'; shortcut = '1' } })) {
  $e = $c.e.Clone()
  $e['status_cmd'] = $production.status_cmd -f $c.n
  $e['elev_file'] = $production.elev_file
  $e['install_params'] = $production.install_params
  $e['update_params'] = $production.update_params
  $e['started'] = ''
  Run-Case $c.n @($c.code) @('/SCENARIO=hook', '/AUTO') $e $calledOnce
}

# 3. Every status through the flow, silent: questions take their default "No".
foreach ($c in @(
    @{ code = '0'; o = 'ready'; b = '0' }, @{ code = '20'; o = 'restart'; b = '1' },
    @{ code = '21'; o = 'declined'; b = '0' }, @{ code = '22'; o = 'declined'; b = '0' },
    @{ code = '23'; o = 'declined'; b = '0' }, @{ code = '24'; o = 'no-wsl-exe'; b = '0' },
    @{ code = '25'; o = 'emulated'; b = '0' }, @{ code = '26'; o = 'policy'; b = '0' },
    @{ code = '2'; o = 'unknown'; b = '0' }, @{ code = '1'; o = 'unknown'; b = '0' },
    @{ code = '101'; o = 'unknown'; b = '0' })) {
  Run-Case "flow-$($c.code)" @($c.code) @('/SCENARIO=flow', '/S') @{
    first = $c.code; outcome = $c.o; reboot = $c.b; action = ''; started = '' } $calledOnce
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

# 5. The "Yes" path after the elevated run: the second check decides.
foreach ($c in @(
    @{ n = 'yes-missing-restart'; codes = @('21', '20'); o = 'set-up'; b = '1' },
    @{ n = 'yes-missing-ready'; codes = @('21', '0'); o = 'set-up'; b = '1' },
    @{ n = 'yes-old-ready'; codes = @('22', '0'); o = 'set-up'; b = '0' },
    @{ n = 'yes-old-restart'; codes = @('22', '20'); o = 'set-up'; b = '1' },
    @{ n = 'yes-legacy-ready'; codes = @('23', '0'); o = 'set-up'; b = '1' },
    @{ n = 'yes-missing-still'; codes = @('21', '21'); o = 'failed'; b = '0' },
    @{ n = 'yes-old-still'; codes = @('22', '22'); o = 'failed'; b = '0' })) {
  Run-Case $c.n $c.codes @('/SCENARIO=elevate-flow', '/S') @{
    first = $c.codes[0]; code = $c.codes[1]; outcome = $c.o; reboot = $c.b; started = '1'; exit = '7' } $null
}

Write-Output "passed $($script:pass) checks, failed $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
exit 0
