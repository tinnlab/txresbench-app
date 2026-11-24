//! The Windows installer's WSL step: the Tauri config that installs the hook
//! (`tauri.windows.conf.json`) and the hook file itself
//! (`windows/installer-hooks.nsh`), checked against what the hook must and must
//! never do. The hook runs only on Windows, inside Tauri's NSIS template; these
//! checks read the files, so they run on every platform.
//!
//! The template the hook was written and tested against: tauri-bundler 2.10.5
//! (@tauri-apps/cli 2.12.5, NSIS 3.13), with tauri-plugin-updater 2.12.0
//! running the installer with `/UPDATE` (and `/P` or `/S`) for updates. The hook
//! leans on that template only where `TEMPLATE_NAMES` says; a new reliance
//! fails `the_hook_relies_on_the_template_only_for_the_listed_names`, and
//! means re-checking the hook in a real `tauri build` (and after any Tauri CLI
//! change).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use txresbench::modules::sandbox::wsl_status::WslStatus;
use txresbench_desktop_lib::installer_cli::WSL_STATUS_ARG;

const WINDOWS_CONF: &str = include_str!("../tauri.windows.conf.json");
const BASE_CONF: &str = include_str!("../tauri.conf.json");
const HOOKS: &str = include_str!("../windows/installer-hooks.nsh");

/// The template's names the hook uses: the function the finish page would
/// otherwise call for the desktop shortcut, the main binary's name, and, for
/// the uninstall hook, the "Delete app data" checkbox's state and the
/// update flag (both set by Tauri's template: Var DeleteAppDataCheckboxState
/// and Var UpdateMode, see installer.nsi's Section Uninstall).
const TEMPLATE_NAMES: [&str; 4] = [
    "CreateOrUpdateDesktopShortcut",
    "MAINBINARYNAME",
    "DeleteAppDataCheckboxState",
    "UpdateMode",
];

/// The hook's lines without comments (`;` outside a string) and blank lines.
fn code_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| {
            let mut quote: Option<char> = None;
            let mut end = line.len();
            for (i, c) in line.char_indices() {
                match quote {
                    Some(q) if c == q => quote = None,
                    Some(_) => {}
                    None if c == '"' || c == '\'' || c == '`' => quote = Some(c),
                    None if c == ';' => {
                        end = i;
                        break;
                    }
                    None => {}
                }
            }
            line[..end].trim().to_string()
        })
        .filter(|l| !l.is_empty())
        .collect()
}

/// The code lines of `!macro <name>` or `Function <name>`, without the
/// opening and closing lines.
fn block(name: &str) -> Vec<String> {
    let lines = code_lines(HOOKS);
    let start = lines
        .iter()
        .position(|l| *l == format!("!macro {name}") || *l == format!("Function {name}"))
        .unwrap_or_else(|| panic!("no block {name}"));
    let end = lines[start..]
        .iter()
        .position(|l| l == "!macroend" || l == "FunctionEnd")
        .map(|n| start + n)
        .unwrap();
    lines[start + 1..end].to_vec()
}

/// The run-time lines of a block: without the compile-time `!` directives.
fn instructions(block: &[String]) -> Vec<String> {
    block.iter().filter(|l| !l.starts_with('!')).cloned().collect()
}

/// The lines from `first` (inclusive) to the next line that is one of `ends`
/// (exclusive), in `lines`.
fn span(lines: &[String], first: &str, ends: &[&str]) -> Vec<String> {
    let start = lines.iter().position(|l| l == first).unwrap_or_else(|| panic!("no line {first}"));
    let end = lines[start + 1..]
        .iter()
        .position(|l| ends.iter().any(|e| l.starts_with(e)))
        .map(|n| start + 1 + n)
        .unwrap_or(lines.len());
    lines[start..end].to_vec()
}

