//! Fetch the published method list with the bundled `oras`.
//!
//! The list is ONE OCI artifact holding `method-list.json` and `method-list.json.minisig`,
//! in the public package `ghcr.io/tinnlab/txresbench-method-list`; the moving tag
//! `v<format_version>` (`v1`) names the newest published list of this format line. A check
//! resolves the tag to its manifest digest (a few hundred bytes); only a digest the app has
//! not seen is pulled, BY DIGEST (`…@sha256:…`), so the files checked are exactly the
//! resolved ones.
//!
//! oras runs exactly as the method environment downloads run it (`sandbox::method_env`): the
//! app's empty registry config (anonymous; the user's Docker logins are never read) and a
//! cleared environment (PATH, HOME, proxies, CA bundle). GHCR answers every blob GET with a
//! redirect to `pkg-containers.githubusercontent.com`, so the two hosts a firewall must allow
//! are the env downloads' two. The pull is capped while it runs: past the 16 MiB list cap the
//! child is killed (`METHOD_LIST_TOO_LARGE`), the bytes are never read whole. Before the
//! pull, the artifact's manifest (`oras manifest fetch`, a few hundred bytes, capped) must
//! name exactly the two files, by those names, within their caps and not as a folder to
//! unpack: an artifact that would bring anything else is refused without being pulled (and
//! its digest remembered). The pulled folder must then hold exactly the two files, as
//! regular files; both are read capped.
//!
//! Debug-only seams (a release build never reads either variable):
//! - `TXR_METHOD_LIST_REF=<host>[:<port>]/<path>:<tag>` replaces the reference. A loopback
//!   host (`127.0.0.1`, `localhost`, `[::1]`) is fetched over plain HTTP, any other host
//!   over HTTPS (e.g. a personal `ghcr.io/<user>/<package>:<tag>` rehearsal list).
//! - `TXR_METHOD_LIST_TEST_KEY=<file>` trusts one more key: a minisign public key file as
//!   `minisign -G` writes it (`runtime` adds it to the compiled-in keys).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use txresbench_core::AppError;

use super::format::FORMAT_VERSION;
use super::verify::{MAX_LIST_BYTES, MAX_SIGNATURE_BYTES};
use crate::modules::sandbox::method_env::{self, MethodEnvSeams};

/// The list's package name under the app's registry namespace.
pub const LIST_REPOSITORY: &str = "txresbench-method-list";
/// The list file inside the artifact.
pub const LIST_FILE: &str = "method-list.json";
/// The signature file inside the artifact.
pub const SIGNATURE_FILE: &str = "method-list.json.minisig";
/// The debug-only reference seam.
pub const LIST_REF_ENV: &str = "TXR_METHOD_LIST_REF";
/// The debug-only extra trusted key seam.
pub const TEST_KEY_ENV: &str = "TXR_METHOD_LIST_TEST_KEY";

/// Where a check fetches the list from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListRef {
    /// `<host>/<namespace>/<package>`, without a scheme or a tag.
    pub repository: String,
    /// The moving tag (`v1` in production).
    pub tag: String,
    /// Plain HTTP: a loopback registry named by the debug seam.
    pub plain_http: bool,
}

impl ListRef {
    /// The compiled reference: the app's registry host and namespace, the list package and
    /// this build's format line.
    pub fn production() -> ListRef {
        ListRef {
            repository: format!(
                "{}/{}/{LIST_REPOSITORY}",
                method_env::TXR_REGISTRY_HOST,
                method_env::TXR_REGISTRY_NAMESPACE
            ),
            tag: format!("v{FORMAT_VERSION}"),
            plain_http: false,
        }
    }

    /// `<repository>:<tag>`, what `oras resolve` asks for.
    pub fn tag_ref(&self) -> String {
        format!("{}:{}", self.repository, self.tag)
    }

    /// `<repository>@<digest>`, what `oras pull` fetches.
    pub fn digest_ref(&self, digest: &str) -> String {
        format!("{}@{digest}", self.repository)
    }

    /// The registry host (with its port, if any).
    pub fn host(&self) -> &str {
        self.repository.split('/').next().unwrap_or_default()
    }

