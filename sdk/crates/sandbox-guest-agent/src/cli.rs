//! The agent's command line.
//!
//! - No option: **VM mode**, the method VM's entrypoint. The launcher starts the
//!   agent through libkrun, which may pass the agent's own path as an argument,
//!   and VM mode has never read its arguments; so arguments that do not start
//!   with `-` still mean VM mode.
//! - `--stdio --base <image> [--layer <image>] [--ro <path>]...`: **WSL mode**,
//!   one run in the app's WSL distro (paths as seen inside WSL).
//! - `--pipe-selftest`: copy stdin to stdout byte for byte until EOF.
//!
//! Anything else that starts with `-` is a usage error (exit [`EXIT_BAD_ARGS`]).

use std::ffi::OsString;
use std::path::PathBuf;

/// The run (or self-test) ended normally.
pub const EXIT_OK: i32 = 0;
/// The command line is wrong.
pub const EXIT_BAD_ARGS: i32 = 2;
/// WSL mode could not set up its mounts (the reason is on stderr).
pub const EXIT_SETUP: i32 = 3;
/// WSL mode: the protocol stream failed (bad frame, refused request, broken
/// pipe, or the host closed it before the command finished).
pub const EXIT_TRANSPORT: i32 = 4;

pub const USAGE: &str = "usage: txresbench-sandbox-agent --stdio --base <image> [--layer <image>] [--ro <path>]...\n       txresbench-sandbox-agent --pipe-selftest\n       txresbench-sandbox-agent            (VM mode: the method VM's entrypoint)";

#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    Vm,
    Stdio(StdioArgs),
    PipeSelftest,
}

/// WSL mode's inputs: absolute paths inside WSL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StdioArgs {
    /// The base squashfs image, mounted at `/sandbox-rootfs`.
    pub base: PathBuf,
    /// The method layer squashfs image, mounted at `/sandbox-layer`.
    pub layer: Option<PathBuf>,
    /// Paths bound read-only at `/host-mounts/<i>`, in this order.
    pub ro: Vec<PathBuf>,
}

/// Parse the arguments after the program name.
pub fn parse_args<I: IntoIterator<Item = OsString>>(args: I) -> Result<Mode, String> {
    let args: Vec<OsString> = args.into_iter().collect();
    if !args.iter().any(|a| a.as_encoded_bytes().starts_with(b"-")) {
        return Ok(Mode::Vm);
    }
    let mut stdio = false;
    let mut selftest = false;
    let mut base: Option<PathBuf> = None;
    let mut layer: Option<PathBuf> = None;
    let mut ro: Vec<PathBuf> = Vec::new();
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg.to_str() {
            Some("--stdio") => {
                if std::mem::replace(&mut stdio, true) {
                    return Err("--stdio is given twice".into());
                }
            }
            Some("--pipe-selftest") => {
                if std::mem::replace(&mut selftest, true) {
                    return Err("--pipe-selftest is given twice".into());
                }
            }
            Some(flag @ ("--base" | "--layer" | "--ro")) => {
                let value = it.next().ok_or_else(|| format!("{flag} needs a path"))?;
                let path = absolute_path(flag, value)?;
                match flag {
                    "--base" if base.is_some() => return Err("--base is given twice".into()),
                    "--base" => base = Some(path),
                    "--layer" if layer.is_some() => return Err("--layer is given twice".into()),
                    "--layer" => layer = Some(path),
                    _ => ro.push(path),
                }
            }
            _ => return Err(format!("unexpected argument {arg:?}")),
        }
    }
    if selftest {
        if stdio || base.is_some() || layer.is_some() || !ro.is_empty() {
            return Err("--pipe-selftest takes no other argument".into());
        }
        return Ok(Mode::PipeSelftest);
    }
    if !stdio {
        return Err("--base, --layer and --ro need --stdio".into());
    }
    let base = base.ok_or("--stdio needs --base <image>")?;
    Ok(Mode::Stdio(StdioArgs { base, layer, ro }))
}

