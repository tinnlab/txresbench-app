; Test harness for installer-hooks.nsh (not part of the app's installer).
;
; It includes the hook file as Tauri's installer does and runs its parts
; against stand-ins, so the hook can be compiled anywhere (makensis) and run on
; Windows without building the app:
;   - the stand-in for `txresbench-desktop.exe --wsl-status` is this harness
;     itself: copied to <work>\txr-harness-app.exe and started with
;     --wsl-status, it exits with the first code listed in
;     <work>\status-codes.txt (one per line; the line is used up) and appends
;     its command line to <work>\status-calls.txt;
;   - the elevated program is the real one ($WINDIR\SysWOW64\cmd.exe), with
;     harmless parameters in the "elevate" and "act" scenarios;
;   - the stand-in for `wsl.exe --unregister` is this harness too: copied to
;     <work>\txr-harness-wsl.exe, it appends its command line to
;     <work>\wsl-calls.txt, then behaves as wsl.exe does for the uninstall
;     hook's directory handling: it removes <work>\wsl-data\TxResBench\
;     ext4.vhdx (the distro's disk, which real wsl.exe deletes on --unregister)
;     and exits 0 unless <work>\wsl-exit-code.txt says otherwise (a non-zero
;     code keeps the disk, as a failed --unregister does).
;
;   txr-harness.exe /WORK=<dir> /SCENARIO=<name> [/S] [/P] [/UPDATE] [/AUTO]
;                   [/NOAPP] [/ACTION=install|turn-on|update] [/EXIT=<n>] [/NOELEVFILE] [/SLOW]
;                   [/CASE=registered|no-tick|update|absent|other-distro|extra-file|wsl-fails]
;
; Scenarios (each writes <work>\result.txt, one key=value per line):
;   hook        the production NSIS_HOOK_POSTINSTALL, as Tauri inserts it
;               (/NOAPP: without the stand-in app, so the check cannot start)
;   flow        TxrWslSetup with the production commands, past the skip check
;               (questions take their /SD answer "No" in silent mode)
;   elevate     TxrRunElevated: SysWOW64\cmd.exe as administrator runs
;               Sysnative\whoami.exe /groups > <work>\elev-groups.txt, exit 7
;   act         the "Yes" path: the first check (status-codes.txt), then
;               TxrWslAct with /ACTION (install, turn-on or update); the
;               install and update parameters are harmless commands that write
;               "install" or "update" to <work>\elev-ran.txt and exit with
;               /EXIT (default 0); turn-on runs the install parameters;
;               /NOELEVFILE: the program to elevate does not exist;
;               /SLOW: the commands take about 5 s (ping) before they write
;   elevation   TxrReadElevationType alone
;   uninstall   the production NSIS_HOOK_POSTUNINSTALL, as Tauri inserts it at
;               the end of Section Uninstall, against the stand-ins above: the
;               Lxss key is the harness's own (Software\TxResBenchHarness\Lxss)
;               and is seeded per /CASE=, and wsl.exe is the copied stand-in.
;               /CASE=:
;                 registered   the box ticked, the TxResBench entry there:
;                              one call `--unregister TxResBench` and the
;                              empty BasePath dir removed (default)
;                 no-tick      box not ticked: no call, distro stays
;                 update       update mode (/UPDATE on the command line, as the
;                              real updater runs the uninstaller), the box
;                              state as ticked: no call — an update never
;                              removes the distro
;                 absent       box ticked, no TxResBench entry: no call
;                 other-distro box ticked, only an "Ubuntu" entry: no call
;                 extra-file   the BasePath dir holds ext4.vhdx and keep.txt:
;                              the call is made, the dir stays
;                 wsl-fails    the stand-in exits 1: the call is made, the dir
;                              stays, and the uninstall keeps going (result.txt
;                              is still written)
; /AUTO closes the harness without its finish page (for unattended runs).
;
; Build: makensis -WX "-DTXR_HOOKS=<absolute path of installer-hooks.nsh>" hook-harness.nsi
; makensis resolves !include relative to the .nsi's own directory, so a path
; relative to the repo root (src-app/desktop/tauri/windows/installer-hooks.nsh)
; fails: give the absolute path, or a path relative to this file's directory —
; installer-hooks.nsh is here too, so "-DTXR_HOOKS=installer-hooks.nsh" works
; from anywhere. hook-harness-test.ps1 passes its -Hooks value straight into
; -DTXR_HOOKS=, so give it one of these forms too. From PowerShell the -D...
; argument must be quoted: an unquoted argument that starts with - and
; contains . is split by PowerShell.
; The hook's compile-time guards (hook-harness-test.ps1 -Makensis): with
; -DTXR_TEST_NO_MAINBINARYNAME the template's MAINBINARYNAME is missing, with
; -DTXR_TEST_FINISH_PAGE_FIRST the hook is included after the finish page, with
; -DTXR_TEST_NO_REBOOT_SUPPORT the finish page cannot offer a restart
; (MUI_FINISHPAGE_NOREBOOTSUPPORT), with -DTXR_TEST_NO_FINISH_PAGE there is no
; finish page; each must fail to compile.
;
; Run (Windows): makensis -WX "-DTXR_HOOKS=<absolute path of installer-hooks.nsh>" src-app/desktop/tauri/windows/hook-harness.nsi
; builds txr-harness.exe. Then, per case, from a directory with a writable
; <dir>:
;   txr-harness.exe /WORK=<dir> /SCENARIO=uninstall /CASE=registered /S
; and read <dir>\result.txt (unreg_found, unreg_base_path, unreg_exit,
; case, delete_app_data, update_mode, base_path_after) and <dir>\wsl-calls.txt.
; /S closes the harness's finish page; the other cases take the same command
; with their /CASE= (the update case passes /UPDATE too, as the real updater
; does). The whole scenario never touches WSL's real Lxss key or the real
; wsl.exe; the real Lxss key is read nowhere and the stand-in is the harness's
; own copy in <dir>.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
Name "TxResBench hook harness"
OutFile "txr-harness.exe"
InstallDir "$TEMP\txr-harness"
ShowInstDetails show