fn json(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn the_windows_config_installs_the_hook_in_a_per_user_installer() {
    let conf = json(WINDOWS_CONF);
    let nsis = &conf["bundle"]["windows"]["nsis"];
    // Per user: the updater reruns this installer, and updates must not need
    // admin rights.
    assert_eq!(nsis["installMode"], "currentUser");
    assert_eq!(nsis["installerHooks"], "windows/installer-hooks.nsh");
    assert_eq!(nsis.as_object().unwrap().len(), 2, "{nsis}");
    let hooks = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows/installer-hooks.nsh");
    assert!(hooks.is_file());
    // The rest of the Windows config is as it was.
    assert_eq!(conf["build"]["beforeBundleCommand"], "npm run verify-wsl-runtime");
    assert_eq!(
        conf["bundle"]["resources"],
        serde_json::json!(["resources/pretrained-bundled", "resources/wsl-runtime"])
    );
    assert!(!WINDOWS_CONF.contains("hook-harness"), "the test harness is never bundled");
    let base = json(BASE_CONF);
    assert_eq!(base["bundle"]["createUpdaterArtifacts"], true);
    assert!(base["bundle"].get("windows").is_none(), "the base config sets no other Windows installer mode");
}

#[test]
fn the_hooks_are_postinstall_and_postuninstall_only() {
    let lines = code_lines(HOOKS);
    let hooks: Vec<&String> = lines.iter().filter(|l| l.starts_with("!macro NSIS_HOOK_")).collect();
    assert_eq!(hooks, ["!macro NSIS_HOOK_POSTINSTALL", "!macro NSIS_HOOK_POSTUNINSTALL"]);
    // Only the template's macro names: PREUNINSTALL is never used, because at
    // that point the app may still be running (CheckIfAppIsRunning comes
    // after) while POSTUNINSTALL runs after the app is closed, the files are
    // gone and the checkbox's state is known.
    assert!(!HOOKS.contains("NSIS_HOOK_PREUNINSTALL"), "the hook has no pre-uninstall macro");
    // No `un.` functions either: the uninstall hook's whole body lives in its
    // macro, so the harness can run the very same code from its Install
    // section (an `un.` function could not be called there).
    assert!(!lines.iter().any(|l| l.starts_with("Function un.")), "no uninstaller code");
}

/// An update (`/UPDATE`), a passive (`/P`) or silent (`/S`) install never
/// checks, asks or elevates: the skip check is the hook's first instruction,
/// everything else depends on it, and it reads the flags itself (a renamed
/// template variable would only be a compiler warning). 32-bit Windows is
/// skipped too, and says so.
#[test]
fn updates_and_unattended_installs_skip_the_wsl_step() {
    let hook = instructions(&block("NSIS_HOOK_POSTINSTALL"));
    assert_eq!(hook[0], "Call TxrWslSkip");
    assert_eq!(hook[1], "${If} $TxrWslSkipped <> 1");
    assert_eq!(hook.last().unwrap(), "${EndIf}");
    let skip = block("TxrWslSkip");
    let at = |needle: &str| {
        skip.iter().position(|l| l == needle).unwrap_or_else(|| panic!("TxrWslSkip lacks {needle}"))
    };
    for check in [r#"${GetOptions} $R1 "/UPDATE" $R0"#, r#"${GetOptions} $R1 "/P" $R0"#] {
        let i = at(check);
        assert_eq!(skip[i + 1], "${IfNot} ${Errors}", "{check}");
        assert_eq!(skip[i + 2], "StrCpy $TxrWslSkipped 1", "{check}");
    }
    assert_eq!(skip[at("${If} ${Silent}") + 1], "StrCpy $TxrWslSkipped 1");
    assert!(at("${GetParameters} $R1") < at(r#"${GetOptions} $R1 "/UPDATE" $R0"#));
    // The flags decide first; then 32-bit Windows; then the token.
    let flags = at("${If} $TxrWslSkipped = 1");
    assert!(at("${If} ${Silent}") < flags);
    assert_eq!(skip[flags + 1], r#"StrCpy $TxrWslOutcome "skipped""#);
    assert_eq!(skip[flags + 2], r#"DetailPrint "WSL check skipped (an update or an unattended install).""#);
    let x86 = at("${ElseIfNot} ${RunningX64}");
    assert_eq!(flags + 3, x86);
    assert_eq!(skip[x86 + 1], "StrCpy $TxrWslSkipped 1");
    assert_eq!(skip[x86 + 2], r#"StrCpy $TxrWslOutcome "skipped-32-bit""#);
    assert!(skip[x86 + 3].starts_with(r#"DetailPrint "WSL check skipped: this is 32-bit Windows,"#), "{}", skip[x86 + 3]);
    assert_eq!(skip[x86 + 4], "${Else}");
    // The install step reads the flags itself, so only the uninstall hook
    // reads the template's update flag (its guard, checked below); the
    // template's passive flag is read by nobody.
    assert!(!HOOKS.contains("$PassiveMode"), "$PassiveMode");
    assert_eq!(code_lines(HOOKS).iter().filter(|l| l.contains("$UpdateMode")).count(), 1, "$UpdateMode");
}

/// When this installer itself runs as administrator (an elevated token,
/// TokenElevationTypeFull = 2), the check would run the app from a folder the
/// user can write to with rights the user does not have: the hook skips, and
/// says so. Only a token known not to be elevated (1: UAC off; 3: the usual
/// start) runs the check; a type Windows did not give (0) skips too.
#[test]
fn an_installer_run_as_administrator_skips_the_check() {
    let skip = block("TxrWslSkip");
    let at = skip.iter().position(|l| l == "Call TxrReadElevationType").expect("the skip reads the token");
    assert_eq!(skip[at - 1], "${Else}");
    let decision = &skip[at + 1..at + 13];
    let expected = [
        "${If} $TxrElevationType <> 1",
        "${AndIf} $TxrElevationType <> 3",
        "StrCpy $TxrWslSkipped 1",
        "${If} $TxrElevationType = 2",
        r#"StrCpy $TxrWslOutcome "skipped-elevated""#,
        r#"DetailPrint "WSL check skipped: this installer runs as administrator. TxResBench checks WSL when it starts; to set WSL up from here, run this installer again without administrator rights.""#,
        "${Else}",
        r#"StrCpy $TxrWslOutcome "skipped-elevation-unknown""#,
        r#"DetailPrint "WSL check skipped: Windows did not say whether this installer runs as administrator (elevation type $TxrElevationType). TxResBench checks WSL when it starts.""#,
        "${EndIf}",
        "${EndIf}",
        "${EndIf}",
    ];
    assert_eq!(decision, expected);
    let lines = code_lines(HOOKS);
    let uses: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("$TxrElevationType") && !l.starts_with("StrCpy $TxrElevationType ") && !l.starts_with("DetailPrint "))
        .collect();
    assert_eq!(
        uses,
        ["${If} $TxrElevationType <> 1", "${AndIf} $TxrElevationType <> 3", "${If} $TxrElevationType = 2"],
        "the type decides only there"
    );

    // TOKEN_QUERY (8) on this process's token, TokenElevationType (18): a
    // DWORD, kept only when the call succeeded (else 0, which skips the check).
    let read = block("TxrReadElevationType");
    let expected = [
        "StrCpy $TxrElevationType 0",
        "System::Call 'kernel32::GetCurrentProcess() p .R0'",
        "System::Call 'advapi32::OpenProcessToken(p R0, i 8, *p .R1) i .R2'",
        "${If} $R2 <> 0",
        "System::Call 'advapi32::GetTokenInformation(p R1, i 18, *i .R3, i 4, *i .R4) i .R2'",
        "${If} $R2 <> 0",
        "StrCpy $TxrElevationType $R3",
        "${EndIf}",
        "System::Call 'kernel32::CloseHandle(p R1)'",
        "${EndIf}",
    ];
    let body: Vec<&String> = read.iter().filter(|l| !l.starts_with("Push ") && !l.starts_with("Pop ")).collect();
    assert_eq!(body, expected);
}

/// Compile-time guards against a changed template (Tauri runs makensis
/// without -WX, so a missing define would only warn): the hook must come
/// before the finish page (its restart texts apply only then), the template
/// must still define MAINBINARYNAME (the check's path), and by the Install
/// section (after the pages) a finish page that can offer a restart must be
/// there: MUI2 defines MUI_FINISHPAGE_REBOOT_VARIABLES only for a finish page
/// without MUI_FINISHPAGE_NOREBOOTSUPPORT, and without one the restart offer
/// would silently disappear.
#[test]
fn the_hook_stops_the_build_when_the_template_changed() {
    let lines = code_lines(HOOKS);
    assert_eq!(lines[0], "!ifdef MUI_FINISHPAGE_REBOOT_VARIABLES");
    assert!(lines[1].starts_with(r#"!error ""#), "{}", lines[1]);
    assert_eq!(lines[2], "!endif");
    assert!(lines.iter().position(|l| l.starts_with("!define MUI_FINISHPAGE_")).unwrap() > 2);
    let hook = block("NSIS_HOOK_POSTINSTALL");
    assert_eq!(hook[0], "!ifndef MAINBINARYNAME");
    assert!(hook[1].starts_with(r#"!error ""#), "{}", hook[1]);
    assert_eq!(hook[2], "!endif");
    assert_eq!(hook[3], "!ifndef MUI_FINISHPAGE_REBOOT_VARIABLES");
    assert_eq!(hook[4], r#"!error "installer-hooks.nsh: the installer has no finish page that can offer a restart""#);
    assert_eq!(hook[5], "!endif");
    assert_eq!(hook[6], "Call TxrWslSkip");
    // The guards are the macro's only compile-time lines.
    assert_eq!(hook.iter().filter(|l| l.starts_with('!')).count(), 6);
}

/// What runs as administrator is Windows' 32-bit cmd.exe starting the native
/// wsl.exe with fixed arguments, and nothing else; the check is the app's
/// `--wsl-status`.
#[test]
fn only_windows_own_programs_run_as_administrator() {
    let hook = instructions(&block("NSIS_HOOK_POSTINSTALL"));
    let expected = [
        format!(r#"StrCpy $TxrWslStatusCmd '"$INSTDIR\${{MAINBINARYNAME}}.exe" {WSL_STATUS_ARG}'"#),
        r#"StrCpy $TxrElevFile "$WINDIR\SysWOW64\cmd.exe""#.to_string(),
        r#"StrCpy $TxrWslInstallParams '/d /s /c ""$WINDIR\Sysnative\wsl.exe" --install --no-distribution"'"#
            .to_string(),
        r#"StrCpy $TxrWslUpdateParams '/d /s /c ""$WINDIR\Sysnative\wsl.exe" --update && "$WINDIR\Sysnative\wsl.exe" --install --no-distribution"'"#
            .to_string(),
        "Call TxrWslSetup".to_string(),
    ];
    assert_eq!(hook[2..hook.len() - 1], expected);
    let lines = code_lines(HOOKS);
    let count = |needle: &str| lines.iter().filter(|l| l.contains(needle)).count();
    assert_eq!(count("\"runas\""), 1);
    assert_eq!(count("ShellExecuteExW"), 1);
    // The elevated program and its parameters are set only in the hook macro
    // (and copied into this run's parameters by TxrWslAct).
    assert_eq!(count("StrCpy $TxrElevFile "), 1);
    assert_eq!(
        lines.iter().filter(|l| l.starts_with("StrCpy $TxrElevParams ")).cloned().collect::<Vec<_>>(),
        [
            "StrCpy $TxrElevParams $TxrWslInstallParams",
            "StrCpy $TxrElevParams $TxrWslInstallParams",
            "StrCpy $TxrElevParams $TxrWslUpdateParams"
        ],
        "install, turn-on, update"
    );
    assert_eq!(
        lines.iter().filter(|l| *l == "Call TxrRunElevated").count(),
        1,
        "only TxrWslElevate elevates"
    );
    assert!(block("TxrWslElevate").contains(&"Call TxrRunElevated".to_string()));
    assert_eq!(lines.iter().filter(|l| *l == "Call TxrWslElevate").count(), 1, "only TxrWslAct");
    assert!(block("TxrWslAct").contains(&"Call TxrWslElevate".to_string()));
}

/// After each Yes/No question, "Yes" (the one instruction `IDNO +2` skips)
/// chooses the action: install where WSL is missing, turn-on where its
/// Virtual Machine Platform is not running, update where WSL is too old or
/// of the old kind. "No" leaves it empty.
#[test]
fn each_answer_leads_to_its_action() {
    let setup = block("TxrWslSetup");
    let branch_ends = ["${ElseIf} ", "${Else}", "${EndIf}"];
    for (status, question, action) in [
        ("READY_AFTER_RESTART", "ASK_TURN_ON", "turn-on"),
        ("MISSING", "ASK_INSTALL", "install"),
        ("OLD", "ASK_UPDATE_OLD", "update"),
        ("LEGACY", "ASK_UPDATE_LEGACY", "update"),
    ] {
        let branch = span(&setup, &format!("${{ElseIf}} $TxrWslCode == ${{TXR_WSL_{status}}}"), &branch_ends);
        assert_eq!(
            branch[1..],
            [
                r#"StrCpy $TxrWslOutcome "declined""#.to_string(),
                format!(r#"MessageBox MB_YESNO|MB_ICONQUESTION "${{TXR_MSG_{question}}}" /SD IDNO IDNO +2"#),
                format!(r#"StrCpy $TxrWslAction "{action}""#),
            ],
            "{status}"
        );
    }
    let sets: Vec<&String> = setup.iter().filter(|l| l.starts_with("StrCpy $TxrWslAction ")).collect();
    assert_eq!(sets.len(), 5, "the reset and the four answers: {sets:?}");
    assert_eq!(setup[0], r#"StrCpy $TxrWslAction """#);
    let act = setup.iter().position(|l| l == "Call TxrWslAct").unwrap();
    assert_eq!(setup[act - 1], r#"${If} $TxrWslAction != """#);
}

/// Each action runs its own command and, when that fails, says what to run
/// by hand for that action: `wsl --update` for an update (`wsl --install`
/// does not update an installed WSL). Turning the Virtual Machine Platform on
/// runs `wsl --install --no-distribution` too, but downloads nothing: its
/// failure has its own message, without the internet connection.
#[test]
fn each_action_runs_its_own_command_and_messages() {
    let act: Vec<String> = block("TxrWslAct");
    let expected = [
        r#"${If} $TxrWslAction == "install""#,
        "StrCpy $TxrElevParams $TxrWslInstallParams",
        r#"StrCpy $TxrWslMsgNoPermission "${TXR_MSG_NO_PERMISSION_INSTALL}""#,
        r#"StrCpy $TxrWslMsgFailed "${TXR_MSG_FAILED_INSTALL}""#,
        r#"${ElseIf} $TxrWslAction == "turn-on""#,
        "StrCpy $TxrElevParams $TxrWslInstallParams",
        r#"StrCpy $TxrWslMsgNoPermission "${TXR_MSG_NO_PERMISSION_INSTALL}""#,
        r#"StrCpy $TxrWslMsgFailed "${TXR_MSG_FAILED_TURN_ON}""#,
        r#"${ElseIf} $TxrWslAction == "update""#,
        "StrCpy $TxrElevParams $TxrWslUpdateParams",
        r#"StrCpy $TxrWslMsgNoPermission "${TXR_MSG_NO_PERMISSION_UPDATE}""#,
        r#"StrCpy $TxrWslMsgFailed "${TXR_MSG_FAILED_UPDATE}""#,
        "${Else}",
        "Return",
        "${EndIf}",
        "Call TxrWslElevate",
    ];
    assert_eq!(act, expected);
    let message = |name: &str| {
        let prefix = format!("!define TXR_MSG_{name} ");
        code_lines(HOOKS)
            .into_iter()
            .find_map(|l| l.strip_prefix(&prefix).map(str::to_string))
            .unwrap_or_else(|| panic!("no message {name}"))
    };
    for name in ["NO_PERMISSION_INSTALL", "FAILED_INSTALL"] {
        let text = message(name);
        assert!(text.contains("run: wsl --install --no-distribution, and restart Windows"), "{name}");
        assert!(!text.contains("--update"), "{name}");
        assert!(text.starts_with(r#""WSL 2 "#), "{name}");
    }
    assert!(message("FAILED_INSTALL").contains("Check the internet connection"));
    let turn_on = message("FAILED_TURN_ON");
    assert!(
        turn_on.starts_with(r#""The Windows component WSL 2 needs (Virtual Machine Platform) could not be turned on."#),
        "{turn_on}"
    );
    assert!(turn_on.contains("run: wsl --install --no-distribution, and restart Windows"), "{turn_on}");
    for name in ["ASK_TURN_ON", "FAILED_TURN_ON"] {
        let text = message(name).to_lowercase();
        for word in ["internet", "download", "--update"] {
            assert!(!text.contains(word), "{name}: {word}");
        }
    }
    for name in ["NO_PERMISSION_UPDATE", "FAILED_UPDATE"] {
        let text = message(name);
        assert!(
            text.contains("run: wsl --update, then: wsl --install --no-distribution, and restart Windows"),
            "{name}"
        );
        assert!(text.starts_with(r#""WSL was not updated"#) || text.starts_with(r#""WSL could not be updated"#), "{name}");
    }
}

/// The hook waits for the elevated setup however long it takes (a download
/// of minutes; the user can close its window), then reads its exit code.
#[test]
fn the_hook_waits_for_the_setup_without_a_time_limit() {
    let run = block("TxrRunElevated");
    let wait = run.iter().position(|l| l.contains("WaitForSingleObject")).expect("a wait");
    assert_eq!(run[wait], "System::Call 'kernel32::WaitForSingleObject(p R1, i -1) i .R2'");
    assert_eq!(run[wait + 1], "System::Call 'kernel32::GetExitCodeProcess(p R1, *i .R2) i'");
    // SEE_MASK_NOCLOSEPROCESS (0x40) gives the process handle to wait on.
    assert!(run.iter().any(|l| l.starts_with("System::Call '*(&l4, i 0x540, ")));
}

/// Windows' "No" to the permission prompt (ShellExecuteEx fails with 1223,
/// ERROR_CANCELLED) gets the no-permission message; any other failure to
/// start gets the failed message with Windows' error.
#[test]
fn windows_refusal_and_other_errors_show_their_messages() {
    let elevate = block("TxrWslElevate");
    let not_started = span(&elevate, "${If} $TxrElevStarted <> 1", &["Return"]);
    let expected = [
        "${If} $TxrElevStarted <> 1",
        "${If} $TxrElevError == 1223",
        r#"StrCpy $TxrWslOutcome "no-permission""#,
        r#"DetailPrint "WSL 2 was not set up: Windows did not get permission.""#,
        r#"MessageBox MB_OK|MB_ICONINFORMATION "$TxrWslMsgNoPermission" /SD IDOK"#,
        "${Else}",
        r#"StrCpy $TxrWslOutcome "not-started""#,
        r#"DetailPrint "The WSL setup could not start (Windows error $TxrElevError).""#,
        r#"MessageBox MB_OK|MB_ICONEXCLAMATION "$TxrWslMsgFailed$\r$\n$\r$\n(Windows error $TxrElevError)" /SD IDOK"#,
        "${EndIf}",
    ];
    assert_eq!(not_started, expected);
    let lines = code_lines(HOOKS);
    let shown = |var: &str| lines.iter().filter(|l| l.starts_with("MessageBox ") && l.contains(var)).count();
    assert_eq!(shown("$TxrWslMsgNoPermission"), 1);
    assert_eq!(shown("$TxrWslMsgFailed"), 3, "not started, and failed with or without an exit code");
}

/// After the setup, the second check and the setup's exit code decide:
/// - READY: set up, whatever the exit code; a restart is offered after WSL
///   was installed where it was missing or of the old kind;
/// - READY_AFTER_RESTART: set up, restart offered, only when the setup ended
///   without an error (exit code 0). The check cannot tell a Virtual Machine
///   Platform turned on and waiting for a restart from one still off, so
///   after a failed setup (or a closed window) this is a failure, with no
///   restart offer, whatever the first check said;
/// - MISSING or LEGACY after a setup without an error that started from
///   MISSING or LEGACY: Windows must restart first (wsl.exe exits with 0
///   then), so the restart is offered, not the failed message;
/// - anything else: the failed message, with the exit code when known.
#[test]
fn the_second_check_and_the_exit_code_decide_the_outcome() {
    let elevate = block("TxrWslElevate");
    let from = elevate.iter().position(|l| l == "Call TxrWslRunStatus").expect("a second check");
    let expected = [
        "Call TxrWslRunStatus",
        "${If} $TxrWslCode == ${TXR_WSL_READY}",
        r#"StrCpy $TxrWslOutcome "set-up""#,
        r#"DetailPrint "WSL 2 is set up.""#,
        "${If} $TxrWslFirstCode == ${TXR_WSL_MISSING}",
        "${OrIf} $TxrWslFirstCode == ${TXR_WSL_LEGACY}",
        "Call TxrWslOfferRestart",
        "${EndIf}",
        "Return",
        "${EndIf}",
        "${If} $TxrElevExit == 0",
        "${If} $TxrWslCode == ${TXR_WSL_READY_AFTER_RESTART}",
        r#"StrCpy $TxrWslOutcome "set-up""#,
        r#"DetailPrint "WSL 2 is set up; it runs after Windows restarts.""#,
        "Call TxrWslOfferRestart",
        "Return",
        "${EndIf}",
        "${If} $TxrWslFirstCode == ${TXR_WSL_MISSING}",
        "${OrIf} $TxrWslFirstCode == ${TXR_WSL_LEGACY}",
        "${If} $TxrWslCode == ${TXR_WSL_MISSING}",
        "${OrIf} $TxrWslCode == ${TXR_WSL_LEGACY}",
        r#"StrCpy $TxrWslOutcome "restart-pending""#,
        r#"DetailPrint "The WSL setup ended without an error, but WSL 2 answers only after Windows restarts. TxResBench checks WSL again when it starts.""#,
        "Call TxrWslOfferRestart",
        "Return",
        "${EndIf}",
        "${EndIf}",
        "${EndIf}",
        r#"StrCpy $TxrWslOutcome "failed""#,
        r#"DetailPrint "WSL 2 was not set up (check code $TxrWslCode).""#,
        r#"${If} $TxrElevExit == """#,
        r#"MessageBox MB_OK|MB_ICONEXCLAMATION "$TxrWslMsgFailed" /SD IDOK"#,
        "${Else}",
        r#"MessageBox MB_OK|MB_ICONEXCLAMATION "$TxrWslMsgFailed$\r$\n$\r$\n(The setup ended with code $TxrElevExit.)" /SD IDOK"#,
        "${EndIf}",
    ];
    assert_eq!(elevate[from..], expected);
    // The exit code is "" when not known, or what GetExitCodeProcess gave; it
    // is compared as text (`==`), so "" is not 0, and is never shown as a code.
    let lines = code_lines(HOOKS);
    assert!(!lines.iter().any(|l| l.starts_with("StrCpy $TxrElevExit ") && l != r#"StrCpy $TxrElevExit """# && l != "StrCpy $TxrElevExit $R2"));
    assert!(finish_reboot_text().contains("TxResBench checks WSL again when it starts."));
}

/// The finish page's text when a restart is needed.
fn finish_reboot_text() -> String {
    code_lines(HOOKS)
        .into_iter()
        .find_map(|l| l.strip_prefix("!define MUI_FINISHPAGE_TEXT_REBOOT ").map(str::to_string))
        .unwrap()
}

/// The questions that lead to a download say how big it is.
#[test]
fn the_download_questions_give_the_size() {
    for name in ["ASK_INSTALL", "ASK_UPDATE_OLD", "ASK_UPDATE_LEGACY"] {
        let prefix = format!("!define TXR_MSG_{name} ");
        let text = code_lines(HOOKS).into_iter().find_map(|l| l.strip_prefix(&prefix).map(str::to_string)).unwrap();
        assert!(text.contains("download") && text.contains("(about 400 MB)"), "{name}");
    }
}

#[test]
fn only_the_system_and_nsexec_plug_ins_are_used() {
    let plugins: BTreeSet<String> = code_lines(HOOKS)
        .iter()
        .filter_map(|l| {
            let word = l.split_whitespace().next()?;
            let (name, _) = word.split_once("::")?;
            Some(name.to_string())
        })
        .collect();
    assert_eq!(plugins, BTreeSet::from(["System".to_string(), "nsExec".to_string()]));
}

/// WSL itself is never installed without `--no-distribution` (the app imports
/// its own distro), and the only thing ever removed is the app's own distro,
/// by its exact name: `--unregister ${TXR_DISTRO}` is the whole argument list
/// to wsl.exe. No other distro name or wsl.exe operation appears.
#[test]
fn only_the_apps_own_distro_is_removed() {
    for banned in ["--uninstall", "--shutdown", "--distribution ", " -d ", "Ubuntu"] {
        assert!(!HOOKS.contains(banned), "{banned}");
    }
    let unreg: Vec<String> = code_lines(HOOKS).into_iter().filter(|l| l.contains("--unregister")).collect();
    assert_eq!(unreg.len(), 1, "{unreg:?}");
    assert_eq!(
        unreg[0],
        r#"nsExec::Exec '"${TXR_UNREG_WSL_EXE}" --unregister ${TXR_DISTRO}'"#,
        "the only wsl.exe argument list"
    );
    let needle = "--install";
    let mut seen = 0;
    for (at, _) in HOOKS.match_indices(needle) {
        assert!(HOOKS[at + needle.len()..].starts_with(" --no-distribution"), "at byte {at}");
        seen += 1;
    }
    assert!(seen >= 4, "the two commands and the two messages: {seen}");
    // The distro name comes from one define whose default is exactly the
    // app's distro (the constant `wsl -d` uses in the app).
    let default = code_lines(HOOKS)
        .into_iter()
        .find_map(|l| l.strip_prefix("!define TXR_DISTRO ").map(str::to_string))
        .unwrap()
        .trim_matches('"')
        .to_string();
    assert_eq!(default, "TxResBench");
}

/// The uninstall hook removes the distro only when the "Delete app data" box
/// was ticked and this is not an update — the same two conditions as the
/// template's own app data deletion (installer.nsi reads
/// `$DeleteAppDataCheckboxState` and `$UpdateMode` the same way) — and the
/// whole removal sits inside that guard: nothing runs when the box is not
/// ticked or the uninstaller was run with /UPDATE. The guard is also what the
/// silent and passive runs take (their page skips leave the box's state
/// unset).
#[test]
fn the_uninstall_hook_runs_only_when_the_box_is_ticked_and_outside_an_update() {
    let hook = block("NSIS_HOOK_POSTUNINSTALL");
    assert_eq!(hook[0], r#"${If} $DeleteAppDataCheckboxState = 1"#);
    assert_eq!(hook[1], r#"${AndIf} $UpdateMode <> 1"#);
    assert_eq!(hook.last().unwrap(), "${EndIf}");
    let at = hook.iter().position(|l| l.starts_with("nsExec::Exec ")).expect("the unregister call");
    assert!(at > 2, "the call is inside the guard");
    // The call is reached only when a TxResBench entry was found, and the
    // BasePath is read from that very entry.
    assert_eq!(hook[at - 2], r#"${If} $TxrWslUnregFound != """#);
    assert_eq!(
        hook[at - 1],
        r#"ReadRegStr $TxrWslUnregBasePath HKCU "${TXR_LXSS_KEY}\$TxrWslUnregFound" "BasePath""#
    );
    // The guard reads the template's variables here and nowhere else in the
    // file (the install step reads its own flags from the command line).
    let lines = code_lines(HOOKS);
    let count = |v: &str| lines.iter().filter(|l| l.contains(v)).count();
    assert_eq!(count("$DeleteAppDataCheckboxState"), 1);
    assert_eq!(count("$UpdateMode"), 1);
}

/// The uninstall part never asks for administrator rights (no runas, no
/// ShellExecuteExW, no SysWOW64), never deletes anything recursively (one
/// RMDir without /r, on the distro's own BasePath, which removes only an
/// empty directory), leaves the WSL registry entry to wsl.exe, and matches
/// the distro name exactly: a case-sensitive compare (S==) against the one
/// define, so a `txrbench` entry or another distro is never touched.
#[test]
fn the_uninstall_hook_never_elevates_and_removes_only_an_empty_directory() {
    let hook = block("NSIS_HOOK_POSTUNINSTALL");
    for banned in ["runas", "ShellExecuteExW", "ExecWait ", "$WINDIR\\SysWOW64"] {
        assert!(!hook.iter().any(|l| l.contains(banned)), "{banned}");
    }
    let rmdir: Vec<&String> = hook.iter().filter(|l| l.starts_with("RMDir ")).collect();
    assert_eq!(rmdir, [r#"RMDir "$TxrWslUnregBasePath""#]);
    assert!(!hook.iter().any(|l| l.contains("/r ")), "no recursive deletion");
    assert!(!hook.iter().any(|l| l.contains("DeleteRegKey")), "wsl.exe removes the entry itself");
    // Exact-name match: the one compare is case-sensitive and reads the
    // define, never a literal name.
    assert!(hook.contains(&r#"${If} $TxrWslUnregName S== "${TXR_DISTRO}""#.to_string()));
    assert_eq!(
        code_lines(HOOKS).iter().filter(|l| l.contains(r#""TxResBench""#)).count(),
        1,
        "only the define's default names the distro"
    );
}

/// The harness points the hook's overridable paths at its own key and its own
/// wsl.exe stand-in, and runs the production uninstall macro; the real WSL
/// Lxss key and the real wsl.exe are nowhere in it.
#[test]
fn the_harness_never_touches_the_real_wsl_or_lxss_key() {
    const HARNESS: &str = include_str!("../windows/hook-harness.nsi");
    assert!(HARNESS.contains(r#"!define TXR_LXSS_KEY "Software\TxResBenchHarness\Lxss""#));
    assert!(HARNESS.contains(r#"!define TXR_UNREG_WSL_EXE "$Work\${TXR_HARNESS_WSL}""#));
    assert!(!HARNESS.contains(r#"CurrentVersion\Lxss"#), "the real WSL Lxss key");
    assert!(!HARNESS.contains(r"Sysnative\wsl.exe"), "the real wsl.exe");
    assert!(HARNESS.contains("!insertmacro NSIS_HOOK_POSTUNINSTALL"), "the scenario runs the production macro");
}

/// The hook's `TXR_WSL_*` codes are the app's `WslStatus` codes, both ways.
#[test]
fn the_hook_codes_are_the_app_codes() {
    let defined: BTreeMap<String, i32> = code_lines(HOOKS)
        .iter()
        .filter_map(|l| {
            let rest = l.strip_prefix("!define TXR_WSL_")?;
            let (name, value) = rest.split_once(' ')?;
            Some((name.to_string(), value.trim().parse().unwrap()))
        })
        .collect();
    let app: BTreeMap<String, i32> =
        WslStatus::ALL.iter().map(|s| (s.name().to_string(), s.code())).collect();
    assert_eq!(defined, app);
}

/// Every status the check can give has its own branch, except UNSUPPORTED,
/// which (like a check that could not run) takes the "unknown" branch.
#[test]
fn every_status_has_a_branch() {
    let setup = block("TxrWslSetup");
    for status in WslStatus::ALL {
        let test = format!("$TxrWslCode == ${{TXR_WSL_{}}}", status.name());
        let has = setup.iter().any(|l| l.ends_with(&test) && (l.starts_with("${If} ") || l.starts_with("${ElseIf} ")));
        assert_eq!(has, status != WslStatus::Unsupported, "{}", status.name());
    }
    let else_at = setup.iter().position(|l| l == "${Else}").unwrap();
    assert_eq!(setup[else_at + 1], r#"StrCpy $TxrWslOutcome "unknown""#);
}

/// Questions default to "No" and notes to "OK" (the default is what an
/// unattended run would take; the hook skips those anyway).
#[test]
fn every_message_box_has_a_safe_default() {
    let boxes: Vec<String> = code_lines(HOOKS).into_iter().filter(|l| l.starts_with("MessageBox ")).collect();
    assert!(boxes.len() >= 8, "{}", boxes.len());
    for b in boxes {
        if b.starts_with("MessageBox MB_YESNO") {
            assert!(b.ends_with("/SD IDNO IDNO +2"), "{b}");
        } else {
            assert!(b.starts_with("MessageBox MB_OK") && b.ends_with("/SD IDOK"), "{b}");
        }
    }
}

/// The restart is offered on the finish page with "Restart later"
/// preselected; the hook itself never restarts Windows.
#[test]
fn the_restart_is_only_offered() {
    let lines = code_lines(HOOKS);
    assert!(lines.contains(&"!define MUI_FINISHPAGE_REBOOTLATER_DEFAULT".to_string()));
    assert!(lines.iter().any(|l| l.starts_with("!define MUI_FINISHPAGE_TEXT_REBOOT ")));
    assert!(!lines.iter().any(|l| l == "Reboot" || l.starts_with("Reboot ")));
    assert_eq!(lines.iter().filter(|l| *l == "SetRebootFlag true").count(), 1);
    assert_eq!(block("TxrWslOfferRestart")[0], "SetRebootFlag true");
}

/// The hook uses its own variables and functions, NSIS's and its standard
/// headers', and of Tauri's template only `TEMPLATE_NAMES`.
#[test]
fn the_hook_relies_on_the_template_only_for_the_listed_names() {
    let lines = code_lines(HOOKS);
    let own_vars: BTreeSet<String> =
        lines.iter().filter_map(|l| l.strip_prefix("Var ")).map(|v| v.trim().to_string()).collect();
    let own_functions: BTreeSet<String> =
        lines.iter().filter_map(|l| l.strip_prefix("Function ")).map(|f| f.trim().to_string()).collect();
    let own_defines: BTreeSet<String> = lines
        .iter()
        .filter_map(|l| l.strip_prefix("!define "))
        .map(|d| d.split_whitespace().next().unwrap().to_string())
        .collect();
    let nsis_vars = ["INSTDIR", "WINDIR", "HWNDPARENT", "R0", "R1", "R2", "R3", "R4", "R5"];
    let header_defines = [
        "If", "IfNot", "ElseIf", "ElseIfNot", "Else", "EndIf", "OrIf", "AndIf", "Errors", "Silent", "RunningX64",
        "GetOptions", "GetParameters", "Do", "Loop", "Break", "FileExists",
    ];
    let template: BTreeSet<&str> = TEMPLATE_NAMES.into_iter().collect();
    let mut used_template = BTreeSet::new();
    for line in &lines {
        let mut rest = line.as_str();
        while let Some(at) = rest.find('$') {
            rest = &rest[at + 1..];
            if let Some(inner) = rest.strip_prefix('{') {
                let name = &inner[..inner.find('}').unwrap()];
                if template.contains(name) {
                    used_template.insert(name.to_string());
                } else {
                    assert!(
                        own_defines.contains(name) || header_defines.contains(&name),
                        "unknown define ${{{name}}} in: {line}"
                    );
                }
            } else if rest.starts_with('\\') || rest.starts_with('$') {
                rest = &rest[1..];
            } else {
                let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
                if !name.is_empty() {
                    if template.contains(name.as_str()) {
                        used_template.insert(name);
                    } else {
                        assert!(
                            own_vars.contains(&name) || nsis_vars.contains(&name.as_str()),
                            "unknown variable ${name} in: {line}"
                        );
                    }
                }
            }
        }
        if let Some(target) = line.strip_prefix("Call ") {
            if template.contains(target) {
                used_template.insert(target.to_string());
            } else {
                assert!(own_functions.contains(target), "unknown function {target}");
            }
        }
    }
    assert_eq!(used_template, template.iter().map(|s| s.to_string()).collect());
}

/// The messages say what to run to get WSL by hand, and the one link is
/// Microsoft's page on installing WSL.
#[test]
fn the_messages_name_the_command_and_one_link() {
    assert!(HOOKS.contains("run: wsl --install --no-distribution, and restart Windows"));
    assert!(HOOKS.contains("run: wsl --update, then: wsl --install --no-distribution, and restart Windows"));
    let links: Vec<&str> = HOOKS
        .match_indices("https://")
        .map(|(at, _)| HOOKS[at..].split(['"', ' ', '\n']).next().unwrap())
        .collect();
    assert_eq!(links, ["https://learn.microsoft.com/windows/wsl/install-manual"]);
}
