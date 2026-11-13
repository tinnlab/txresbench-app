//! Host ↔ guest control protocol for the macOS method VM (libkrun). The host
//! (the server's macOS run seam) builds the **full bwrap argv** using *guest*
//! paths and sends it to the in-VM guest agent, which execs it, streams the
//! output back, and then copies the run's outputs back in chunks — so the host's
//! argv builder stays the single source of truth for hardening; the guest agent
//! is a dumb executor.
//!
//! ## Wire format
//!
//! A stream of length-prefixed frames, each: `[u8 tag][u32 BE len][payload]`.
//! Structured frames (`Exec`, `Exit`) carry a JSON payload; output frames
//! (`Stdout`, `Stderr`) and `Progress` carry raw bytes; the artifact frames carry
//! `[u32 BE mount_index][u32 BE rel_path_len][rel_path utf8]` and then their
//! own data. Tags are unique across both directions so a single decoder serves
//! host and guest.
//!
//! ## One exchange per connection
//!
//! The host sends one `Exec`. The agent runs the command, streams `Stdout` /
//! `Stderr` / `Progress`, sends `Exit` as soon as the command ends, then
//! the outputs (`ArtifactDir` / `ArtifactChunk` / `ArtifactSymlink` /
//! `ArtifactSkipped`), then `ArtifactsDone`, and closes.
//!
//! This crate is **pure** (no IO): each side does its own (async) socket IO and
//! uses [`encode`] / [`Decoder`] for framing. That keeps the contract trivially
//! unit-testable and dependency-light.

use serde::{Deserialize, Serialize};

/// Wire-protocol version. Bumped any time the on-wire shape of `Frame` or
/// `ExecRequest` changes in a way that would break an older peer. Host + agent
/// ship together (the guest root is built from the same tree), so a mismatch
/// always indicates a stale guest root against a fresh server (or vice versa).
/// Defense-in-depth — surfaces the mismatch loudly instead of running against
/// undefined semantics.
///
/// 3: one exchange per connection, outputs always copied back in chunks (the
/// one-file-per-frame write-back, the long-lived multi-process frames and the
/// shutdown frame are gone), progress lines as plain `Progress` frames. A v3 request has no flag asking for chunks, so an
/// earlier agent would read it as asking for the old write-back; it refuses it
/// instead (3 is above its range), the agent here refuses any other version
/// ([`ExecRequest::check_version`]), and the server's boot probe refuses a guest
/// root whose marker does not cover this version, before any VM boots.
pub const PROTOCOL_VERSION: u32 = 3;

/// The oldest request version this agent still serves (see [`PROTOCOL_VERSION`]).
/// The guest root records the range `PROTOCOL_VERSION_MIN PROTOCOL_VERSION`.
pub const PROTOCOL_VERSION_MIN: u32 = 3;

/// Guest-local FIFO path the agent creates. The host-built bwrap argv binds it
/// to the path the method writes its progress lines to inside the sandbox (the
/// host's stacked argv builder owns that path and the env var naming it). MUST
/// live on a guest-local filesystem (the
/// agent's `/tmp` tmpfs) — libkrun virtio-fs has an `O_CREAT`/`mkfifo` EPERM
/// bug on macOS, so the FIFO cannot live on the virtio-fs-shared workspace.
pub const PROGRESS_GUEST_FIFO_PATH: &str = "/tmp/.txresbench-progress.fifo";

/// Per-line cap on a progress FIFO `write()`. A single FIFO write below
/// `PIPE_BUF` (4096 on Linux) is atomic, so concurrent writers can't interleave
/// partial lines. Lines longer than this are dropped (not forwarded) rather
/// than risking a torn/interleaved frame. Shared host+agent so both readers
/// enforce the same boundary.
pub const PROGRESS_MAX_LINE_BYTES: usize = 4096;