/// A path value: absolute (it is resolved inside WSL, from `/`).
fn absolute_path(flag: &str, value: OsString) -> Result<PathBuf, String> {
    if !value.as_encoded_bytes().starts_with(b"/") {
        return Err(format!("{flag} needs an absolute path, got {value:?}"));
    }
    Ok(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Mode, String> {
        parse_args(args.iter().map(OsString::from))
    }

    #[test]
    fn no_option_is_vm_mode_even_with_the_agent_path_as_an_argument() {
        assert_eq!(parse(&[]), Ok(Mode::Vm));
        // libkrun may pass the exec path as argv[1]; VM mode ignores it.
        assert_eq!(parse(&["/usr/bin/txresbench-sandbox-agent"]), Ok(Mode::Vm));
    }

    #[test]
    fn stdio_with_base_layer_and_ro_paths_in_order() {
        let mode = parse(&[
            "--stdio", "--base", "/mnt/c/b.sqfs", "--ro", "/mnt/c/in", "--layer", "/mnt/c/l.sqfs", "--ro",
            "/mnt/c/model",
        ]);
        assert_eq!(
            mode,
            Ok(Mode::Stdio(StdioArgs {
                base: "/mnt/c/b.sqfs".into(),
                layer: Some("/mnt/c/l.sqfs".into()),
                ro: vec!["/mnt/c/in".into(), "/mnt/c/model".into()],
            }))
        );
        assert_eq!(
            parse(&["--base", "/b", "--stdio"]),
            Ok(Mode::Stdio(StdioArgs { base: "/b".into(), layer: None, ro: vec![] }))
        );
    }

    #[test]
    fn pipe_selftest_alone() {
        assert_eq!(parse(&["--pipe-selftest"]), Ok(Mode::PipeSelftest));
    }

    #[test]
    fn bad_arguments_are_refused_with_a_reason() {
        let cases: &[(&[&str], &str)] = &[
            (&["--stdio"], "--stdio needs --base"),
            (&["--stdio", "--base"], "--base needs a path"),
            (&["--stdio", "--base", "b.sqfs"], "absolute path"),
            (&["--stdio", "--base", ""], "absolute path"),
            (&["--stdio", "--base", "/b", "--ro", "in"], "absolute path"),
            (&["--stdio", "--base", "/b", "--layer", "--ro"], "absolute path"),
            (&["--stdio", "--base", "/b", "--base", "/c"], "--base is given twice"),
            (&["--stdio", "--base", "/b", "--layer", "/l", "--layer", "/m"], "--layer is given twice"),
            (&["--stdio", "--stdio", "--base", "/b"], "--stdio is given twice"),
            (&["--base", "/b"], "need --stdio"),
            (&["--ro", "/x"], "need --stdio"),
            (&["--pipe-selftest", "--stdio", "--base", "/b"], "takes no other argument"),
            (&["--pipe-selftest", "--pipe-selftest"], "given twice"),
            (&["--stdio", "--base", "/b", "extra"], "unexpected argument"),
            (&["--stdio", "--base=/b"], "unexpected argument"),
            (&["--help"], "unexpected argument"),
            (&["-x"], "unexpected argument"),
        ];
        for (args, want) in cases {
            match parse(args) {
                Err(why) => assert!(why.contains(want), "{args:?}: {why:?} does not say {want:?}"),
                Ok(mode) => panic!("{args:?} was accepted as {mode:?}"),
            }
        }
    }

    #[test]
    fn exit_codes_are_the_contract_values() {
        assert_eq!((EXIT_OK, EXIT_BAD_ARGS, EXIT_SETUP, EXIT_TRANSPORT), (0, 2, 3, 4));
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_paths_are_kept_byte_for_byte() {
        use std::os::unix::ffi::OsStringExt;
        let raw = b"/mnt/c/\xff.sqfs".to_vec();
        let args = vec![OsString::from("--stdio"), OsString::from("--base"), OsString::from_vec(raw.clone())];
        match parse_args(args) {
            Ok(Mode::Stdio(a)) => assert_eq!(a.base.into_os_string().into_vec(), raw),
            other => panic!("{other:?}"),
        }
    }
}
