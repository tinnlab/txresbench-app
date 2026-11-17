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
;     harmless parameters in the "elevate" scenarios.
;
;   txr-harness.exe /WORK=<dir> /SCENARIO=<name> [/S] [/P] [/UPDATE] [/AUTO]
;
; Scenarios (each writes <work>\result.txt, one key=value per line):
;   hook        the production NSIS_HOOK_POSTINSTALL, as Tauri inserts it
;   flow        TxrWslSetup with the production commands, past the skip check
;               (questions take their /SD answer "No" in silent mode)
;   elevate     TxrRunElevated: SysWOW64\cmd.exe as administrator runs
;               Sysnative\whoami.exe /groups > <work>\elev-groups.txt, exit 7
;   elevate-flow TxrWslElevate (the "Yes" path) with the harmless parameters
;               of "elevate"; the check after it reads status-codes.txt
; /AUTO closes the harness without its finish page (for unattended runs).
;
; Build: makensis -WX -DTXR_HOOKS=<path of installer-hooks.nsh> hook-harness.nsi

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
Name "TxResBench hook harness"
OutFile "txr-harness.exe"
InstallDir "$TEMP\txr-harness"
ShowInstDetails show

!define MAINBINARYNAME "txr-harness-app"

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include TextFunc.nsh
!include "${TXR_HOOKS}"

Var Work
Var Scenario
Var Shortcut

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

Function SkipFinishIfAuto
  Push $R0
  Push $R1
  ${GetParameters} $R1
  ClearErrors
  ${GetOptions} $R1 "/AUTO" $R0
  ${IfNot} ${Errors}
    Pop $R1
    Pop $R0
    Abort
  ${EndIf}
  Pop $R1
  Pop $R0
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
  FileOpen $0 "$Work\result.txt" w
  FileWrite $0 "scenario=$Scenario$\r$\n"
  FileWrite $0 "skipped=$TxrWslSkipped$\r$\n"
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
  CopyFiles /SILENT "$EXEPATH" "$Work\${MAINBINARYNAME}.exe"
  ${If} $Scenario == "hook"
    !insertmacro NSIS_HOOK_POSTINSTALL
  ${ElseIf} $Scenario == "flow"
    StrCpy $TxrWslStatusCmd '"$INSTDIR\${MAINBINARYNAME}.exe" --wsl-status'
    StrCpy $TxrElevFile "$WINDIR\SysWOW64\cmd.exe"
    StrCpy $TxrWslInstallParams '/d /s /c "exit 0"'
    StrCpy $TxrWslUpdateParams '/d /s /c "exit 0"'
    Call TxrWslSetup
  ${ElseIf} $Scenario == "elevate"
    Call HarmlessElevation
    Call TxrRunElevated
  ${ElseIf} $Scenario == "elevate-flow"
    StrCpy $TxrWslStatusCmd '"$INSTDIR\${MAINBINARYNAME}.exe" --wsl-status'
    Call TxrWslRunStatus
    StrCpy $TxrWslFirstCode $TxrWslCode
    Call HarmlessElevation
    Call TxrWslElevate
  ${Else}
    StrCpy $TxrWslOutcome "bad-scenario"
  ${EndIf}
  Call WriteResult
  SetAutoClose true
SectionEnd