/// Request to run one command in the sandbox. `argv` is the complete bwrap
/// argv produced by the host (already pointing at *guest* paths for the rootfs
/// mount + workspace); the agent execs `bwrap_path` with it verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecRequest {
    /// [`PROTOCOL_VERSION`]; the agent checks it with
    /// [`ExecRequest::check_version`]. Peers that predate the field send no
    /// value → serde defaults to `0` → refused.
    #[serde(default)]
    pub protocol_version: u32,
    /// Correlates the response frames with this request (one request per
    /// connection, so this is mostly for logs and the progress handle).
    pub request_id: u64,
    /// Absolute path to `bwrap` inside the guest.
    pub bwrap_path: String,
    /// Full bwrap argv (guest paths). When `seccomp_fd` is set, the argv
    /// already contains `--seccomp <that fd>`.
    pub argv: Vec<String>,
    /// Wall-clock budget; the agent SIGKILLs the bwrap process group on expiry.
    pub timeout_ms: u64,
    /// If set, the agent builds the shared seccomp BPF and pipes it to this fd
    /// in the bwrap child (the argv references it via `--seccomp <fd>`), so the
    /// guest applies the same filter the Linux host does. `None` → no seccomp.
    #[serde(default)]
    pub seccomp_fd: Option<i32>,
    /// If set, the agent creates an in-guest cgroup v2 scope with these limits
    /// and attaches the bwrap process to it (defense-in-depth; the in-argv
    /// prlimit is the always-on backstop). `None` → rely on prlimit only. The
    /// host owns the policy so it stays single-source.
    #[serde(default)]
    pub cgroup: Option<CgroupLimits>,
    /// If true, the agent creates the progress FIFO at
    /// [`PROGRESS_GUEST_FIFO_PATH`] before spawning bwrap, reads it line-by-line,
    /// and forwards each line as a [`Frame::Progress`]. The host-built argv
    /// already binds that FIFO where the method writes its progress lines.
    /// `false` → no FIFO.
    #[serde(default)]
    pub progress: bool,
    /// Guest-local output dirs (the libkrun virtio-fs CREATE-EPERM workaround:
    /// a sandboxed `open(O_CREAT)` on a virtio-fs RW bind fails with EPERM —
    /// see `docker/sbx-releases#51`, `containers/podman#27679`). For each entry
    /// the agent provisions a **guest-local writable dir** at that path BEFORE
    /// running bwrap, and the bwrap argv binds these dirs as the RW mounts.
    /// AFTER the command exits (and after [`Frame::Exit`]), the agent sends
    /// each dir's contents back in chunks, with `mount_index` = the entry's
    /// position in this vec, and the host writes them into the real host output
    /// dir (see [`Frame::ArtifactChunk`]).
    #[serde(default)]
    pub collect_artifacts: Vec<String>,
    /// Where [`Self::collect_artifacts`] live and how much may come back.
    #[serde(default)]
    pub artifacts: ArtifactOptions,
}

impl ExecRequest {
    /// The agent's check: the request is of a version this agent serves.
    pub fn check_version(&self) -> Result<(), String> {
        let v = self.protocol_version;
        if !(PROTOCOL_VERSION_MIN..=PROTOCOL_VERSION).contains(&v) {
            return Err(format!(
                "protocol version mismatch (peer={v}, agent serves {PROTOCOL_VERSION_MIN}..={PROTOCOL_VERSION})"
            ));
        }
        Ok(())
    }
}

/// How the output dirs are provisioned and bounded (method outputs —
/// predictions and trained models — can be far larger than the guest's small
/// `/tmp`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactOptions {
    /// When set, the agent mounts tmpfs with this `size=` (tmpfs syntax, e.g.
    /// `"2048m"`) before the command runs, instead of creating the dirs on
    /// the small guest `/tmp`: ONE tmpfs at [`Self::tmpfs_root`] shared by
    /// every artifact and scratch dir (which must then live under it), or,
    /// without a root, one tmpfs per artifact dir.
    #[serde(default)]
    pub tmpfs_size: Option<String>,
    /// With `tmpfs_size`: where the one shared tmpfs is mounted.
    #[serde(default)]
    pub tmpfs_root: Option<String>,
    /// Writable guest-local dirs provisioned like the artifact dirs but never
    /// sent back (e.g. the workload's home): scratch that dies with the VM.
    #[serde(default)]
    pub scratch_dirs: Vec<String>,
    /// The total bytes the agent may send for one exec (`0` = no cap beyond
    /// the tmpfs size). Files past the cap are reported with
    /// [`Frame::ArtifactSkipped`].
    #[serde(default)]
    pub total_cap_bytes: u64,
}

