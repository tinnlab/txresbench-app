//! TEST-ONLY: run an emitted provenance script with the host `python3`.
//!
//! The emitted `select(ctx)` module IS the attested reproducibility artifact (its
//! sha256 becomes the run's `code_sha256`), so the only assertion worth making
//! about it is that it EXECUTES and answers the set that was recorded. Both
//! helpers therefore treat an absent/unusable interpreter as a FAILURE TO VERIFY,
//! never as a pass — python3 is a build-and-test dependency of this repo
//! (`just check-py`), and a silent skip here is exactly the "self-skip presented
//! as PASS" this lifecycle forbids.
#![cfg(test)]

use std::io::Write as _;

/// Compile the emitted module with the host's python3; `Err` when it is not a
/// single well-formed module (or the interpreter could not be used).
pub fn python_compiles(src: &str) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("cyto-pyc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let f = dir.join("emitted.py");
    std::fs::File::create(&f)
        .and_then(|mut h| h.write_all(src.as_bytes()))
        .map_err(|e| e.to_string())?;
    let out = std::process::Command::new("python3")
        .arg("-c")
        .arg(format!(
            "compile(open({:?}).read(), 'emitted.py', 'exec')",
            f.display().to_string()
        ))
        .output();
    let out = match out {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!(
                "python3 is not on PATH. It is a build-and-test dependency of this repo \
                 (`just check-py`), and this assertion is what proves the ATTESTED script \
                 is a well-formed module — an absent interpreter is a failure to verify, \
                 never a pass: {e}"
            ));
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("could not spawn python3 (it IS installed): {e}"));
        }
    };
    let _ = std::fs::remove_dir_all(&dir);
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

/// Execute an emitted script's `select(ctx)` and return its mask. NEVER `None`,
/// NEVER a skip: a spawn/decode failure PANICS with the raw output, because a
/// degraded "skip" would retire the one invariant this harness exists to hold.
pub fn run_select(src: &str, ctx: serde_json::Value) -> Vec<bool> {
    run_select_raw(src, &ctx.to_string())
}

/// [`run_select`] with the ctx supplied as RAW JSON TEXT (so a non-finite float —
/// which `serde_json` renders as `null` — can be spelled with python's
/// `Infinity`/`NaN` literals).
pub fn run_select_raw(src: &str, ctx_text: &str) -> Vec<bool> {
    match std::process::Command::new("python3").arg("--version").output() {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => panic!(
            "python3 is not on PATH. It is a build-and-test dependency of this repo \
             (`just check-py`), and these tests verify that the ATTESTED replay script \
             reproduces the recorded selection — an absent interpreter is a failure to \
             verify, never a pass: {e}"
        ),
        Err(e) => panic!("could not probe python3 (this is NOT 'python3 is absent'): {e}"),
    }
    let dir = std::env::temp_dir().join(format!("cyto-pyrun-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create temp dir for the emitted script");
    let py = dir.join("emitted.py");
    std::fs::File::create(&py)
        .expect("create emitted.py")
        .write_all(src.as_bytes())
        .expect("write emitted.py");
    let ctx_path = dir.join("ctx.json");
    std::fs::File::create(&ctx_path)
        .expect("create ctx.json")
        .write_all(ctx_text.as_bytes())
        .expect("write ctx.json");
    let driver = dir.join("drive.py");
    let code = format!(
        "import json,sys\nsys.path.insert(0, {dir:?})\nimport emitted\nwith open({ctx:?}, encoding='utf-8') as fh:\n    _ctx = json.load(fh)\nprint(json.dumps(emitted.select(_ctx)))\n",
        dir = dir.display().to_string(),
        ctx = ctx_path.display().to_string(),
    );
    std::fs::File::create(&driver)
        .expect("create drive.py")
        .write_all(code.as_bytes())
        .expect("write drive.py");
    let out = std::process::Command::new("python3")
        .arg(&driver)
        .output()
        .expect("run the emitted script");
    let _ = std::fs::remove_dir_all(&dir);
    if !out.status.success() {
        panic!(
            "emitted script failed: {}\n--- source ---\n{src}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    match serde_json::from_slice::<Vec<bool>>(&out.stdout) {
        Ok(mask) => mask,
        Err(e) => panic!(
            "the emitted script exited 0 but its reply is not a boolean mask ({e}) — the \
             assertions must NOT be skipped for this:\n--- stdout ---\n{}\n--- stderr ---\n{}\n\
             --- source ---\n{src}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        ),
    }
}
