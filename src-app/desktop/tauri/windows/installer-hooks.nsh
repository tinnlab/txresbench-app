; TxResBench: hooks into Tauri's NSIS installer (tauri.windows.conf.json,
; bundle.windows.nsis.installerHooks). Tauri includes this file near the top of
; its installer.nsi and inserts NSIS_HOOK_POSTINSTALL at the end of its Install
; section, after the app's files, registry keys and shortcuts.
;
; Methods run in the app's own WSL 2 distro, which the app imports by itself
; without admin rights; what the PC must have is WSL itself. After the app is
; installed, this hook:
;   1. does nothing on an update or an unattended install (/UPDATE, /P, /S):
;      the app's updater runs this installer with /UPDATE (and /P or /S), and an
;      update must never ask anything or need admin rights. The flags are read
;      from the command line here, not from the template's variables;
;   2. asks the app what WSL this PC has: `txresbench-desktop.exe --wsl-status`
;      (src-app/server/src/modules/sandbox/wsl_status.rs; the same checks as the
;      app's own) exits with one of the TXR_WSL_* codes below;
;   3. when WSL is missing or too old, asks the user, then runs wsl.exe as
;      administrator (one UAC prompt) to install or update WSL from Microsoft;
;   4. offers a restart on the finish page when Windows needs one.
; The app is installed whatever happens here; the app's own check says what is
; missing when it starts. Uninstalling the app never touches WSL: this file has
; no uninstall hook.
;
; The installer is a 32-bit program, and wsl.exe exists only in the 64-bit
; System32. So what runs as administrator is the 32-bit cmd.exe (SysWOW64),
; which starts the real wsl.exe through the Sysnative alias; both are Windows'
; own programs, and nothing from a folder the user can write to runs elevated.
; Only the System plug-in, which Tauri ships and signs, is used.

!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh

; The exit codes of `txresbench-desktop.exe --wsl-status`
; (WslStatus in wsl_status.rs; tests/installer_hooks.rs checks both lists).
!define TXR_WSL_READY 0
!define TXR_WSL_UNSUPPORTED 2
!define TXR_WSL_READY_AFTER_RESTART 20
!define TXR_WSL_MISSING 21
!define TXR_WSL_OLD 22
!define TXR_WSL_LEGACY 23
!define TXR_WSL_NO_WSL_EXE 24
!define TXR_WSL_EMULATED 25
!define TXR_WSL_POLICY 26

!define TXR_MSG_ASK_INSTALL "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux), which is not installed on this computer.$\r$\n$\r$\nInstall WSL 2 now? Windows will ask for permission, then download it from Microsoft (about 400 MB). Windows usually needs a restart afterwards.$\r$\n$\r$\nIf you choose No, TxResBench is still installed, but it cannot run methods until WSL 2 is installed."
!define TXR_MSG_ASK_UPDATE_OLD "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux). The WSL on this computer is too old: it has a known security flaw that newer versions fix.$\r$\n$\r$\nUpdate WSL now? Windows will ask for permission, then download the update from Microsoft. Linux programs running in WSL will be closed.$\r$\n$\r$\nIf you choose No, TxResBench is still installed, but it cannot run methods until WSL is updated."
!define TXR_MSG_ASK_UPDATE_LEGACY "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux). The WSL on this computer is an older kind that TxResBench cannot use.$\r$\n$\r$\nUpdate WSL now? Windows will ask for permission, then download the update from Microsoft. Linux programs running in WSL will be closed, and Windows may need a restart afterwards.$\r$\n$\r$\nIf you choose No, TxResBench is still installed, but it cannot run methods until WSL is updated."
!define TXR_MSG_NO_PERMISSION "WSL 2 was not installed because Windows did not get permission. TxResBench is installed, but it cannot run methods yet.$\r$\n$\r$\nTo install WSL 2 later, run this installer again, or open PowerShell as administrator, run: wsl --install --no-distribution, and restart Windows."
!define TXR_MSG_FAILED "WSL 2 could not be set up. TxResBench is installed, but it cannot run methods yet.$\r$\n$\r$\nCheck the internet connection and run this installer again, or open PowerShell as administrator, run: wsl --install --no-distribution, and restart Windows. On a computer managed by an organization, WSL may be turned off; ask your IT department."
!define TXR_MSG_POLICY "TxResBench runs methods inside WSL 2, which your organization has turned off on this computer. TxResBench is installed, but it cannot run methods here. Ask your IT department to allow WSL."
!define TXR_MSG_NO_WSL_EXE "TxResBench runs methods inside WSL 2, which this version of Windows cannot install by itself. TxResBench is installed; to install WSL, see https://learn.microsoft.com/windows/wsl/install-manual"
!define TXR_MSG_EMULATED "This is the x64 version of TxResBench on an ARM64 computer. It is installed, but it cannot run methods here."
!define TXR_MSG_REBOOT_FAILED "Windows could not be restarted from here. Restart Windows yourself to finish setting up WSL 2."

; The finish page when a restart is needed (MUI2 shows these instead of its
; check boxes while the reboot flag is set): "Restart later" is preselected.
!define MUI_FINISHPAGE_REBOOTLATER_DEFAULT
!define MUI_FINISHPAGE_TEXT_REBOOT "TxResBench is installed.$\r$\n$\r$\nWindows must restart to finish setting up WSL 2, which TxResBench uses to run methods."
!define MUI_FINISHPAGE_TEXT_REBOOTNOW "Restart now"
!define MUI_FINISHPAGE_TEXT_REBOOTLATER "Restart later"

Var TxrWslSkipped       ; 1: an update or an unattended install, no WSL step
Var TxrWslStatusCmd     ; the check's command line
Var TxrWslCode          ; the check's exit code, or "error"
Var TxrWslFirstCode     ; the first check's code
Var TxrWslAction        ; "", "install" or "update"
Var TxrWslOutcome       ; what happened, in one word (the log and the tests)
Var TxrElevFile         ; the program to run as administrator
Var TxrWslInstallParams ; its parameters to install WSL
Var TxrWslUpdateParams  ; its parameters to update WSL
Var TxrElevParams       ; the parameters of this run
Var TxrElevStarted      ; 1: it ran
Var TxrElevError        ; the Windows error when it did not start (1223: the user said No)
Var TxrElevExit         ; its exit code when it ran

!macro NSIS_HOOK_POSTINSTALL
  Call TxrWslSkip
  ${If} $TxrWslSkipped <> 1
    StrCpy $TxrWslStatusCmd '"$INSTDIR\${MAINBINARYNAME}.exe" --wsl-status'
    StrCpy $TxrElevFile "$WINDIR\SysWOW64\cmd.exe"
    StrCpy $TxrWslInstallParams '/d /s /c ""$WINDIR\Sysnative\wsl.exe" --install --no-distribution"'
    StrCpy $TxrWslUpdateParams '/d /s /c ""$WINDIR\Sysnative\wsl.exe" --update && "$WINDIR\Sysnative\wsl.exe" --install --no-distribution"'
    Call TxrWslSetup
  ${EndIf}
!macroend

; Sets $TxrWslSkipped: 1 on an update (/UPDATE), a passive (/P) or silent (/S)
; install, or 32-bit Windows (where the app cannot run).
Function TxrWslSkip
  Push $R0
  Push $R1
  StrCpy $TxrWslSkipped 0
  StrCpy $TxrWslOutcome ""
  ${GetParameters} $R1
  ClearErrors
  ${GetOptions} $R1 "/UPDATE" $R0
  ${IfNot} ${Errors}
    StrCpy $TxrWslSkipped 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R1 "/P" $R0
  ${IfNot} ${Errors}
    StrCpy $TxrWslSkipped 1
  ${EndIf}
  ${If} ${Silent}
    StrCpy $TxrWslSkipped 1
  ${EndIf}
  ${IfNot} ${RunningX64}
    StrCpy $TxrWslSkipped 1
  ${EndIf}
  ${If} $TxrWslSkipped = 1
    StrCpy $TxrWslOutcome "skipped"
    DetailPrint "WSL check skipped (an update or an unattended install)."
  ${EndIf}
  Pop $R1
  Pop $R0
FunctionEnd

; Runs $TxrWslStatusCmd and sets $TxrWslCode.
Function TxrWslRunStatus
  ClearErrors
  ExecWait '$TxrWslStatusCmd' $TxrWslCode
  ${If} ${Errors}
    StrCpy $TxrWslCode "error"
  ${EndIf}
  DetailPrint "WSL check: code $TxrWslCode."
FunctionEnd

; The WSL step: check, ask, install or update, check again, offer a restart.
Function TxrWslSetup
  StrCpy $TxrWslAction ""
  DetailPrint "Checking for WSL 2..."
  Call TxrWslRunStatus
  StrCpy $TxrWslFirstCode $TxrWslCode
  ${If} $TxrWslCode == ${TXR_WSL_READY}
    StrCpy $TxrWslOutcome "ready"
    DetailPrint "WSL 2 is ready."
  ${ElseIf} $TxrWslCode == ${TXR_WSL_READY_AFTER_RESTART}
    StrCpy $TxrWslOutcome "restart"
    DetailPrint "WSL 2 is installed; Windows must restart before TxResBench can use it."
    Call TxrWslOfferRestart
  ${ElseIf} $TxrWslCode == ${TXR_WSL_MISSING}
    StrCpy $TxrWslOutcome "declined"
    MessageBox MB_YESNO|MB_ICONQUESTION "${TXR_MSG_ASK_INSTALL}" /SD IDNO IDNO +2
    StrCpy $TxrWslAction "install"
  ${ElseIf} $TxrWslCode == ${TXR_WSL_OLD}
    StrCpy $TxrWslOutcome "declined"
    MessageBox MB_YESNO|MB_ICONQUESTION "${TXR_MSG_ASK_UPDATE_OLD}" /SD IDNO IDNO +2
    StrCpy $TxrWslAction "update"
  ${ElseIf} $TxrWslCode == ${TXR_WSL_LEGACY}
    StrCpy $TxrWslOutcome "declined"
    MessageBox MB_YESNO|MB_ICONQUESTION "${TXR_MSG_ASK_UPDATE_LEGACY}" /SD IDNO IDNO +2
    StrCpy $TxrWslAction "update"
  ${ElseIf} $TxrWslCode == ${TXR_WSL_NO_WSL_EXE}
    StrCpy $TxrWslOutcome "no-wsl-exe"
    MessageBox MB_OK|MB_ICONINFORMATION "${TXR_MSG_NO_WSL_EXE}" /SD IDOK
  ${ElseIf} $TxrWslCode == ${TXR_WSL_EMULATED}
    StrCpy $TxrWslOutcome "emulated"
    MessageBox MB_OK|MB_ICONINFORMATION "${TXR_MSG_EMULATED}" /SD IDOK
  ${ElseIf} $TxrWslCode == ${TXR_WSL_POLICY}
    StrCpy $TxrWslOutcome "policy"
    MessageBox MB_OK|MB_ICONINFORMATION "${TXR_MSG_POLICY}" /SD IDOK
  ${Else}
    ; Includes TXR_WSL_UNSUPPORTED and a check that could not run.
    StrCpy $TxrWslOutcome "unknown"
    DetailPrint "Could not check for WSL 2 (code $TxrWslCode). TxResBench checks again when it starts."
  ${EndIf}
  ${If} $TxrWslAction == "install"
    StrCpy $TxrElevParams $TxrWslInstallParams
    Call TxrWslElevate
  ${ElseIf} $TxrWslAction == "update"
    StrCpy $TxrElevParams $TxrWslUpdateParams
    Call TxrWslElevate
  ${ElseIf} $TxrWslOutcome == "declined"
    DetailPrint "WSL 2 was not set up (the user chose not to)."
  ${EndIf}
FunctionEnd

; Runs $TxrElevFile with $TxrElevParams as administrator, checks again, and
; says what happened.
Function TxrWslElevate
  DetailPrint "Setting up WSL 2 from Microsoft. This can take several minutes; a separate window shows the progress."
  Call TxrRunElevated
  ${If} $TxrElevStarted <> 1
    ${If} $TxrElevError == 1223
      StrCpy $TxrWslOutcome "no-permission"
      DetailPrint "WSL 2 was not set up: Windows did not get permission."
      MessageBox MB_OK|MB_ICONINFORMATION "${TXR_MSG_NO_PERMISSION}" /SD IDOK
    ${Else}
      StrCpy $TxrWslOutcome "not-started"
      DetailPrint "The WSL setup could not start (Windows error $TxrElevError)."
      MessageBox MB_OK|MB_ICONEXCLAMATION "${TXR_MSG_FAILED}$\r$\n$\r$\n(Windows error $TxrElevError)" /SD IDOK
    ${EndIf}
    Return
  ${EndIf}
  DetailPrint "The WSL setup ended with code $TxrElevExit."
  Call TxrWslRunStatus
  ${If} $TxrWslCode == ${TXR_WSL_READY}
  ${OrIf} $TxrWslCode == ${TXR_WSL_READY_AFTER_RESTART}
    StrCpy $TxrWslOutcome "set-up"
    DetailPrint "WSL 2 is set up."
    ; wsl.exe exits with 0 also when Windows must restart (it only prints so).
    ; A restart is due when the check says so, and after WSL was installed
    ; where it was missing or of the old kind (the Virtual Machine Platform is
    ; turned on then).
    ${If} $TxrWslCode == ${TXR_WSL_READY_AFTER_RESTART}
    ${OrIf} $TxrWslFirstCode == ${TXR_WSL_MISSING}
    ${OrIf} $TxrWslFirstCode == ${TXR_WSL_LEGACY}
      Call TxrWslOfferRestart
    ${EndIf}
  ${Else}
    StrCpy $TxrWslOutcome "failed"
    DetailPrint "WSL 2 was not set up (setup code $TxrElevExit, check code $TxrWslCode)."
    MessageBox MB_OK|MB_ICONEXCLAMATION "${TXR_MSG_FAILED}$\r$\n$\r$\n(The setup ended with code $TxrElevExit.)" /SD IDOK
  ${EndIf}
FunctionEnd

; The finish page asks "Restart now / Restart later". With the reboot flag set,
; that page shows no check boxes, so the desktop shortcut its (checked) box
; would create is created here (Tauri's own function; it skips /NS and updates).
Function TxrWslOfferRestart
  SetRebootFlag true
  Call CreateOrUpdateDesktopShortcut
FunctionEnd

; Runs $TxrElevFile with $TxrElevParams through ShellExecuteEx "runas" and waits.
; Out: $TxrElevStarted (1: it ran), $TxrElevError (Windows' error when it did
; not start), $TxrElevExit (its exit code when it ran).
Function TxrRunElevated
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrCpy $TxrElevStarted 0
  StrCpy $TxrElevError 0
  StrCpy $TxrElevExit ""
  StrCpy $R3 $TxrElevFile
  StrCpy $R4 $TxrElevParams
  StrCpy $R5 $WINDIR
  ; SHELLEXECUTEINFOW: cbSize, fMask, hwnd, lpVerb, lpFile, lpParameters,
  ; lpDirectory, nShow, hInstApp, lpIDList, lpClass, hkeyClass, dwHotKey,
  ; hIcon, hProcess. fMask 0x540 = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC |
  ; SEE_MASK_FLAG_NO_UI; nShow 1 = SW_SHOWNORMAL (the window shows wsl.exe's
  ; progress).
  System::Call '*(&l4, i 0x540, p $HWNDPARENT, w "runas", w R3, w R4, w R5, i 1, p 0, p 0, p 0, p 0, i 0, p 0, p 0) p .R0'
  System::Call 'shell32::ShellExecuteExW(p R0) i .R1 ?e'
  Pop $R2
  ${If} $R1 = 0
    StrCpy $TxrElevError $R2
  ${Else}
    StrCpy $TxrElevStarted 1
    System::Call '*$R0(i, i, p, p, p, p, p, i, p, p, p, p, i, p, p .R1)'
    ${If} $R1 <> 0
      System::Call 'kernel32::WaitForSingleObject(p R1, i -1) i .R2'
      System::Call 'kernel32::GetExitCodeProcess(p R1, *i .R2) i'
      StrCpy $TxrElevExit $R2
      System::Call 'kernel32::CloseHandle(p R1)'
    ${Else}
      StrCpy $TxrElevExit "unknown"
    ${EndIf}
  ${EndIf}
  System::Free $R0
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function .onRebootFailed
  MessageBox MB_OK|MB_ICONEXCLAMATION "${TXR_MSG_REBOOT_FAILED}" /SD IDOK
FunctionEnd