    /// Parse the debug seam's value, `<host>[:<port>]/<path>:<tag>`.
    pub fn parse_seam(value: &str) -> Result<ListRef, String> {
        let v = value.trim();
        let bad = |why: &str| format!("{LIST_REF_ENV}={v:?}: {why} (want <host>[:<port>]/<path>:<tag>)");
        if v.contains("://") {
            return Err(bad("no scheme"));
        }
        if v.contains('@') {
            return Err(bad("name a tag, not a digest"));
        }
        let slash = v.find('/').ok_or_else(|| bad("no path"))?;
        let colon = v
            .rfind(':')
            .filter(|c| *c > v.rfind('/').unwrap_or(0))
            .ok_or_else(|| bad("no tag"))?;
        let (repository, tag) = (&v[..colon], &v[colon + 1..]);
        let host = &v[..slash];
        let tag_ok = !tag.is_empty()
            && tag.len() <= 128
            && tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
            && !tag.starts_with(['.', '-']);
        if !tag_ok {
            return Err(bad("the tag is not an OCI tag"));
        }
        let path_ok = repository[slash + 1..].split('/').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        });
        if host.is_empty() || !path_ok {
            return Err(bad("the repository is not an OCI repository"));
        }
        Ok(ListRef {
            repository: repository.to_string(),
            tag: tag.to_string(),
            plain_http: is_loopback(host),
        })
    }
}

/// Whether `host[:port]` is this computer.
fn is_loopback(host_port: &str) -> bool {
    let host = match host_port.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or_default(),
        None => host_port.split(':').next().unwrap_or_default(),
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// The reference a build fetches: production, or the debug seam. `read` is the
/// environment and `debug` the build's own flag (`cfg!(debug_assertions)`), passed in so
/// the release half is tested too (`runtime::production_seams` passes the real ones).
pub fn list_ref_with(read: &impl Fn(&str) -> Option<String>, debug: bool) -> Result<ListRef, String> {
    match read(LIST_REF_ENV).filter(|v| debug && !v.trim().is_empty()) {
        Some(v) => ListRef::parse_seam(&v),
        None => Ok(ListRef::production()),
    }
}

/// The debug seam's extra trusted key file, if the build honours one (as [`list_ref_with`]).
pub fn test_key_path_with(read: &impl Fn(&str) -> Option<String>, debug: bool) -> Option<PathBuf> {
    read(TEST_KEY_ENV)
        .filter(|v| debug && !v.trim().is_empty())
        .map(|v| PathBuf::from(v.trim()))
}

/// Why a fetch did not bring a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// No `oras` next to the app, in `<app_data>/bin` or on PATH (a dev build).
    ToolMissing,
    /// The registry did not answer in time or refused (offline, DNS, a firewall, nothing
    /// published yet).
    Unreachable { detail: String },
    /// The pull went past the list cap and was stopped.
    TooLarge,
    /// The artifact is not exactly the list and its signature as regular files.
    BadArtifact { detail: String },
    /// A local failure (the temp folder, a read).
    Local { detail: String },
}

impl FetchError {
    /// The stable code.
    pub fn code(&self) -> &'static str {
        match self {
            FetchError::ToolMissing => "METHOD_LIST_TOOL_MISSING",
            FetchError::Unreachable { .. } => "METHOD_LIST_UNREACHABLE",
            FetchError::TooLarge => "METHOD_LIST_TOO_LARGE",
            FetchError::BadArtifact { .. } => "METHOD_LIST_BAD_ARTIFACT",
            FetchError::Local { .. } => "METHOD_LIST_LOCAL_ERROR",
        }
    }

    /// Whether the published artifact itself is at fault (its digest is remembered and
    /// never pulled again), as opposed to the network or this computer.
    pub fn is_artifact_fault(&self) -> bool {
        matches!(self, FetchError::TooLarge | FetchError::BadArtifact { .. })
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = self.code();
        match self {
            FetchError::ToolMissing => write!(f, "{code}: the download tool is not installed"),
            FetchError::Unreachable { detail } => write!(f, "{code}: {detail}"),
            FetchError::TooLarge => write!(
                f,
                "{code}: the published list is over the {MAX_LIST_BYTES}-byte cap"
            ),
            FetchError::BadArtifact { detail } => write!(f, "{code}: {detail}"),
            FetchError::Local { detail } => write!(f, "{code}: {detail}"),
        }
    }
}