!define TXR_HARNESS_APP "txr-harness-app"
!ifndef TXR_TEST_NO_MAINBINARYNAME
  !define MAINBINARYNAME "${TXR_HARNESS_APP}"
!endif

; The uninstall hook's paths, overridden so the harness never runs the real
; wsl.exe and never reads WSL's real Lxss key: its Lxss key is this harness's
; own, and "wsl.exe" is this harness copied (the stand-in below, which logs
; the call and behaves like wsl.exe for the disk).
!define TXR_LXSS_KEY "Software\TxResBenchHarness\Lxss"
!define TXR_HARNESS_WSL "txr-harness-wsl.exe"
!define TXR_UNREG_WSL_EXE "$Work\${TXR_HARNESS_WSL}"

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include TextFunc.nsh
!ifdef TXR_TEST_FINISH_PAGE_FIRST
  !insertmacro MUI_PAGE_FINISH
!endif
!include "${TXR_HOOKS}"

; The two variables the uninstall hook reads from Tauri's installer.nsi: the
; template declares them itself (Var DeleteAppDataCheckboxState, Var
; UpdateMode) and sets them in its uninstaller pages; the harness declares
; them for itself and sets them in its uninstall scenario.
Var DeleteAppDataCheckboxState
Var UpdateMode

Var Work
Var Scenario
Var Shortcut
Var Exit
Var UnregCase

!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
!insertmacro MUI_PAGE_INSTFILES
!ifndef TXR_TEST_NO_FINISH_PAGE
  !ifdef TXR_TEST_NO_REBOOT_SUPPORT
    !define MUI_FINISHPAGE_NOREBOOTSUPPORT
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipFinishIfAuto
  !insertmacro MUI_PAGE_FINISH
!endif
!insertmacro MUI_LANGUAGE "English"

; Tauri's own function, called by the hook when it offers a restart.
Function CreateOrUpdateDesktopShortcut
  StrCpy $Shortcut 1
FunctionEnd

; Sets the error flag when the command line lacks the option on the stack.
!macro HasOption OPTION
  Push $R0
  Push $R1
  ${GetParameters} $R1
  ClearErrors
  ${GetOptions} $R1 "${OPTION}" $R0
  Pop $R1
  Pop $R0
!macroend

!ifndef TXR_TEST_NO_FINISH_PAGE
Function SkipFinishIfAuto
  !insertmacro HasOption "/AUTO"
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
FunctionEnd
!endif

