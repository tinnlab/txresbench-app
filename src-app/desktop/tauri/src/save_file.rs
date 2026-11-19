//! Saving a file the user chose with the native Save dialog.
//!
//! The app window has no browser download handler, so the web pages' "blob +
//! hidden link" download does nothing in the desktop app. The desktop path is
//! instead: the page opens the dialog plugin's Save dialog
//! (`plugin:dialog|save`, permission `dialog:allow-save`), then sends the file
//! bytes to [`save_file`] with the chosen path in the [`SAVE_PATH_HEADER`]
//! request header (percent-encoded, so any file name fits in a header). The
//! UI half is `src-app/ui/src/core/saveFile.ts`.
//!
//! The command cannot prove the path came from the dialog, so it checks what
//! it can before writing: the path is absolute, names a file (not a folder),
//! and its folder exists. The write is atomic: a temporary file in the same
//! folder, flushed, then renamed over the target, so a failed save never
//! leaves a half-written file under the user's chosen name.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// The request header carrying the chosen path (percent-encoded UTF-8).
pub const SAVE_PATH_HEADER: &str = "x-txr-save-path";

/// Write the request's raw body to the path named by [`SAVE_PATH_HEADER`].
///
/// The body must be raw bytes (the UI passes a `Uint8Array` as the invoke
/// arguments). Errors come back as the command's `Err` string, which the page
/// shows on its existing error line.
#[tauri::command]
pub async fn save_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let raw = request
        .headers()
        .get(SAVE_PATH_HEADER)
        .ok_or_else(|| "the save path is missing".to_string())?
        .to_str()
        .map_err(|_| "the save path is not readable".to_string())?;
    let path = decode_path_header(raw)?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("the file contents must be sent as raw bytes".to_string()),
    };
    let target = validate_save_path(&path)?;
    write_file_atomically(&target, bytes)
}

/// Decode the percent-encoded header value (the UI's `encodeURIComponent`).
/// A malformed escape or a non-UTF-8 result is refused, never guessed.
pub fn decode_path_header(raw: &str) -> Result<String, String> {
    let input = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            let hex = input
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| "the save path is not correctly encoded".to_string())?;
            out.push(hex);
            i += 3;
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "the save path is not valid text".to_string())
}

/// Check a chosen path before anything is written: not empty, absolute,
/// naming a file whose folder exists, and not an existing folder.
pub fn validate_save_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("the save path is empty".to_string());
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("the save path must be absolute".to_string());
    }
    if p.file_name().is_none() {
        return Err("the save path does not name a file".to_string());
    }
    if p.is_dir() {
        return Err("the save path is a folder".to_string());
    }
    let parent = p
        .parent()
        .ok_or_else(|| "the save path has no folder".to_string())?;
    if !parent.is_dir() {
        return Err("the folder of the save path does not exist".to_string());
    }
    Ok(p)
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `target` atomically: a new temporary file next to it,
/// flushed to disk, then renamed over the target (replacing an existing file
/// the user agreed to replace in the dialog). On any failure the temporary
/// file is removed and the target is left as it was.
pub fn write_file_atomically(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "the save path has no folder".to_string())?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".{name}.{}-{seq}.txr-save.tmp", std::process::id()));

    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, target)
    })();

    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(format!("the file could not be saved: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch folder under the test process's temp dir.
    fn scratch_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("txr-save-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .expect("read scratch dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".txr-save.tmp"))
            .collect()
    }

    #[test]
    fn writes_the_bytes_and_leaves_no_temporary_file() {
        let dir = scratch_dir("write");
        let target = dir.join("predictions-run.csv");
        let path = validate_save_path(target.to_str().unwrap()).expect("valid path");
        write_file_atomically(&path, b"patient_id,m-a\np1,0.25\n").expect("saved");
        assert_eq!(std::fs::read(&target).unwrap(), b"patient_id,m-a\np1,0.25\n");
        assert!(leftovers(&dir).is_empty(), "no temporary file is left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replaces_an_existing_file() {
        let dir = scratch_dir("replace");
        let target = dir.join("model.txr");
        std::fs::write(&target, b"old bytes that are longer than the new ones").unwrap();
        write_file_atomically(&target, b"new").expect("saved");
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert!(leftovers(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_empty_relative_and_folder_paths() {
        assert!(validate_save_path("").is_err(), "empty");
        assert!(validate_save_path("   ").is_err(), "blank");
        assert!(validate_save_path("predictions.csv").is_err(), "relative");
        assert!(validate_save_path("Documents/predictions.csv").is_err(), "relative with a folder");
        assert!(validate_save_path("~/predictions.csv").is_err(), "a tilde is not expanded");
        let dir = scratch_dir("folder");
        assert!(validate_save_path(dir.to_str().unwrap()).is_err(), "an existing folder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_path_whose_folder_does_not_exist() {
        let dir = scratch_dir("missing");
        let target = dir.join("no-such-folder").join("predictions.csv");
        assert!(validate_save_path(target.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_leaves_the_target_untouched_and_no_temporary_file() {
        let dir = scratch_dir("fail");
        // The target is an existing folder: the rename over it fails, so the
        // write must report the error and clean up its temporary file.
        let target = dir.join("taken");
        std::fs::create_dir_all(target.join("inside")).unwrap();
        assert!(write_file_atomically(&target, b"bytes").is_err());
        assert!(target.is_dir(), "the existing folder is untouched");
        assert!(leftovers(&dir).is_empty(), "the temporary file is removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decodes_the_percent_encoded_header() {
        assert_eq!(
            decode_path_header("%2FUsers%2Fa%20b%2Fpr%C3%A9dictions%2B1.csv").unwrap(),
            "/Users/a b/prédictions+1.csv"
        );
        assert_eq!(decode_path_header("/plain/path.csv").unwrap(), "/plain/path.csv");
        assert!(decode_path_header("%2").is_err(), "a cut escape");
        assert!(decode_path_header("%ZZ").is_err(), "not hex");
        assert!(decode_path_header("%FF%FE").is_err(), "not UTF-8");
    }
}