/// The two files of a pulled list, not yet verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub list: Vec<u8>,
    pub signature: Vec<u8>,
}

/// Where lists come from (the registry through oras; the tests' in-memory sources).
pub trait ListSource: Send + Sync {
    /// The reference, for logs and the status.
    fn describe(&self) -> String;
    /// The moving tag's manifest digest (`sha256:<64 hex>`).
    fn resolve(&self, timeout: Duration) -> Result<String, FetchError>;
    /// The two files of the artifact at `digest`.
    fn pull(&self, digest: &str, timeout: Duration) -> Result<Fetched, FetchError>;
}

/// The largest manifest the app reads (a list artifact's is a few hundred bytes).
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;

/// The OCI annotation naming a layer's file.
const TITLE_ANNOTATION: &str = "org.opencontainers.image.title";
/// The annotation oras sets on a layer that is a folder (a tarball it unpacks).
const UNPACK_ANNOTATION: &str = "io.deis.oras.content.unpack";

/// What a list artifact's manifest must say before anything is pulled: exactly two layers,
/// titled `method-list.json` and `method-list.json.minisig` (no folder, no path), each within
/// its cap, neither one a folder to unpack. A refusal is the artifact's fault.
pub fn check_manifest(text: &str) -> Result<(), FetchError> {
    let bad = |detail: String| FetchError::BadArtifact { detail };
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(bad(format!("the artifact's manifest is over {MAX_MANIFEST_BYTES} bytes")));
    }
    let manifest: serde_json::Value =
        serde_json::from_str(text).map_err(|e| bad(format!("the artifact's manifest is not JSON: {e}")))?;
    let layers = manifest["layers"]
        .as_array()
        .ok_or_else(|| bad("the artifact's manifest lists no layers".to_string()))?;
    if layers.len() != 2 {
        return Err(bad(format!(
            "the artifact holds {} layers, not exactly {LIST_FILE} and {SIGNATURE_FILE}",
            layers.len()
        )));
    }
    let mut titles = Vec::with_capacity(2);
    for layer in layers {
        let annotations = &layer["annotations"];
        let title = annotations[TITLE_ANNOTATION]
            .as_str()
            .ok_or_else(|| bad("a layer of the artifact has no file name".to_string()))?;
        if !annotations[UNPACK_ANNOTATION].is_null() {
            return Err(bad(format!("{title:?} in the artifact is a folder to unpack")));
        }
        let cap = match title {
            LIST_FILE => MAX_LIST_BYTES,
            SIGNATURE_FILE => MAX_SIGNATURE_BYTES,
            other => {
                return Err(bad(format!(
                    "the artifact holds {other:?}, not exactly {LIST_FILE} and {SIGNATURE_FILE}"
                )))
            }
        };
        let size = layer["size"]
            .as_u64()
            .ok_or_else(|| bad(format!("{title} in the artifact has no size")))?;
        if size > cap as u64 {
            return Err(if title == LIST_FILE {
                FetchError::TooLarge
            } else {
                bad(format!("{title} in the artifact is over the {cap}-byte cap"))
            });
        }
        titles.push(title);
    }
    titles.sort_unstable();
    if titles != [LIST_FILE, SIGNATURE_FILE] {
        return Err(bad(format!("the artifact holds {titles:?} twice over")));
    }
    Ok(())
}