/// Largest `data` in one [`Frame::ArtifactChunk`]: comfortably under
/// [`MAX_FRAME_PAYLOAD`] together with the chunk header.
pub const ARTIFACT_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// cgroup v2 resource limits the guest agent applies per exec (the host fills
/// them from its sandbox limits).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CgroupLimits {
    /// `memory.max` (bytes).
    pub memory_max_bytes: u64,
    /// `memory.swap.max` (bytes; 0 disables swap).
    pub memory_swap_max_bytes: u64,
    /// `pids.max`.
    pub pids_max: u64,
    /// `cpu.max` ("<quota> <period>" in µs; "100000 100000" = 1 CPU).
    pub cpu_max: String,
}

/// Terminal status of an `ExecRequest`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExitStatus {
    /// Process exit code (`-1` if killed by signal / timeout).
    pub code: i32,
    /// True if the agent killed it because `timeout_ms` elapsed.
    pub timed_out: bool,
}

/// A single protocol frame, either direction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    // ---- the command (tags 1..=4) ----
    /// host → guest: run this command.
    Exec(ExecRequest),
    /// guest → host: a chunk of stdout.
    Stdout(Vec<u8>),
    /// guest → host: a chunk of stderr.
    Stderr(Vec<u8>),
    /// guest → host: the command finished. Sent as soon as it ends, before
    /// the outputs, so its status is never lost to a failed copy-back.
    Exit(ExitStatus),
    /// guest → host: one live-progress line (without its newline) read from
    /// the method's progress FIFO. The host parses it as a progress / milestone
    /// line, not as output. (Tag 16.)
    Progress(Vec<u8>),

    // ---- output copy-back (tags 17..=21) ----
    // Order: `Exit` first, then ArtifactDir / ArtifactChunk / ArtifactSymlink /
    // ArtifactSkipped for the outputs, then ArtifactsDone. A host must keep
    // reading after `Exit` until ArtifactsDone.
    /// guest → host: `data` belongs at byte `offset` of
    /// `<host_artifact_dir for mount_index>/<rel_path>`. A file's first chunk
    /// has offset 0 (the host creates/truncates the file there; an empty file
    /// is one chunk with empty `data`); its chunks arrive in order, each at
    /// most [`ARTIFACT_CHUNK_BYTES`]. Wire payload:
    /// `[u32 BE mount_index][u32 BE rel_path_len][rel_path utf8][u64 BE offset][data]`.
    ArtifactChunk {
        mount_index: u32,
        rel_path: String,
        offset: u64,
        data: Vec<u8>,
    },
    /// guest → host: an entry in an artifact dir that was NOT (fully) sent —
    /// a read error, a special file, or past `total_cap_bytes`. The host must
    /// treat the outputs as incomplete. Wire payload:
    /// `[u32 BE mount_index][u32 BE rel_path_len][rel_path utf8][reason utf8]`.
    ArtifactSkipped {
        mount_index: u32,
        rel_path: String,
        reason: String,
    },
    /// guest → host: a directory at
    /// `<host_artifact_dir for mount_index>/<rel_path>`, sent before its
    /// contents so an empty directory is recreated too. Wire payload:
    /// `[u32 BE mount_index][u32 BE rel_path_len][rel_path utf8]`.
    ArtifactDir {
        mount_index: u32,
        rel_path: String,
    },
    /// guest → host: a symlink at `rel_path` whose target, as stored in the
    /// link, is `target` (not resolved: the workload created it inside its
    /// sandbox, where the dir is mounted at another path). The host decides
    /// whether it can recreate it safely. Wire payload:
    /// `[u32 BE mount_index][u32 BE rel_path_len][rel_path utf8][target utf8]`.
    ArtifactSymlink {
        mount_index: u32,
        rel_path: String,
        target: String,
    },
    /// guest → host: the copy-back is complete; nothing else follows. Without
    /// it, the host treats the outputs as incomplete.
    ArtifactsDone,
}