Function .onInit
  ${GetParameters} $R1
  ${If} $R1 == "--wsl-status"
    Call StandInStatus
  ${EndIf}
  ; The copied stand-in for `wsl.exe --unregister` runs this same .onInit:
  ; its only argument is the unregister call.
  StrCpy $R2 $R1 12
  ${If} $R2 == "--unregister"
    Call WslStandInUnregister
  ${EndIf}
  ClearErrors
  ${GetOptions} $R1 "/WORK=" $Work
  ${If} ${Errors}
    MessageBox MB_OK "usage: txr-harness.exe /WORK=<dir> /SCENARIO=<name>" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${GetOptions} $R1 "/SCENARIO=" $Scenario
  ClearErrors
  ${GetOptions} $R1 "/EXIT=" $Exit
  ${If} ${Errors}
    StrCpy $Exit 0
  ${EndIf}
  StrCpy $INSTDIR $Work
FunctionEnd

; The stand-in for `txresbench-desktop.exe --wsl-status`.
Function StandInStatus
  FileOpen $0 "$EXEDIR\status-calls.txt" a
  FileSeek $0 0 END
  FileWrite $0 "$CMDLINE$\r$\n"
  FileClose $0
  StrCpy $R2 ""
  StrCpy $R3 ""
  FileOpen $0 "$EXEDIR\status-codes.txt" r
  FileRead $0 $R2
  read_rest:
    ClearErrors
    FileRead $0 $R4
    ${IfNot} ${Errors}
      StrCpy $R3 "$R3$R4"
      Goto read_rest
    ${EndIf}
  FileClose $0
  FileOpen $0 "$EXEDIR\status-codes.txt" w
  FileWrite $0 $R3
  FileClose $0
  ${TrimNewLines} $R2 $R2
  ${If} $R2 == ""
    StrCpy $R2 99
  ${EndIf}
  SetErrorLevel $R2
  Quit
FunctionEnd

; The copied stand-in for `wsl.exe --unregister <distro>`: it records the call
; in <work>\wsl-calls.txt, then behaves as wsl.exe does for what the uninstall
; hook does with the distro's directory: it deletes the distro's disk
; (<work>\wsl-data\TxResBench\ext4.vhdx — the BasePath the scenario seeds) so
; the hook's RMDir sees an empty directory. Exit code 0, or the code in
; <work>\wsl-exit-code.txt (added by the wsl-fails case, whose disk stays, as
; wsl.exe leaves it when --unregister fails).
Function WslStandInUnregister
  FileOpen $0 "$EXEDIR\wsl-calls.txt" a
  FileSeek $0 0 END
  FileWrite $0 "$CMDLINE$\r$\n"
  FileClose $0
  StrCpy $R3 "0"
  IfFileExists "$EXEDIR\wsl-exit-code.txt" 0 wsl_standin_code_done
    FileOpen $0 "$EXEDIR\wsl-exit-code.txt" r
    FileRead $0 $R3
    FileClose $0
    ${TrimNewLines} $R3 $R3
  wsl_standin_code_done:
  ${If} $R3 == 0
    Delete "$EXEDIR\wsl-data\TxResBench\ext4.vhdx"
  ${EndIf}
  SetErrorLevel $R3
  Quit
FunctionEnd

