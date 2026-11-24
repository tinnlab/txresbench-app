; TxResBench: hooks into Tauri's NSIS installer (tauri.windows.conf.json,
; bundle.windows.nsis.installerHooks). Tauri includes this file near the top of
; its installer.nsi, before its pages, and inserts NSIS_HOOK_POSTINSTALL at the
; end of its Install section, after the app's files, registry keys and
; shortcuts, and NSIS_HOOK_POSTUNINSTALL at the end of its Uninstall section.
;
; Methods run in the app's own WSL 2 distro, which the app imports by itself
; without admin rights; what the PC must have is WSL itself. After the app is
; installed, this hook:
;   1. does nothing on an update or an unattended install (/UPDATE, /P, /S):
;      the app's updater runs this installer with /UPDATE (and /P or /S), and an
;      update must never ask anything or need admin rights. The flags are read
;      from the command line here, not from the template's variables. It also
;      does nothing on 32-bit Windows, and when the installer itself runs as
;      administrator or Windows does not say whether it does (see below);
;   2. asks the app what WSL this PC has: `txresbench-desktop.exe --wsl-status`
;      (src-app/server/src/modules/sandbox/wsl_status.rs; the same checks as the
;      app's own) exits with one of the TXR_WSL_* codes below;
;   3. when WSL is missing or too old, or its Virtual Machine Platform is not
;      running, asks the user, then runs wsl.exe as administrator (one UAC
;      prompt) to install or update WSL from Microsoft, or to turn the Virtual
;      Machine Platform on;
;   4. offers a restart on the finish page when Windows needs one.
; The app is installed whatever happens here; the app's own check says what is
; missing when it starts. When the uninstaller's "Delete app data" box is
; ticked and this is not an update, this hook also unregisters the app's own
; WSL distro (TxResBench) and removes its then-empty directory; with the box
; not ticked nothing about uninstalling changes: WSL itself and every other
; distro are never touched, and the distro stays as today.
;
; The installer is a 32-bit program, and wsl.exe exists only in the 64-bit
; System32. So what runs as administrator is the 32-bit cmd.exe (SysWOW64),
; which starts the real wsl.exe through the Sysnative alias; both are Windows'
; own programs. The check runs the app from its install folder, which the user
; can write to, so it must never run with rights the user does not have: when
; this installer itself runs as administrator (Run as administrator, an
; elevated terminal: an elevated token, TokenElevationTypeFull), the hook does
; nothing, nor when Windows does not say what the token is. With UAC turned off
; (TokenElevationTypeDefault) no prompt separates the user from administrator
; rights, and the hook runs as usual.
; Two plug-ins are used: System, which Tauri ships and signs (the elevation
; type), and nsExec, a standard NSIS plug-in (part of the NSIS Tauri bundles),
; to run wsl.exe hidden in the uninstaller.

; The restart texts below are read by the first finish page inserted after
; them. MUI2 defines this name when it inserts a finish page that can offer a
; restart (Finish.nsh): if it is there, Tauri's template has moved this file
; below its finish page. NSIS_HOOK_POSTINSTALL checks the other side: by the
; Install section, after the pages, such a finish page must be there.
!ifdef MUI_FINISHPAGE_REBOOT_VARIABLES
  !error "installer-hooks.nsh is included after the finish page: its restart texts would not apply"
!endif

!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh

; What the uninstall hook removes, and with what. The defaults are the
; production values; the test harness overrides them (it defines them before
; including this file, or with makensis -D), so it never runs the real wsl.exe
; or reads WSL's real Lxss key.
; - TXR_LXSS_KEY: where WSL keeps this user's distro entries
;   (HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss, each subkey a
;   {guid} with DistributionName and BasePath), the same data the app uses
;   (`wsl_run.rs`).
; - TXR_UNREG_WSL_EXE: wsl.exe, reached through the Sysnative alias: this installer
;   and uninstaller are 32-bit, and wsl.exe lives in the 64-bit System32 (the
;   install hook starts it the same way).
; - TXR_DISTRO: the app's own distro, the constant used for `wsl -d` in the
;   app (WSL_DISTRO in wsl_run.rs); only that exact name is matched.
!ifndef TXR_LXSS_KEY
  !define TXR_LXSS_KEY "Software\Microsoft\Windows\CurrentVersion\Lxss"
!endif
!ifndef TXR_UNREG_WSL_EXE
  !define TXR_UNREG_WSL_EXE "$WINDIR\Sysnative\wsl.exe"
!endif
!ifndef TXR_DISTRO
  !define TXR_DISTRO "TxResBench"
!endif

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
!define TXR_MSG_ASK_TURN_ON "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux). WSL is installed on this computer, but the Windows component WSL 2 needs (Virtual Machine Platform) is not running: it is turned off, or Windows has not restarted since it was turned on.$\r$\n$\r$\nTurn it on now? Windows will ask for permission, then turn it on. Windows needs a restart afterwards.$\r$\n$\r$\nIf you choose No, TxResBench is still installed, but it cannot run methods until the Virtual Machine Platform is on and Windows has restarted."
!define TXR_MSG_ASK_UPDATE_OLD "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux). The WSL on this computer is too old: it has a known security flaw that newer versions fix.$\r$\n$\r$\nUpdate WSL now? Windows will ask for permission, then download the update from Microsoft (about 400 MB). Linux programs running in WSL will be closed.$\r$\n$\r$\nIf you choose No, TxResBench is still installed, but it cannot run methods until WSL is updated."
!define TXR_MSG_ASK_UPDATE_LEGACY "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux). The WSL on this computer is an older kind that TxResBench cannot use.$\r$\n$\r$\nUpdate WSL now? Windows will ask for permission, then download the update from Microsoft (about 400 MB). Linux programs running in WSL will be closed, and Windows may need a restart afterwards.$\r$\n$\r$\nIf you choose No, TxResBench is still installed, but it cannot run methods until WSL is updated."
!define TXR_MSG_NO_PERMISSION_INSTALL "WSL 2 was not set up because Windows did not get permission. TxResBench is installed, but it cannot run methods yet.$\r$\n$\r$\nTo set up WSL 2 later, run this installer again, or open PowerShell as administrator, run: wsl --install --no-distribution, and restart Windows."
!define TXR_MSG_NO_PERMISSION_UPDATE "WSL was not updated because Windows did not get permission. TxResBench is installed, but it cannot run methods yet.$\r$\n$\r$\nTo update WSL later, run this installer again, or open PowerShell as administrator, run: wsl --update, then: wsl --install --no-distribution, and restart Windows."
!define TXR_MSG_FAILED_INSTALL "WSL 2 could not be set up. TxResBench is installed, but it cannot run methods yet.$\r$\n$\r$\nCheck the internet connection and run this installer again, or open PowerShell as administrator, run: wsl --install --no-distribution, and restart Windows. On a computer managed by an organization, WSL may be turned off; ask your IT department."
!define TXR_MSG_FAILED_TURN_ON "The Windows component WSL 2 needs (Virtual Machine Platform) could not be turned on. TxResBench is installed, but it cannot run methods yet.$\r$\n$\r$\nRun this installer again, or open PowerShell as administrator, run: wsl --install --no-distribution, and restart Windows. On a computer managed by an organization, the component may be blocked; ask your IT department."
!define TXR_MSG_FAILED_UPDATE "WSL could not be updated. TxResBench is installed, but it cannot run methods yet.$\r$\n$\r$\nCheck the internet connection and run this installer again, or open PowerShell as administrator, run: wsl --update, then: wsl --install --no-distribution, and restart Windows. On a computer managed by an organization, WSL may be turned off; ask your IT department."
!define TXR_MSG_POLICY "TxResBench runs methods inside WSL 2, which your organization has turned off on this computer. TxResBench is installed, but it cannot run methods here. Ask your IT department to allow WSL."
!define TXR_MSG_NO_WSL_EXE "TxResBench runs methods inside WSL 2, which this version of Windows cannot install by itself. TxResBench is installed; to install WSL, see https://learn.microsoft.com/windows/wsl/install-manual"
!define TXR_MSG_EMULATED "This is the x64 version of TxResBench on an ARM64 computer. It is installed, but it cannot run methods here."
!define TXR_MSG_REBOOT_FAILED "Windows could not be restarted from here. Restart Windows yourself to finish setting up WSL 2."

; The finish page when a restart is needed (MUI2 shows these instead of its
; check boxes while the reboot flag is set): "Restart later" is preselected.
!define MUI_FINISHPAGE_REBOOTLATER_DEFAULT
!define MUI_FINISHPAGE_TEXT_REBOOT "TxResBench is installed. Windows must restart to finish setting up WSL 2, which TxResBench uses to run methods. TxResBench checks WSL again when it starts."
!define MUI_FINISHPAGE_TEXT_REBOOTNOW "Restart now"
!define MUI_FINISHPAGE_TEXT_REBOOTLATER "Restart later"

Var TxrWslSkipped         ; 1: no WSL step (an update, an unattended install, 32-bit Windows, run as administrator or not known)
Var TxrElevationType      ; this installer's TOKEN_ELEVATION_TYPE (2: run as administrator), 0 if unknown
Var TxrWslStatusCmd       ; the check's command line
Var TxrWslCode            ; the check's exit code, or "error"
Var TxrWslFirstCode       ; the first check's code
Var TxrWslAction          ; "", "install", "turn-on" or "update"
Var TxrWslOutcome         ; what happened, in one word (the log and the tests)
Var TxrElevFile           ; the program to run as administrator
Var TxrWslInstallParams   ; its parameters to install WSL (or turn its Windows component on)
Var TxrWslUpdateParams    ; its parameters to update WSL
Var TxrElevParams         ; the parameters of this run
Var TxrWslMsgNoPermission ; what to say when Windows did not get permission for this run
Var TxrWslMsgFailed       ; what to say when this run failed
Var TxrElevStarted        ; 1: it ran
Var TxrElevError          ; the Windows error when it did not start (1223: the user said No)
Var TxrElevExit           ; its exit code when it ran, "" if not known

; The uninstall hook. Tauri's template declares the two variables it reads
; ($DeleteAppDataCheckboxState, $UpdateMode); these are this file's own.
Var TxrWslUnregFound      ; the Lxss subkey whose DistributionName is the app's distro; "" when none
Var TxrWslUnregSubkey     ; the Lxss subkey being looked at
Var TxrWslUnregName       ; its DistributionName value
Var TxrWslUnregBasePath   ; its BasePath value (the distro's directory)
Var TxrWslUnregIndex      ; the EnumRegKey index
Var TxrWslUnregExit       ; the exit code of `wsl --unregister` ("error" when it could not run)

!macro NSIS_HOOK_POSTINSTALL
  ; Tauri's template defines it; without it the check could not find the app.
  !ifndef MAINBINARYNAME
    !error "installer-hooks.nsh: the installer template no longer defines MAINBINARYNAME"
  !endif
  ; The restart is offered on the finish page; without a finish page, or with
  ; one that has no restart support (MUI_FINISHPAGE_NOREBOOTSUPPORT), the offer
  ; would silently disappear.
  !ifndef MUI_FINISHPAGE_REBOOT_VARIABLES
    !error "installer-hooks.nsh: the installer has no finish page that can offer a restart"
  !endif
  Call TxrWslSkip
  ${If} $TxrWslSkipped <> 1
    StrCpy $TxrWslStatusCmd '"$INSTDIR\${MAINBINARYNAME}.exe" --wsl-status'
    StrCpy $TxrElevFile "$WINDIR\SysWOW64\cmd.exe"
    StrCpy $TxrWslInstallParams '/d /s /c ""$WINDIR\Sysnative\wsl.exe" --install --no-distribution"'
    StrCpy $TxrWslUpdateParams '/d /s /c ""$WINDIR\Sysnative\wsl.exe" --update && "$WINDIR\Sysnative\wsl.exe" --install --no-distribution"'
    Call TxrWslSetup
  ${EndIf}
!macroend

; The uninstaller's counterpart of the install hook, run by Tauri's template
; at the end of its Section Uninstall (NSIS_HOOK_POSTUNINSTALL, after the
; template checked that the app is closed, deleted the app files and made the
; "Delete app data" page's removals — the two variables it reads are set there
; and are reliable here and only here):
;   $DeleteAppDataCheckboxState is set on the Confirm page's leave callback
;   (un.ConfirmLeave sends BM_GETCHECK); when that page is skipped — a silent
;   (/S), passive (/P) or update (/UPDATE) run — it is never set, so it also
;   guards those;
;   $UpdateMode is set by un.onInit from /UPDATE, exactly as the template's
;   own "Delete app data" block reads it: the updater runs this installer and
;   the old uninstaller with /UPDATE (and /P or /S) and an update must never
;   remove the user's WSL distro.
; With the box ticked and outside an update, the app's own WSL distro is
; unregistered (`wsl --unregister TxResBench` deletes the distro and its disk,
; ext4.vhdx), as the current user: a user's distro is unregistered by that
; user, so this never asks for administrator rights — nsExec runs hidden, in
; this process's token. The distro is found by its exact name, so another
; distro is never touched, and WSL itself (the program) is never touched. The
; then-empty distro directory is removed with RMDir, never RMDir /r, so a
; directory with anything else in it stays. Whatever wsl.exe says, the
; uninstall continues: a failure is logged, never shown or re-run.
; The whole body lives here, not in an `un.` function, because the harness
; (hook-harness.nsi) reuses exactly this macro from its own Install section.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Find the Lxss subkey whose DistributionName is exactly the app's distro
    ; (EnumRegKey + ReadRegStr, no reg.exe). Only when one exists is anything
    ; done: the app's distro is the one a TxResBench entry names.
    StrCpy $TxrWslUnregFound ""
    StrCpy $TxrWslUnregIndex 0
    ${Do}
      ClearErrors
      EnumRegKey $TxrWslUnregSubkey HKCU "${TXR_LXSS_KEY}" $TxrWslUnregIndex
      ${If} ${Errors}
        StrCpy $TxrWslUnregSubkey ""
      ${EndIf}
      ${If} $TxrWslUnregSubkey == ""
        ${Break}
      ${EndIf}
      IntOp $TxrWslUnregIndex $TxrWslUnregIndex + 1
      ReadRegStr $TxrWslUnregName HKCU "${TXR_LXSS_KEY}\$TxrWslUnregSubkey" "DistributionName"
      ; S== is the case-sensitive compare: only the exact name is the app's distro.
      ${If} $TxrWslUnregName S== "${TXR_DISTRO}"
        StrCpy $TxrWslUnregFound $TxrWslUnregSubkey
        ${Break}
      ${EndIf}
    ${Loop}
    ${If} $TxrWslUnregFound != ""
      ReadRegStr $TxrWslUnregBasePath HKCU "${TXR_LXSS_KEY}\$TxrWslUnregFound" "BasePath"
      nsExec::Exec '"${TXR_UNREG_WSL_EXE}" --unregister ${TXR_DISTRO}'
      Pop $TxrWslUnregExit
      ; wsl.exe removed the distro and its disk; the BasePath directory is
      ; empty then. RMDir takes only an empty directory, so anything still in
      ; it (or an unregister that failed) leaves it as is.
      ${If} $TxrWslUnregBasePath != ""
        ClearErrors
        RMDir "$TxrWslUnregBasePath"
      ${EndIf}
      DetailPrint "TxResBench's WSL distro was unregistered (wsl.exe exit code $TxrWslUnregExit)."
    ${EndIf}
  ${EndIf}
!macroend

; Sets $TxrWslSkipped to 1, and says why, when there is no WSL step: on an
; update (/UPDATE), a passive (/P) or silent (/S) install; on 32-bit Windows
; (where the app cannot run); and when this installer runs as administrator, or
; its token's elevation type cannot be read.
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
  ${If} $TxrWslSkipped = 1
    StrCpy $TxrWslOutcome "skipped"
    DetailPrint "WSL check skipped (an update or an unattended install)."
  ${ElseIfNot} ${RunningX64}
    StrCpy $TxrWslSkipped 1
    StrCpy $TxrWslOutcome "skipped-32-bit"
    DetailPrint "WSL check skipped: this is 32-bit Windows, where TxResBench cannot run methods."
  ${Else}
    Call TxrReadElevationType
    ; Only a token known not to be elevated runs the check: 1 (UAC off) or 3
    ; (the usual start).
    ${If} $TxrElevationType <> 1
    ${AndIf} $TxrElevationType <> 3
      StrCpy $TxrWslSkipped 1
      ${If} $TxrElevationType = 2
        StrCpy $TxrWslOutcome "skipped-elevated"
        DetailPrint "WSL check skipped: this installer runs as administrator. TxResBench checks WSL when it starts; to set WSL up from here, run this installer again without administrator rights."
      ${Else}
        StrCpy $TxrWslOutcome "skipped-elevation-unknown"
        DetailPrint "WSL check skipped: Windows did not say whether this installer runs as administrator (elevation type $TxrElevationType). TxResBench checks WSL when it starts."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
FunctionEnd

; Sets $TxrElevationType to this installer's TOKEN_ELEVATION_TYPE: 1 default
; (UAC off, or no administrator rights to split off), 2 full (elevated: run as
; administrator), 3 limited (the usual start); 0 when it cannot be read.
Function TxrReadElevationType
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $TxrElevationType 0
  System::Call 'kernel32::GetCurrentProcess() p .R0'
  ; 8 = TOKEN_QUERY; 18 = TokenElevationType.
  System::Call 'advapi32::OpenProcessToken(p R0, i 8, *p .R1) i .R2'
  ${If} $R2 <> 0
    System::Call 'advapi32::GetTokenInformation(p R1, i 18, *i .R3, i 4, *i .R4) i .R2'
    ${If} $R2 <> 0
      StrCpy $TxrElevationType $R3
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p R1)'
  ${EndIf}
  Pop $R4
  Pop $R3
  Pop $R2
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

; The WSL step: check, ask, install, update or turn on, check again, offer a
; restart.
Function TxrWslSetup
  StrCpy $TxrWslAction ""
  DetailPrint "Checking for WSL 2..."
  Call TxrWslRunStatus
  StrCpy $TxrWslFirstCode $TxrWslCode
  ${If} $TxrWslCode == ${TXR_WSL_READY}
    StrCpy $TxrWslOutcome "ready"
    DetailPrint "WSL 2 is ready."
  ${ElseIf} $TxrWslCode == ${TXR_WSL_READY_AFTER_RESTART}
    ; Turned off, or turned on and waiting for a restart: the check cannot tell
    ; which without administrator rights. `wsl --install --no-distribution`
    ; turns on what is off and does nothing more when it is only waiting.
    StrCpy $TxrWslOutcome "declined"
    MessageBox MB_YESNO|MB_ICONQUESTION "${TXR_MSG_ASK_TURN_ON}" /SD IDNO IDNO +2
    StrCpy $TxrWslAction "turn-on"
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
  ${If} $TxrWslAction != ""
    Call TxrWslAct
  ${ElseIf} $TxrWslOutcome == "declined"
    DetailPrint "WSL 2 was not set up (the user chose not to)."
  ${EndIf}
FunctionEnd

; Runs $TxrWslAction ("install", "turn-on" or "update") with its own parameters
; and its own messages, then checks again. Turning the Virtual Machine Platform
; on is `wsl --install --no-distribution` too, but it downloads nothing, so its
; failure says nothing about the internet connection.
Function TxrWslAct
  ${If} $TxrWslAction == "install"
    StrCpy $TxrElevParams $TxrWslInstallParams
    StrCpy $TxrWslMsgNoPermission "${TXR_MSG_NO_PERMISSION_INSTALL}"
    StrCpy $TxrWslMsgFailed "${TXR_MSG_FAILED_INSTALL}"
  ${ElseIf} $TxrWslAction == "turn-on"
    StrCpy $TxrElevParams $TxrWslInstallParams
    StrCpy $TxrWslMsgNoPermission "${TXR_MSG_NO_PERMISSION_INSTALL}"
    StrCpy $TxrWslMsgFailed "${TXR_MSG_FAILED_TURN_ON}"
  ${ElseIf} $TxrWslAction == "update"
    StrCpy $TxrElevParams $TxrWslUpdateParams
    StrCpy $TxrWslMsgNoPermission "${TXR_MSG_NO_PERMISSION_UPDATE}"
    StrCpy $TxrWslMsgFailed "${TXR_MSG_FAILED_UPDATE}"
  ${Else}
    Return
  ${EndIf}
  Call TxrWslElevate
FunctionEnd

; Runs $TxrElevFile with $TxrElevParams as administrator, checks again, and
; says what happened.
Function TxrWslElevate
  DetailPrint "Setting up WSL 2. This can take several minutes; a separate window shows the progress."
  Call TxrRunElevated
  ${If} $TxrElevStarted <> 1
    ${If} $TxrElevError == 1223
      StrCpy $TxrWslOutcome "no-permission"
      DetailPrint "WSL 2 was not set up: Windows did not get permission."
      MessageBox MB_OK|MB_ICONINFORMATION "$TxrWslMsgNoPermission" /SD IDOK
    ${Else}
      StrCpy $TxrWslOutcome "not-started"
      DetailPrint "The WSL setup could not start (Windows error $TxrElevError)."
      MessageBox MB_OK|MB_ICONEXCLAMATION "$TxrWslMsgFailed$\r$\n$\r$\n(Windows error $TxrElevError)" /SD IDOK
    ${EndIf}
    Return
  ${EndIf}
  ${If} $TxrElevExit == ""
    DetailPrint "The WSL setup ended; its exit code is not known."
  ${Else}
    DetailPrint "The WSL setup ended with code $TxrElevExit."
  ${EndIf}
  Call TxrWslRunStatus
  ; WSL 2 works now. After WSL was installed where it was missing or of the
  ; old kind (the Virtual Machine Platform is turned on then), Windows may
  ; still need a restart: wsl.exe exits with 0 also then (it only prints so).
  ${If} $TxrWslCode == ${TXR_WSL_READY}
    StrCpy $TxrWslOutcome "set-up"
    DetailPrint "WSL 2 is set up."
    ${If} $TxrWslFirstCode == ${TXR_WSL_MISSING}
    ${OrIf} $TxrWslFirstCode == ${TXR_WSL_LEGACY}
      Call TxrWslOfferRestart
    ${EndIf}
    Return
  ${EndIf}
  ; Any other answer counts only after a setup that ended without an error.
  ; A second check of READY_AFTER_RESTART cannot tell a component turned on
  ; and waiting for a restart from one still off; where the first check said
  ; the same, the exit code is the only sign that the setup turned it on.
  ; After a setup that failed (or whose window was closed), whatever the first
  ; check said, the hook shows the failed message, which says what to run and
  ; to restart, and offers no restart: a restart is not known to help then,
  ; and the finish page would say Windows must restart to finish setting up.
  ${If} $TxrElevExit == 0
    ${If} $TxrWslCode == ${TXR_WSL_READY_AFTER_RESTART}
      StrCpy $TxrWslOutcome "set-up"
      DetailPrint "WSL 2 is set up; it runs after Windows restarts."
      Call TxrWslOfferRestart
      Return
    ${EndIf}
    ; Where WSL was missing or of the old kind, WSL may answer only after
    ; Windows restarts.
    ${If} $TxrWslFirstCode == ${TXR_WSL_MISSING}
    ${OrIf} $TxrWslFirstCode == ${TXR_WSL_LEGACY}
      ${If} $TxrWslCode == ${TXR_WSL_MISSING}
      ${OrIf} $TxrWslCode == ${TXR_WSL_LEGACY}
        StrCpy $TxrWslOutcome "restart-pending"
        DetailPrint "The WSL setup ended without an error, but WSL 2 answers only after Windows restarts. TxResBench checks WSL again when it starts."
        Call TxrWslOfferRestart
        Return
      ${EndIf}
    ${EndIf}
  ${EndIf}
  StrCpy $TxrWslOutcome "failed"
  DetailPrint "WSL 2 was not set up (check code $TxrWslCode)."
  ${If} $TxrElevExit == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$TxrWslMsgFailed" /SD IDOK
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$TxrWslMsgFailed$\r$\n$\r$\n(The setup ended with code $TxrElevExit.)" /SD IDOK
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
; not start), $TxrElevExit (its exit code when it ran, "" when not known).
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
