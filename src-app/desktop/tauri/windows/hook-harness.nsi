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
;     harmless parameters in the "elevate" and "act" scenarios.
;
;   txr-harness.exe /WORK=<dir> /SCENARIO=<name> [/S] [/P] [/UPDATE] [/AUTO]
;                   [/NOAPP] [/ACTION=install|update] [/EXIT=<n>] [/NOELEVFILE] [/SLOW]
;
; Scenarios (each writes <work>\result.txt, one key=value per line):
;   hook        the production NSIS_HOOK_POSTINSTALL, as Tauri inserts it
;               (/NOAPP: without the stand-in app, so the check cannot start)
;   flow        TxrWslSetup with the production commands, past the skip check
;               (questions take their /SD answer "No" in silent mode)
;   elevate     TxrRunElevated: SysWOW64\cmd.exe as administrator runs
;               Sysnative\whoami.exe /groups > <work>\elev-groups.txt, exit 7
;   act         the "Yes" path: the first check (status-codes.txt), then
;               TxrWslAct with /ACTION; the install and update parameters are
;               harmless commands that write "install" or "update" to
;               <work>\elev-ran.txt and exit with /EXIT (default 0);
;               /NOELEVFILE: the program to elevate does not exist;
;               /SLOW: the commands take about 5 s (ping) before they write
;   elevation   TxrReadElevationType alone
; /AUTO closes the harness without its finish page (for unattended runs).
;
; Build: makensis -WX -DTXR_HOOKS=<path of installer-hooks.nsh> hook-harness.nsi
; The hook's compile-time guards (hook-harness-test.ps1 -Makensis): with
; -DTXR_TEST_NO_MAINBINARYNAME the template's MAINBINARYNAME is missing, with
; -DTXR_TEST_FINISH_PAGE_FIRST the hook is included after the finish page; both
; must fail to compile.

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

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include TextFunc.nsh
!ifdef TXR_TEST_FINISH_PAGE_FIRST
  !insertmacro MUI_PAGE_FINISH
!endif
!include "${TXR_HOOKS}"

Var Work
Var Scenario
Var Shortcut
Var Exit

!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipFinishIfAuto
!insertmacro MUI_PAGE_FINISH
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

Function SkipFinishIfAuto
  !insertmacro HasOption "/AUTO"
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
FunctionEnd

Function .onInit
  ${GetParameters} $R1
  ${If} $R1 == "--wsl-status"
    Call StandInStatus
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
  ${Else}
    StrCpy $TxrWslOutcome "bad-scenario"
  ${EndIf}
  Call WriteResult
  SetAutoClose true
SectionEnd