// Tags 5..=15 are not used: they belonged to frames of earlier versions and
// are kept free so an old peer's frame can never decode as a new one.
const TAG_EXEC: u8 = 1;
const TAG_STDOUT: u8 = 2;
const TAG_STDERR: u8 = 3;
const TAG_EXIT: u8 = 4;
const TAG_PROGRESS: u8 = 16;
const TAG_ARTIFACT_CHUNK: u8 = 17;
const TAG_ARTIFACT_SKIPPED: u8 = 18;
const TAG_ARTIFACT_DIR: u8 = 19;
const TAG_ARTIFACT_SYMLINK: u8 = 20;
const TAG_ARTIFACTS_DONE: u8 = 21;

/// Header bytes (tag + u32 length) before each payload.
const HEADER_LEN: usize = 1 + 4;

/// Hard cap on a single frame's payload so a corrupt/hostile length prefix
/// can't make a peer allocate unbounded memory. 8 MiB comfortably exceeds any
/// realistic output chunk (the host re-caps total output separately).
pub const MAX_FRAME_PAYLOAD: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    UnknownTag(u8),
    FrameTooLarge(usize),
    BadJson,
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtocolError::UnknownTag(t) => write!(f, "unknown frame tag {t}"),
            ProtocolError::FrameTooLarge(n) => write!(f, "frame payload too large ({n} bytes)"),
            ProtocolError::BadJson => write!(f, "malformed JSON frame payload"),
        }
    }
}
impl std::error::Error for ProtocolError {}

/// Encode a frame to its wire bytes.
pub fn encode(frame: &Frame) -> Vec<u8> {
    let (tag, payload): (u8, Vec<u8>) = match frame {
        Frame::Exec(req) => (TAG_EXEC, serde_json::to_vec(req).expect("ExecRequest serializes")),
        Frame::Stdout(b) => (TAG_STDOUT, b.clone()),
        Frame::Stderr(b) => (TAG_STDERR, b.clone()),
        Frame::Exit(s) => (TAG_EXIT, serde_json::to_vec(s).expect("ExitStatus serializes")),
        Frame::Progress(b) => (TAG_PROGRESS, b.clone()),
        Frame::ArtifactChunk {
            mount_index,
            rel_path,
            offset,
            data,
        } => {
            let mut payload = encode_artifact_entry(*mount_index, rel_path, &offset.to_be_bytes());
            payload.extend_from_slice(data);
            (TAG_ARTIFACT_CHUNK, payload)
        }
        Frame::ArtifactSkipped {
            mount_index,
            rel_path,
            reason,
        } => (
            TAG_ARTIFACT_SKIPPED,
            encode_artifact_entry(*mount_index, rel_path, reason.as_bytes()),
        ),
        Frame::ArtifactDir {
            mount_index,
            rel_path,
        } => (TAG_ARTIFACT_DIR, encode_artifact_entry(*mount_index, rel_path, &[])),
        Frame::ArtifactSymlink {
            mount_index,
            rel_path,
            target,
        } => (
            TAG_ARTIFACT_SYMLINK,
            encode_artifact_entry(*mount_index, rel_path, target.as_bytes()),
        ),
        Frame::ArtifactsDone => (TAG_ARTIFACTS_DONE, Vec::new()),
    };
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.push(tag);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&payload);
    out
}

/// Pack `[u32 BE mount_index][u32 BE rel_path_len][rel_path utf8][data]`, the
/// shared head of every artifact frame.
fn encode_artifact_entry(mount_index: u32, rel_path: &str, data: &[u8]) -> Vec<u8> {
    let rel = rel_path.as_bytes();
    let mut payload = Vec::with_capacity(8 + rel.len() + data.len());
    payload.extend_from_slice(&mount_index.to_be_bytes());
    payload.extend_from_slice(&(rel.len() as u32).to_be_bytes());
    payload.extend_from_slice(rel);
    payload.extend_from_slice(data);
    payload
}