Function WriteResult
  ${If} ${RebootFlag}
    StrCpy $R0 1
  ${Else}
    StrCpy $R0 0
  ${EndIf}
  ; The start of each message this run would show (they are longer, and
  ; span lines).
  StrCpy $R1 $TxrWslMsgNoPermission 40
  StrCpy $R2 $TxrWslMsgFailed 40
  FileOpen $0 "$Work\result.txt" w
  FileWrite $0 "scenario=$Scenario$\r$\n"
  FileWrite $0 "skipped=$TxrWslSkipped$\r$\n"
  FileWrite $0 "elevation=$TxrElevationType$\r$\n"
  FileWrite $0 "first=$TxrWslFirstCode$\r$\n"
  FileWrite $0 "code=$TxrWslCode$\r$\n"
  FileWrite $0 "action=$TxrWslAction$\r$\n"
  FileWrite $0 "outcome=$TxrWslOutcome$\r$\n"
  FileWrite $0 "started=$TxrElevStarted$\r$\n"
  FileWrite $0 "error=$TxrElevError$\r$\n"
  FileWrite $0 "exit=$TxrElevExit$\r$\n"
  FileWrite $0 "reboot=$R0$\r$\n"
  FileWrite $0 "shortcut=$Shortcut$\r$\n"
  FileWrite $0 "status_cmd=$TxrWslStatusCmd$\r$\n"
  FileWrite $0 "elev_file=$TxrElevFile$\r$\n"
  FileWrite $0 "install_params=$TxrWslInstallParams$\r$\n"
  FileWrite $0 "update_params=$TxrWslUpdateParams$\r$\n"
  FileWrite $0 "elev_params=$TxrElevParams$\r$\n"
  FileWrite $0 "msg_no_permission=$R1$\r$\n"
  FileWrite $0 "msg_failed=$R2$\r$\n"
  ; The uninstall scenario's answers (empty for the other scenarios).
  FileWrite $0 "case=$UnregCase$\r$\n"
  FileWrite $0 "delete_app_data=$DeleteAppDataCheckboxState$\r$\n"
  FileWrite $0 "update_mode=$UpdateMode$\r$\n"
  FileWrite $0 "unreg_found=$TxrWslUnregFound$\r$\n"
  FileWrite $0 "unreg_base_path=$TxrWslUnregBasePath$\r$\n"
  FileWrite $0 "unreg_exit=$TxrWslUnregExit$\r$\n"
  ${If} ${FileExists} "$Work\wsl-data\TxResBench"
    StrCpy $R1 "yes"
  ${Else}
    StrCpy $R1 "no"
  ${EndIf}
  FileWrite $0 "base_path_after=$R1$\r$\n"
  FileClose $0
FunctionEnd

; The harmless elevated run: whoami from the native System32 (through
; Sysnative, as the real command reaches wsl.exe), then exit code 7.
Function HarmlessElevation
  StrCpy $TxrElevFile "$WINDIR\SysWOW64\cmd.exe"
  StrCpy $TxrElevParams '/d /s /c ""$WINDIR\Sysnative\whoami.exe" /groups > "$Work\elev-groups.txt" & exit /b 7"'
FunctionEnd