/// `sha256:` + 64 lowercase hex.
pub fn is_digest(s: &str) -> bool {
    s.strip_prefix("sha256:")
        .is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// The registry, through the bundled oras.
pub struct OrasSource {
    list_ref: ListRef,
    /// Pulls land in fresh folders under it (`<data_root>/method-list/v1`).
    work_dir: PathBuf,
}

impl OrasSource {
    pub fn new(list_ref: ListRef, work_dir: PathBuf) -> OrasSource {
        OrasSource { list_ref, work_dir }
    }

    /// The env manager's seams for oras's arguments: a loopback reference turns on
    /// `--plain-http` (debug builds only, like the env downloads' seam); any other host is
    /// HTTPS.
    fn seams(&self) -> MethodEnvSeams {
        MethodEnvSeams {
            registry: self.list_ref.plain_http.then(|| self.list_ref.host().to_string()),
            bypass_air_gap_env: false,
        }
    }

    fn oras(&self) -> Result<PathBuf, FetchError> {
        method_env::tool_bin("oras").ok_or(FetchError::ToolMissing)
    }
}

/// An oras run's failure as a fetch error: a timeout, a non-zero exit (refused, not found,
/// DNS) or a cancel is the registry's side; a spawn failure is a missing tool.
fn tool_error(e: AppError) -> FetchError {
    match e.error_code() {
        method_env::ENV_TOOL_MISSING_CODE => FetchError::ToolMissing,
        method_env::ENV_STAGING_TIMEOUT_CODE
        | method_env::ENV_REPOSITORY_UNKNOWN_CODE
        | method_env::ENV_DOWNLOAD_CANCELLED_CODE => FetchError::Unreachable {
            detail: e.to_string(),
        },
        _ => FetchError::Local {
            detail: e.to_string(),
        },
    }
}

impl ListSource for OrasSource {
    fn describe(&self) -> String {
        self.list_ref.tag_ref()
    }

    fn resolve(&self, timeout: Duration) -> Result<String, FetchError> {
        let tool = self.oras()?;
        let mut args = method_env::oras_base_args(&["resolve"], &self.seams()).map_err(tool_error)?;
        args.push(self.list_ref.tag_ref());
        let out = method_env::run_tool(&tool, &args, timeout, &AtomicBool::new(false), None, &mut |_| {})
            .map_err(tool_error)?;
        let digest = out.trim();
        if !is_digest(digest) {
            return Err(FetchError::Unreachable {
                detail: format!("`oras resolve` did not answer a sha256 digest: {digest:?}"),
            });
        }
        Ok(digest.to_string())
    }

    fn pull(&self, digest: &str, timeout: Duration) -> Result<Fetched, FetchError> {
        if !is_digest(digest) {
            return Err(FetchError::BadArtifact {
                detail: format!("{digest:?} is not a sha256 digest"),
            });
        }
        let tool = self.oras()?;
        let started = std::time::Instant::now();
        // The manifest first: what the pull would bring, checked before a byte is pulled.
        let mut args = method_env::oras_base_args(&["manifest", "fetch"], &self.seams()).map_err(tool_error)?;
        args.push(self.list_ref.digest_ref(digest));
        let manifest = method_env::run_tool(&tool, &args, timeout, &AtomicBool::new(false), None, &mut |_| {})
            .map_err(tool_error)?;
        check_manifest(&manifest)?;
        let timeout = timeout.saturating_sub(started.elapsed());
        let dir = PullDir::create(&self.work_dir)?;
        let mut args = method_env::oras_base_args(&["pull"], &self.seams()).map_err(tool_error)?;
        args.push("-o".to_string());
        args.push(dir.0.to_string_lossy().into_owned());
        args.push(self.list_ref.digest_ref(digest));
        let cancel = AtomicBool::new(false);
        let over = AtomicBool::new(false);
        let ran = method_env::run_tool(&tool, &args, timeout, &cancel, Some(&dir.0), &mut |bytes| {
            if bytes > MAX_LIST_BYTES as u64 {
                over.store(true, Ordering::SeqCst);
                cancel.store(true, Ordering::SeqCst);
            }
        });
        if over.load(Ordering::SeqCst) {
            return Err(FetchError::TooLarge);
        }
        ran.map_err(tool_error)?;
        read_pulled(&dir.0)
    }
}

/// A fresh, empty pull folder, removed when dropped.
struct PullDir(PathBuf);

impl PullDir {
    fn create(work_dir: &Path) -> Result<PullDir, FetchError> {
        let dir = work_dir.join(format!(".pull-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).map_err(|e| FetchError::Local {
            detail: format!("make the pull folder: {e}"),
        })?;
        Ok(PullDir(dir))
    }
}

impl Drop for PullDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The two files of a pulled artifact: exactly `method-list.json` and its `.minisig`, both
/// regular files, both read capped.
pub(crate) fn read_pulled(dir: &Path) -> Result<Fetched, FetchError> {
    let local = |e: std::io::Error| FetchError::Local {
        detail: format!("read the pulled list: {e}"),
    };
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map_err(local)?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()
        .map_err(local)?;
    names.sort();
    if names != [LIST_FILE, SIGNATURE_FILE] {
        return Err(FetchError::BadArtifact {
            detail: format!(
                "the published artifact holds {names:?}, not exactly {LIST_FILE} and {SIGNATURE_FILE}"
            ),
        });
    }
    let read = |name: &str, cap: usize| -> Result<Vec<u8>, FetchError> {
        let path = dir.join(name);
        let meta = std::fs::symlink_metadata(&path).map_err(local)?;
        if !meta.file_type().is_file() {
            return Err(FetchError::BadArtifact {
                detail: format!("{name} in the published artifact is not a regular file"),
            });
        }
        let mut bytes = Vec::new();
        use std::io::Read as _;
        std::fs::File::open(&path)
            .map_err(local)?
            .take(cap as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(local)?;
        if bytes.len() > cap {
            return Err(if name == LIST_FILE {
                FetchError::TooLarge
            } else {
                FetchError::BadArtifact {
                    detail: format!("{name} is over the {cap}-byte cap"),
                }
            });
        }
        Ok(bytes)
    };
    Ok(Fetched {
        list: read(LIST_FILE, MAX_LIST_BYTES)?,
        signature: read(SIGNATURE_FILE, MAX_SIGNATURE_BYTES)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::rootfs;
    use std::time::Instant;

    /// A scratch app data root under `TXR_TEST_SCRATCH` or the build area (never the system
    /// temp folder), scoped to this thread.
    fn data_root(tag: &str) -> (PathBuf, rootfs::DataRootGuard) {
        let root = crate::modules::method_list::test_scratch::dir("method-list-fetch", tag);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let guard = rootfs::scoped_data_root(root.clone());
        (root, guard)
    }

    /// An executable stub `<data>/bin/oras` (tool_bin finds `<app_data>/bin` before PATH).
    fn stub_oras(root: &Path, script: &str) {
        let path = root.join("bin").join("oras");
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    const DIGEST: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

    /// A list artifact's manifest: `(title, size, unpack)` per layer.
    fn manifest(layers: &[(&str, u64, bool)]) -> String {
        let layers: Vec<serde_json::Value> = layers
            .iter()
            .map(|(title, size, unpack)| {
                let mut annotations = serde_json::json!({ TITLE_ANNOTATION: title });
                if *unpack {
                    annotations[UNPACK_ANNOTATION] = "true".into();
                }
                serde_json::json!({
                    "mediaType": "application/vnd.oci.image.layer.v1.tar",
                    "digest": DIGEST, "size": size, "annotations": annotations,
                })
            })
            .collect();
        serde_json::json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "artifactType": "application/vnd.txresbench.method-list.v1",
            "layers": layers,
        })
        .to_string()
    }

    fn good_manifest() -> String {
        manifest(&[(LIST_FILE, 4, false), (SIGNATURE_FILE, 3, false)])
    }

    /// A stub that resolves to [`DIGEST`], answers `manifest fetch` with `<root>/manifest.json`
    /// and pulls by writing `files` (shell lines run with `$out` = the -o folder), recording
    /// every call's arguments and environment.
    fn script(root: &Path, files: &str) -> String {
        if !root.join("manifest.json").exists() {
            std::fs::write(root.join("manifest.json"), good_manifest()).unwrap();
        }
        format!(
            "#!/bin/sh\n\
             echo \"$@\" >> {calls}\n\
             env >> {envs}\n\
             if [ \"$1\" = \"resolve\" ]; then echo {DIGEST}; exit 0; fi\n\
             if [ \"$1\" = \"manifest\" ]; then cat {manifest}; exit 0; fi\n\
             if [ \"$1\" = \"pull\" ]; then\n\
             \x20 out=\"\"; prev=\"\"\n\
             \x20 for a in \"$@\"; do if [ \"$prev\" = \"-o\" ]; then out=\"$a\"; fi; prev=\"$a\"; done\n\
             {files}\n\
             \x20 exit 0\n\
             fi\n\
             exit 1\n",
            calls = root.join("calls.txt").display(),
            envs = root.join("env.txt").display(),
            manifest = root.join("manifest.json").display(),
        )
    }

    fn two_files() -> &'static str {
        "  printf 'list' > \"$out/method-list.json\"\n  printf 'sig' > \"$out/method-list.json.minisig\""
    }

    fn source(root: &Path, list_ref: ListRef) -> OrasSource {
        OrasSource::new(list_ref, root.join("method-list").join("v1"))
    }

    fn loopback() -> ListRef {
        ListRef::parse_seam("127.0.0.1:5055/tinnlab/txresbench-method-list:v1").unwrap()
    }

    #[test]
    fn list_ref_under_compiled_registry() {
        let r = ListRef::production();
        assert_eq!(r.tag_ref(), "ghcr.io/tinnlab/txresbench-method-list:v1");
        assert_eq!(r.host(), method_env::TXR_REGISTRY_HOST);
        assert!(r.repository.starts_with(&format!(
            "{}/{}/",
            method_env::TXR_REGISTRY_HOST,
            method_env::TXR_REGISTRY_NAMESPACE
        )));
        assert_eq!(r.tag, format!("v{FORMAT_VERSION}"), "the tag is this build's format line");
        assert!(!r.plain_http);
        assert_eq!(r.digest_ref(DIGEST), format!("ghcr.io/tinnlab/txresbench-method-list@{DIGEST}"));
    }

    #[test]
    fn list_seam_reads_loopback_and_https_refs() {
        let l = ListRef::parse_seam("127.0.0.1:5055/tinnlab/txresbench-method-list:v1").unwrap();
        assert!(l.plain_http);
        assert_eq!(l.host(), "127.0.0.1:5055");
        let l = ListRef::parse_seam("[::1]:5000/x/list:v1").unwrap();
        assert!(l.plain_http);
        // A personal package on GHCR: HTTPS.
        let p = ListRef::parse_seam("ghcr.io/someone/txresbench-method-list-test:v1").unwrap();
        assert!(!p.plain_http);
        assert_eq!(p.tag_ref(), "ghcr.io/someone/txresbench-method-list-test:v1");
        for bad in [
            "https://ghcr.io/x/y:v1",
            "ghcr.io/x/y@sha256:00",
            "ghcr.io/x/y",
            "ghcr.io:v1",
            "ghcr.io/X/y:v1",
            "ghcr.io/x//y:v1",
            "ghcr.io/x/y:-v1",
        ] {
            assert!(ListRef::parse_seam(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn release_build_ignores_list_seams() {
        let read = |k: &str| match k {
            LIST_REF_ENV => Some("127.0.0.1:5055/tinnlab/txresbench-method-list:v1".to_string()),
            TEST_KEY_ENV => Some("/some/test.pub".to_string()),
            _ => None,
        };
        // A release build: the production reference and no extra key, whatever is set.
        assert_eq!(list_ref_with(&read, false).unwrap(), ListRef::production());
        assert_eq!(test_key_path_with(&read, false), None);
        // A debug build honours both.
        assert!(list_ref_with(&read, true).unwrap().plain_http);
        assert_eq!(test_key_path_with(&read, true), Some(PathBuf::from("/some/test.pub")));
        // Unset or blank: production.
        assert_eq!(list_ref_with(&|_| None, true).unwrap(), ListRef::production());
        assert_eq!(list_ref_with(&|_| Some("  ".to_string()), true).unwrap(), ListRef::production());
    }

    #[cfg(unix)]
    #[test]
    fn pull_pins_resolved_digest() {
        let (root, _g) = data_root("pins");
        stub_oras(&root, &script(&root, two_files()));
        let src = source(&root, loopback());
        let digest = src.resolve(Duration::from_secs(10)).expect("resolves");
        assert_eq!(digest, DIGEST);
        let got = src.pull(&digest, Duration::from_secs(10)).expect("pulls");
        assert_eq!(got, Fetched { list: b"list".to_vec(), signature: b"sig".to_vec() });
        let calls = std::fs::read_to_string(root.join("calls.txt")).unwrap();
        let pull = calls.lines().find(|l| l.starts_with("pull")).expect("a pull call");
        assert!(
            pull.ends_with(&format!("127.0.0.1:5055/tinnlab/txresbench-method-list@{DIGEST}")),
            "the pull names the resolved digest, never the moving tag: {pull}"
        );
        let resolve = calls.lines().find(|l| l.starts_with("resolve")).expect("a resolve call");
        assert!(resolve.ends_with("127.0.0.1:5055/tinnlab/txresbench-method-list:v1"), "{resolve}");
        // The pull folder is gone after the read.
        let left: Vec<_> = std::fs::read_dir(root.join("method-list").join("v1")).unwrap().collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[cfg(unix)]
    #[test]
    fn oras_gets_empty_registry_config_and_listed_env() {
        let (root, _g) = data_root("env");
        stub_oras(&root, &script(&root, two_files()));
        // HTTPS (a personal GHCR list): no --plain-http.
        let https = ListRef::parse_seam("ghcr.io/someone/txresbench-method-list-test:v1").unwrap();
        let src = source(&root, https);
        src.pull(&src.resolve(Duration::from_secs(10)).unwrap(), Duration::from_secs(10))
            .expect("pulls");
        let config = root.join("oras").join("registry-config.json");
        assert_eq!(std::fs::read(&config).expect("the app's own config"), b"{}");
        let calls = std::fs::read_to_string(root.join("calls.txt")).unwrap();
        for line in calls.lines() {
            assert!(line.contains(&format!("--registry-config {}", config.display())), "{line}");
            assert!(!line.contains("--plain-http"), "HTTPS for a non-loopback host: {line}");
        }
        // The loopback seam adds --plain-http.
        std::fs::remove_file(root.join("calls.txt")).unwrap();
        let src = source(&root, loopback());
        src.resolve(Duration::from_secs(10)).unwrap();
        let calls = std::fs::read_to_string(root.join("calls.txt")).unwrap();
        assert!(calls.contains("--plain-http"), "{calls}");
        // Only PATH, HOME and the env manager's passthrough list reach oras (plus what /bin/sh
        // sets for itself); no token, no DOCKER_*.
        let shell_own = ["PWD", "OLDPWD", "SHLVL", "_"];
        let passthrough = [
            "SystemRoot", "windir", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
            "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
            "SSL_CERT_FILE", "SSL_CERT_DIR",
        ];
        for line in std::fs::read_to_string(root.join("env.txt")).unwrap().lines() {
            let Some((name, _)) = line.split_once('=') else { continue };
            assert!(
                name == "PATH" || name == "HOME" || passthrough.contains(&name) || shell_own.contains(&name),
                "oras got {name}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn extra_or_missing_file_refused() {
        let (root, _g) = data_root("files");
        let extra = format!("{}\n  printf 'x' > \"$out/notes.txt\"", two_files());
        stub_oras(&root, &script(&root, &extra));
        let err = source(&root, loopback()).pull(DIGEST, Duration::from_secs(10)).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_BAD_ARTIFACT", "{err}");
        assert!(err.is_artifact_fault());

        let (root, _g) = data_root("files-missing");
        stub_oras(&root, &script(&root, "  printf 'list' > \"$out/method-list.json\""));
        let err = source(&root, loopback()).pull(DIGEST, Duration::from_secs(10)).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_BAD_ARTIFACT", "{err}");

        // A symlink in place of the signature is not a regular file.
        let (root, _g) = data_root("files-link");
        let link = "  printf 'list' > \"$out/method-list.json\"\n  ln -s /etc/hosts \"$out/method-list.json.minisig\"";
        stub_oras(&root, &script(&root, link));
        let err = source(&root, loopback()).pull(DIGEST, Duration::from_secs(10)).unwrap_err();
        assert!(err.to_string().contains("not a regular file"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn pull_past_cap_is_killed() {
        let (root, _g) = data_root("cap");
        // The stub writes 17 MiB and then keeps running (`exec`: one process, like oras, so
        // the kill closes its pipes): the progress poll stops it.
        let big = format!(
            "  head -c {} /dev/zero > \"$out/method-list.json\"\n  exec sleep 30",
            17 * 1024 * 1024
        );
        stub_oras(&root, &script(&root, &big));
        let started = Instant::now();
        let err = source(&root, loopback()).pull(DIGEST, Duration::from_secs(60)).unwrap_err();
        assert_eq!(err, FetchError::TooLarge);
        assert!(err.is_artifact_fault());
        assert!(started.elapsed() < Duration::from_secs(20), "killed, not waited out");
        let left: Vec<_> = std::fs::read_dir(root.join("method-list").join("v1")).unwrap().collect();
        assert!(left.is_empty(), "the partial pull is removed: {left:?}");
    }

    #[cfg(unix)]
    #[test]
    fn timeout_is_offline_not_error() {
        let (root, _g) = data_root("timeout");
        stub_oras(&root, "#!/bin/sh\nexec sleep 30\n");
        let started = Instant::now();
        let err = source(&root, loopback()).resolve(Duration::from_millis(400)).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_UNREACHABLE", "{err}");
        assert!(!err.is_artifact_fault(), "the network's fault: nothing is remembered");
        assert!(started.elapsed() < Duration::from_secs(10));
        // A refusal (non-zero exit) is the same: unreachable.
        stub_oras(&root, "#!/bin/sh\necho 'denied' >&2\nexit 1\n");
        let err = source(&root, loopback()).resolve(Duration::from_secs(10)).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_UNREACHABLE", "{err}");
    }

    /// An artifact whose manifest names anything but the two files within their caps is
    /// refused from the manifest: nothing is pulled, and the refusal is the artifact's fault
    /// (the runtime remembers its digest).
    #[cfg(unix)]
    #[test]
    fn a_manifest_other_than_the_two_files_is_refused_before_the_pull() {
        let cases: Vec<(&str, String, &str)> = vec![
            (
                "three-layers",
                manifest(&[(LIST_FILE, 4, false), (SIGNATURE_FILE, 3, false), ("extra.bin", 1, false)]),
                "METHOD_LIST_BAD_ARTIFACT",
            ),
            (
                "sub-folder",
                manifest(&[("lists/method-list.json", 4, false), (SIGNATURE_FILE, 3, false)]),
                "METHOD_LIST_BAD_ARTIFACT",
            ),
            (
                "unpack",
                manifest(&[(LIST_FILE, 4, true), (SIGNATURE_FILE, 3, false)]),
                "METHOD_LIST_BAD_ARTIFACT",
            ),
            (
                "list-over-cap",
                manifest(&[(LIST_FILE, MAX_LIST_BYTES as u64 + 1, false), (SIGNATURE_FILE, 3, false)]),
                "METHOD_LIST_TOO_LARGE",
            ),
            (
                "many-just-under",
                manifest(&[(LIST_FILE, MAX_LIST_BYTES as u64, false), (LIST_FILE, MAX_LIST_BYTES as u64, false)]),
                "METHOD_LIST_BAD_ARTIFACT",
            ),
            (
                "signature-over-cap",
                manifest(&[(LIST_FILE, 4, false), (SIGNATURE_FILE, MAX_SIGNATURE_BYTES as u64 + 1, false)]),
                "METHOD_LIST_BAD_ARTIFACT",
            ),
            ("not-json", "not a manifest".to_string(), "METHOD_LIST_BAD_ARTIFACT"),
        ];
        for (tag, text, code) in cases {
            let (root, _g) = data_root(&format!("manifest-{tag}"));
            std::fs::write(root.join("manifest.json"), text).unwrap();
            stub_oras(&root, &script(&root, two_files()));
            let err = source(&root, loopback()).pull(DIGEST, Duration::from_secs(10)).unwrap_err();
            assert_eq!(err.code(), code, "{tag}: {err}");
            assert!(err.is_artifact_fault(), "{tag}: remembered as the artifact's fault");
            let calls = std::fs::read_to_string(root.join("calls.txt")).unwrap();
            assert!(!calls.lines().any(|l| l.starts_with("pull")), "{tag}: nothing pulled: {calls}");
            let manifest_call = calls.lines().find(|l| l.starts_with("manifest fetch")).expect("asked");
            assert!(manifest_call.ends_with(&format!("txresbench-method-list@{DIGEST}")), "{manifest_call}");
        }
        // The two files within their caps pass.
        check_manifest(&good_manifest()).expect("the list and its signature");
    }

    #[test]
    fn digests_are_checked() {
        assert!(is_digest(DIGEST));
        assert!(!is_digest("sha256:XYZ"));
        assert!(!is_digest(&DIGEST.to_uppercase()));
        assert!(!is_digest("1111"));
    }
}