/// Inverse of [`encode_artifact_entry`]. Returns `BadJson` on a truncated /
/// malformed payload (re-using the existing payload-shape error).
fn decode_artifact_entry(payload: &[u8]) -> Result<(u32, String, Vec<u8>), ProtocolError> {
    if payload.len() < 8 {
        return Err(ProtocolError::BadJson);
    }
    let mount_index = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let rel_len = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]) as usize;
    let rel_start: usize = 8;
    let rel_end = rel_start
        .checked_add(rel_len)
        .ok_or(ProtocolError::BadJson)?;
    if payload.len() < rel_end {
        return Err(ProtocolError::BadJson);
    }
    let rel_path =
        String::from_utf8(payload[rel_start..rel_end].to_vec()).map_err(|_| ProtocolError::BadJson)?;
    let data = payload[rel_end..].to_vec();
    Ok((mount_index, rel_path, data))
}

/// Incremental frame decoder: feed it bytes as they arrive on the socket and
/// pull complete frames out. Holds a buffer of not-yet-consumed bytes.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Append freshly-read bytes.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Pop the next complete frame, if one is fully buffered. Returns
    /// `Ok(None)` when more bytes are needed.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, ProtocolError> {
        if self.buf.len() < HEADER_LEN {
            return Ok(None);
        }
        let tag = self.buf[0];
        let len = u32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
        if len > MAX_FRAME_PAYLOAD {
            return Err(ProtocolError::FrameTooLarge(len));
        }
        if self.buf.len() < HEADER_LEN + len {
            return Ok(None); // payload not fully arrived yet
        }
        let payload = self.buf[HEADER_LEN..HEADER_LEN + len].to_vec();
        // Drop the consumed header + payload.
        self.buf.drain(..HEADER_LEN + len);

        let frame = match tag {
            TAG_EXEC => Frame::Exec(
                serde_json::from_slice(&payload).map_err(|_| ProtocolError::BadJson)?,
            ),
            TAG_STDOUT => Frame::Stdout(payload),
            TAG_STDERR => Frame::Stderr(payload),
            TAG_EXIT => {
                Frame::Exit(serde_json::from_slice(&payload).map_err(|_| ProtocolError::BadJson)?)
            }
            TAG_PROGRESS => Frame::Progress(payload),
            TAG_ARTIFACT_CHUNK => {
                let (mount_index, rel_path, rest) = decode_artifact_entry(&payload)?;
                if rest.len() < 8 {
                    return Err(ProtocolError::BadJson);
                }
                let mut off = [0u8; 8];
                off.copy_from_slice(&rest[..8]);
                Frame::ArtifactChunk {
                    mount_index,
                    rel_path,
                    offset: u64::from_be_bytes(off),
                    data: rest[8..].to_vec(),
                }
            }
            TAG_ARTIFACT_SKIPPED => {
                let (mount_index, rel_path, rest) = decode_artifact_entry(&payload)?;
                Frame::ArtifactSkipped {
                    mount_index,
                    rel_path,
                    reason: String::from_utf8_lossy(&rest).into_owned(),
                }
            }
            TAG_ARTIFACT_DIR => {
                let (mount_index, rel_path, rest) = decode_artifact_entry(&payload)?;
                if !rest.is_empty() {
                    return Err(ProtocolError::BadJson);
                }
                Frame::ArtifactDir { mount_index, rel_path }
            }
            TAG_ARTIFACT_SYMLINK => {
                let (mount_index, rel_path, rest) = decode_artifact_entry(&payload)?;
                Frame::ArtifactSymlink {
                    mount_index,
                    rel_path,
                    target: String::from_utf8(rest).map_err(|_| ProtocolError::BadJson)?,
                }
            }
            TAG_ARTIFACTS_DONE => Frame::ArtifactsDone,
            other => return Err(ProtocolError::UnknownTag(other)),
        };
        Ok(Some(frame))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_exec() -> Frame {
        Frame::Exec(ExecRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: 42,
            bwrap_path: "/usr/bin/bwrap".to_string(),
            argv: vec!["--clearenv".into(), "--".into(), "/bin/bash".into(), "-lc".into(), "echo hi".into()],
            timeout_ms: 600_000,
            seccomp_fd: Some(10),
            cgroup: Some(CgroupLimits {
                memory_max_bytes: 512 * 1024 * 1024,
                memory_swap_max_bytes: 0,
                pids_max: 256,
                cpu_max: "100000 100000".into(),
            }),
            progress: true,
            collect_artifacts: vec!["/artifacts-out/0".into()],
            artifacts: ArtifactOptions {
                tmpfs_size: Some("2048m".into()),
                tmpfs_root: Some("/tmp/out".into()),
                scratch_dirs: vec!["/tmp/out/home".into()],
                total_cap_bytes: 1 << 30,
            },
        })
    }

    #[test]
    fn the_agent_serves_only_its_own_version() {
        let with = |v: u32| ExecRequest {
            protocol_version: v,
            request_id: 1,
            bwrap_path: "/x".into(),
            argv: vec![],
            timeout_ms: 1,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: vec![],
            artifacts: ArtifactOptions::default(),
        };
        assert!(with(PROTOCOL_VERSION).check_version().is_ok());
        // A missing version (0), an earlier one (whose agents read the request
        // as asking for the old write-back) and a newer one are refused.
        for v in [0, 1, 2, PROTOCOL_VERSION + 1] {
            let err = with(v).check_version().unwrap_err();
            assert!(err.contains(&format!("peer={v}")), "{err}");
        }
    }

    #[test]
    fn exec_request_without_artifact_options_gets_the_defaults() {
        let json = r#"{"protocol_version":3,"request_id":1,"bwrap_path":"/x","argv":[],"timeout_ms":1}"#;
        let req: ExecRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.artifacts, ArtifactOptions::default());
        assert!(req.artifacts.tmpfs_size.is_none() && req.artifacts.tmpfs_root.is_none());
        assert!(req.artifacts.scratch_dirs.is_empty() && req.artifacts.total_cap_bytes == 0);
    }

    #[test]
    fn roundtrips_every_frame() {
        for frame in [
            sample_exec(),
            Frame::Stdout(b"hello world".to_vec()),
            Frame::Stderr(vec![0, 1, 2, 255, 254]),
            Frame::Exit(ExitStatus { code: 0, timed_out: false }),
            Frame::Exit(ExitStatus { code: -1, timed_out: true }),
            Frame::Progress(b"fit|0.42|epoch 4".to_vec()),
            Frame::Progress(Vec::new()),
            Frame::ArtifactChunk {
                mount_index: 2,
                rel_path: "model/model.rds".into(),
                offset: (ARTIFACT_CHUNK_BYTES as u64) * 3,
                data: vec![9, 8, 7],
            },
            Frame::ArtifactChunk {
                mount_index: 0,
                rel_path: "empty.csv".into(),
                offset: 0,
                data: Vec::new(),
            },
            Frame::ArtifactSkipped {
                mount_index: 1,
                rel_path: "big.bin".into(),
                reason: "over the total artifact cap".into(),
            },
            Frame::ArtifactDir {
                mount_index: 2,
                rel_path: "checkpoints/empty".into(),
            },
            Frame::ArtifactSymlink {
                mount_index: 0,
                rel_path: "latest.csv".into(),
                target: "/output/pred.csv".into(),
            },
            Frame::ArtifactsDone,
        ] {
            let mut d = Decoder::new();
            d.feed(&encode(&frame));
            let decoded = d.next_frame().unwrap().expect("a full frame");
            assert_eq!(decoded, frame);
            assert!(d.next_frame().unwrap().is_none(), "no trailing frame");
        }
    }

    #[test]
    fn decodes_multiple_frames_from_one_buffer() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&encode(&Frame::Stdout(b"a".to_vec())));
        bytes.extend_from_slice(&encode(&Frame::Stderr(b"b".to_vec())));
        bytes.extend_from_slice(&encode(&Frame::Exit(ExitStatus { code: 7, timed_out: false })));
        bytes.extend_from_slice(&encode(&Frame::ArtifactsDone));

        let mut d = Decoder::new();
        d.feed(&bytes);
        assert_eq!(d.next_frame().unwrap(), Some(Frame::Stdout(b"a".to_vec())));
        assert_eq!(d.next_frame().unwrap(), Some(Frame::Stderr(b"b".to_vec())));
        assert_eq!(d.next_frame().unwrap(), Some(Frame::Exit(ExitStatus { code: 7, timed_out: false })));
        assert_eq!(d.next_frame().unwrap(), Some(Frame::ArtifactsDone));
        assert_eq!(d.next_frame().unwrap(), None);
    }

    #[test]
    fn handles_partial_then_completed_frame() {
        let full = encode(&Frame::Stdout(b"chunky".to_vec()));
        let (head, tail) = full.split_at(3); // split mid-header/payload
        let mut d = Decoder::new();
        d.feed(head);
        assert_eq!(d.next_frame().unwrap(), None, "incomplete → None");
        d.feed(tail);
        assert_eq!(d.next_frame().unwrap(), Some(Frame::Stdout(b"chunky".to_vec())));
    }

    #[test]
    fn rejects_oversized_frame() {
        // Craft a header claiming a payload bigger than the cap.
        let mut bytes = vec![TAG_STDOUT];
        bytes.extend_from_slice(&((MAX_FRAME_PAYLOAD as u32) + 1).to_be_bytes());
        let mut d = Decoder::new();
        d.feed(&bytes);
        assert_eq!(d.next_frame(), Err(ProtocolError::FrameTooLarge(MAX_FRAME_PAYLOAD + 1)));
    }

    #[test]
    fn rejects_unknown_tags_including_the_retired_ones() {
        // 5..=15 belonged to frames of earlier versions; an old peer's frame
        // must not decode as anything.
        for tag in [5u8, 6, 9, 13, 15, 99] {
            let mut bytes = vec![tag];
            bytes.extend_from_slice(&0u32.to_be_bytes());
            let mut d = Decoder::new();
            d.feed(&bytes);
            assert_eq!(d.next_frame(), Err(ProtocolError::UnknownTag(tag)));
        }
    }

    #[test]
    fn progress_payload_is_the_line_itself() {
        // No prefix: the payload is the line's bytes.
        let wire = encode(&Frame::Progress(vec![0xAA, 0xBB]));
        assert_eq!(wire, vec![TAG_PROGRESS, 0, 0, 0, 2, 0xAA, 0xBB]);
    }

    #[test]
    fn artifact_entry_byte_layout_is_index_len_path_data() {
        // [u32 mount_index][u32 rel_path_len][rel_path][target]
        let frame = Frame::ArtifactSymlink {
            mount_index: 0x0102_0304,
            rel_path: "a/b".into(),
            target: "cd".into(),
        };
        let wire = encode(&frame);
        // tag(1) + len(4) + index(4) + pathlen(4) + path(3) + target(2) = 18
        assert_eq!(wire.len(), 1 + 4 + 4 + 4 + 3 + 2);
        assert_eq!(wire[0], TAG_ARTIFACT_SYMLINK);
        assert_eq!(&wire[1..5], &((4 + 4 + 3 + 2) as u32).to_be_bytes()); // payload len = 13
        assert_eq!(&wire[5..9], &0x0102_0304u32.to_be_bytes()); // mount_index
        assert_eq!(&wire[9..13], &3u32.to_be_bytes()); // rel_path_len
        assert_eq!(&wire[13..16], b"a/b");
        assert_eq!(&wire[16..], b"cd");
    }

    fn frame_bytes(tag: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![tag];
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn rejects_artifact_frames_shorter_than_their_header() {
        // A 3-byte payload (< the 8-byte index+len header) → reject, not panic.
        for tag in [TAG_ARTIFACT_CHUNK, TAG_ARTIFACT_SKIPPED, TAG_ARTIFACT_DIR, TAG_ARTIFACT_SYMLINK] {
            let mut d = Decoder::new();
            d.feed(&frame_bytes(tag, &[0, 1, 2]));
            assert_eq!(d.next_frame(), Err(ProtocolError::BadJson), "tag {tag}");
        }
    }

    #[test]
    fn rejects_an_artifact_frame_with_a_truncated_rel_path() {
        // rel_path_len claims 100 bytes but the payload only has 2 after
        // the header → reject.
        let mut payload = Vec::new();
        payload.extend_from_slice(&0u32.to_be_bytes()); // mount_index
        payload.extend_from_slice(&100u32.to_be_bytes()); // rel_path_len (lie)
        payload.extend_from_slice(b"ab"); // only 2 bytes
        let mut d = Decoder::new();
        d.feed(&frame_bytes(TAG_ARTIFACT_CHUNK, &payload));
        assert_eq!(d.next_frame(), Err(ProtocolError::BadJson));
    }

    #[test]
    fn rejects_a_chunk_without_its_offset_and_a_dir_with_trailing_bytes() {
        let head = encode_artifact_entry(0, "f", &[1, 2, 3]); // 3 bytes, not an 8-byte offset
        let mut d = Decoder::new();
        d.feed(&frame_bytes(TAG_ARTIFACT_CHUNK, &head));
        assert_eq!(d.next_frame(), Err(ProtocolError::BadJson));
        let mut d = Decoder::new();
        d.feed(&frame_bytes(TAG_ARTIFACT_DIR, &head));
        assert_eq!(d.next_frame(), Err(ProtocolError::BadJson));
    }

    #[test]
    fn tags_are_distinct() {
        // The decoder matches on the u8 tag, so a duplicate would silently
        // miscategorize frames.
        let tags = [
            TAG_EXEC, TAG_STDOUT, TAG_STDERR, TAG_EXIT, TAG_PROGRESS, TAG_ARTIFACT_CHUNK,
            TAG_ARTIFACT_SKIPPED, TAG_ARTIFACT_DIR, TAG_ARTIFACT_SYMLINK, TAG_ARTIFACTS_DONE,
        ];
        let mut seen = std::collections::HashSet::new();
        for t in tags {
            assert!(seen.insert(t), "tag {t} appears twice");
        }
    }

    #[test]
    fn protocol_error_display_messages() {
        assert_eq!(
            ProtocolError::UnknownTag(99).to_string(),
            "unknown frame tag 99"
        );
        assert_eq!(
            ProtocolError::FrameTooLarge(1234).to_string(),
            "frame payload too large (1234 bytes)"
        );
        assert_eq!(
            ProtocolError::BadJson.to_string(),
            "malformed JSON frame payload"
        );
    }

    #[test]
    fn exec_request_roundtrips_through_json_with_defaulted_optionals() {
        // A minimal ExecRequest omitting every `#[serde(default)]` optional
        // must deserialize with the documented defaults.
        let json = serde_json::json!({
            "protocol_version": PROTOCOL_VERSION,
            "request_id": 5,
            "bwrap_path": "/usr/bin/bwrap",
            "argv": ["--version"],
            "timeout_ms": 1000,
        });
        let req: ExecRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.seccomp_fd, None);
        assert_eq!(req.cgroup, None);
        assert!(!req.progress);
        assert!(req.collect_artifacts.is_empty());
    }

    #[test]
    fn legacy_exec_request_decodes_with_version_zero() {
        // A peer that predates PROTOCOL_VERSION sends an ExecRequest with no
        // `protocol_version` field. With `#[serde(default)]` this deserializes
        // to 0 (≠ PROTOCOL_VERSION) so the agent can reject it loudly.
        let legacy_json = serde_json::json!({
            "request_id": 1,
            "bwrap_path": "/usr/bin/bwrap",
            "argv": [],
            "timeout_ms": 0,
        });
        let payload = serde_json::to_vec(&legacy_json).unwrap();
        let mut d = Decoder::new();
        d.feed(&frame_bytes(TAG_EXEC, &payload));
        let frame = d.next_frame().unwrap().expect("legacy ExecRequest decodes");
        match frame {
            Frame::Exec(req) => {
                assert_eq!(req.protocol_version, 0);
                assert!(req.check_version().is_err());
            }
            _ => panic!("expected Exec"),
        }
    }
}