Section "harness"
  SetOutPath $Work
  StrCpy $Shortcut 0
  !insertmacro HasOption "/NOAPP"
  ${If} ${Errors}
    CopyFiles /SILENT "$EXEPATH" "$Work\${TXR_HARNESS_APP}.exe"
  ${EndIf}
  ${If} $Scenario == "hook"
    !insertmacro NSIS_HOOK_POSTINSTALL
  ${ElseIf} $Scenario == "flow"
    StrCpy $TxrWslStatusCmd '"$INSTDIR\${TXR_HARNESS_APP}.exe" --wsl-status'
    StrCpy $TxrElevFile "$WINDIR\SysWOW64\cmd.exe"
    StrCpy $TxrWslInstallParams '/d /s /c "exit 0"'
    StrCpy $TxrWslUpdateParams '/d /s /c "exit 0"'
    Call TxrWslSetup
  ${ElseIf} $Scenario == "elevate"
    Call HarmlessElevation
    Call TxrRunElevated
  ${ElseIf} $Scenario == "act"
    StrCpy $TxrWslStatusCmd '"$INSTDIR\${TXR_HARNESS_APP}.exe" --wsl-status'
    Call TxrWslRunStatus
    StrCpy $TxrWslFirstCode $TxrWslCode
    ${GetParameters} $R1
    ${GetOptions} $R1 "/ACTION=" $TxrWslAction
    StrCpy $TxrElevFile "$WINDIR\SysWOW64\cmd.exe"
    !insertmacro HasOption "/NOELEVFILE"
    ${IfNot} ${Errors}
      StrCpy $TxrElevFile "$WINDIR\SysWOW64\txr-harness-no-such-program.exe"
    ${EndIf}
    StrCpy $R2 ""
    !insertmacro HasOption "/SLOW"
    ${IfNot} ${Errors}
      StrCpy $R2 "ping -n 6 127.0.0.1 > nul &"
    ${EndIf}
    StrCpy $TxrWslInstallParams '/d /s /c "$R2 echo install> "$Work\elev-ran.txt" & exit /b $Exit"'
    StrCpy $TxrWslUpdateParams '/d /s /c "$R2 echo update> "$Work\elev-ran.txt" & exit /b $Exit"'
    Call TxrWslAct
  ${ElseIf} $Scenario == "elevation"
    Call TxrReadElevationType
  ${ElseIf} $Scenario == "uninstall"
    ; The stand-in for `wsl.exe --unregister`: this harness, copied to
    ; <work>\txr-harness-wsl.exe (it logs the call and behaves like wsl.exe
    ; for the distro's disk).
    CopyFiles /SILENT "$EXEPATH" "$Work\${TXR_HARNESS_WSL}"
    ; A fresh harness key (the harness's own, never WSL's) and a fresh
    ; wsl-calls.txt, so a previous run — even one that died before cleaning up
    ; below — cannot leak into this one. The whole
    ; HKCU\Software\TxResBenchHarness key is deleted, never any other key.
    DeleteRegKey HKCU "Software\TxResBenchHarness"
    Delete "$Work\wsl-calls.txt"
    Delete "$Work\wsl-exit-code.txt"
    ${GetParameters} $R1
    ClearErrors
    ${GetOptions} $R1 "/CASE=" $UnregCase
    ${If} ${Errors}
      StrCpy $UnregCase "registered"
    ${EndIf}
    ; What the real uninstaller's pages set: the "Delete app data" box's state
    ; (un.ConfirmLeave) and the update flag (un.onInit from /UPDATE, which the
    ; updater passes when it runs the uninstaller). The update case keeps the
    ; box ticked and passes /UPDATE, so the no-call must come from the update
    ; guard, as it would in the real update flow (/CASE=update means the same
    ; on its own, as it always did).
    StrCpy $DeleteAppDataCheckboxState 1
    ${If} $UnregCase == "no-tick"
      StrCpy $DeleteAppDataCheckboxState 0
    ${EndIf}
    StrCpy $UpdateMode 0
    ${GetParameters} $R1
    ClearErrors
    ${GetOptions} $R1 "/UPDATE" $R0
    ${IfNot} ${Errors}
      StrCpy $UpdateMode 1
    ${EndIf}
    ${If} $UnregCase == "update"
      StrCpy $UpdateMode 1
    ${EndIf}
    ; The distro entries.
    ${If} $UnregCase == "other-distro"
      WriteRegStr HKCU "${TXR_LXSS_KEY}\TxrTestDistro" "DistributionName" "Ubuntu"
      WriteRegStr HKCU "${TXR_LXSS_KEY}\TxrTestDistro" "BasePath" "$Work\wsl-data\Ubuntu"
    ${ElseIf} $UnregCase != "absent"
      WriteRegStr HKCU "${TXR_LXSS_KEY}\TxrTestDistro" "DistributionName" "TxResBench"
      WriteRegStr HKCU "${TXR_LXSS_KEY}\TxrTestDistro" "BasePath" "$Work\wsl-data\TxResBench"
    ${EndIf}
    ; The distro's directory and disk (the BasePath above), cleaned first; the
    ; extra file is what the extra-file case leaves behind.
    RMDir /r "$Work\wsl-data"
    ${If} $UnregCase == "registered"
    ${OrIf} $UnregCase == "no-tick"
    ${OrIf} $UnregCase == "update"
    ${OrIf} $UnregCase == "extra-file"
    ${OrIf} $UnregCase == "wsl-fails"
      CreateDirectory "$Work\wsl-data\TxResBench"
      FileOpen $0 "$Work\wsl-data\TxResBench\ext4.vhdx" w
      FileClose $0
      ${If} $UnregCase == "extra-file"
        FileOpen $0 "$Work\wsl-data\TxResBench\keep.txt" w
        FileWrite $0 "not the app's"
        FileClose $0
      ${EndIf}
    ${EndIf}
    ; The wsl-fails case makes the stand-in exit non-zero and keep the disk.
    ${If} $UnregCase == "wsl-fails"
      FileOpen $0 "$Work\wsl-exit-code.txt" w
      FileWrite $0 "1"
      FileClose $0
    ${EndIf}
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  ${Else}
    StrCpy $TxrWslOutcome "bad-scenario"
  ${EndIf}
  Call WriteResult
  ; The uninstall scenario leaves nothing behind: the whole harness key is
  ; deleted again after result.txt is written (and before the seeding above,
  ; in case an earlier run died). No other key is ever touched.
  ${If} $Scenario == "uninstall"
    DeleteRegKey HKCU "Software\TxResBenchHarness"
  ${EndIf}
  SetAutoClose true
SectionEnd
