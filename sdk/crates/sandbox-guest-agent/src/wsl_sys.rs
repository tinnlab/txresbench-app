//! WSL mode's system calls (Linux): the private mount namespace, the mounts
//! of the plan in `wsl_mode.rs`, the squashfuse children, and moving the
//! protocol stream off stdin/stdout.
//!
//! Everything here runs on the main thread before the tokio runtime starts:
//! `unshare(CLONE_NEWNS)` moves only the calling thread into the new
//! namespace, so the agent must still be single-threaded then (checked).

use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::wsl_mode::{MountOps, Source};

/// squashfuse in the guest root (Alpine's package): a fixed path, never PATH.
pub const SQUASHFUSE_PATH: &str = "/usr/bin/squashfuse";
/// How long squashfuse may take to mount an image.
const SQUASHFUSE_READY_TIMEOUT: Duration = Duration::from_secs(15);
/// A free loop device can be taken by another process between
/// `LOOP_CTL_GET_FREE` and `LOOP_CONFIGURE` (two runs starting at once).
const LOOP_ATTACH_TRIES: usize = 8;

// <linux/loop.h>
const LOOP_CTL_GET_FREE: u32 = 0x4C82;
const LOOP_CONFIGURE: u32 = 0x4C0A;
const LO_FLAGS_READ_ONLY: u32 = 1;
const LO_FLAGS_AUTOCLEAR: u32 = 4;
const LO_NAME_SIZE: usize = 64;
const LO_KEY_SIZE: usize = 32;

/// `struct loop_info64`.
#[repr(C)]
struct LoopInfo64 {
    lo_device: u64,
    lo_inode: u64,
    lo_rdevice: u64,
    lo_offset: u64,
    lo_sizelimit: u64,
    lo_number: u32,
    lo_encrypt_type: u32,
    lo_encrypt_key_size: u32,
    lo_flags: u32,
    lo_file_name: [u8; LO_NAME_SIZE],
    lo_crypt_name: [u8; LO_NAME_SIZE],
    lo_encrypt_key: [u8; LO_KEY_SIZE],
    lo_init: [u64; 2],
}

/// `struct loop_config` (`LOOP_CONFIGURE`, Linux 5.8+).
#[repr(C)]
struct LoopConfig {
    fd: u32,
    block_size: u32,
    info: LoopInfo64,
    reserved: [u64; 8],
}

impl LoopConfig {
    /// A read-only loop device over `fd` that detaches itself when its last
    /// user (the mount) goes away.
    fn read_only_autoclear(fd: u32, name: &[u8]) -> Self {
        let mut file_name = [0u8; LO_NAME_SIZE];
        let n = name.len().min(LO_NAME_SIZE - 1);
        file_name[..n].copy_from_slice(&name[..n]);
        LoopConfig {
            fd,
            block_size: 0,
            info: LoopInfo64 {
                lo_device: 0,
                lo_inode: 0,
                lo_rdevice: 0,
                lo_offset: 0,
                lo_sizelimit: 0,
                lo_number: 0,
                lo_encrypt_type: 0,
                lo_encrypt_key_size: 0,
                lo_flags: LO_FLAGS_READ_ONLY | LO_FLAGS_AUTOCLEAR,
                lo_file_name: file_name,
                lo_crypt_name: [0; LO_NAME_SIZE],
                lo_encrypt_key: [0; LO_KEY_SIZE],
                lo_init: [0; 2],
            },
            reserved: [0; 8],
        }
    }
}

/// The real [`MountOps`]. Holds the opened paths for the whole run and the
/// squashfuse children, which [`RealOps::stop_squashfuse`] (or drop) ends.
#[derive(Default)]
pub struct RealOps {
    opened: HashMap<Source, OwnedFd>,
    fuse: Vec<FuseMount>,
}

struct FuseMount {
    target: PathBuf,
    child: Child,
}

impl RealOps {
    fn fd(&self, source: Source) -> Result<&OwnedFd, String> {
        self.opened
            .get(&source)
            .ok_or_else(|| format!("{source:?} was not opened"))
    }

    /// Unmount each squashfuse mount and end its process. The mounts would go
    /// with the namespace anyway; the processes would not (they are in it).
    pub fn stop_squashfuse(&mut self) {
        for mut m in self.fuse.drain(..).rev() {
            let _ = umount_detach(&m.target);
            let _ = m.child.kill();
            let _ = m.child.wait();
        }
    }
}

impl Drop for RealOps {
    fn drop(&mut self) {
        self.stop_squashfuse();
    }
}

impl MountOps for RealOps {
    fn private_namespace(&mut self) -> Result<(), String> {
        let threads = std::fs::read_dir("/proc/self/task")
            .map_err(|e| format!("reading /proc/self/task: {e}"))?
            .count();
        if threads != 1 {
            return Err(format!(
                "the agent already runs {threads} threads; unshare would move only one of them"
            ));
        }
        // SAFETY: plain syscall, no pointers.
        if unsafe { libc::unshare(libc::CLONE_NEWNS) } != 0 {
            return Err(format!("unshare(CLONE_NEWNS): {}", io::Error::last_os_error()));
        }
        // Nothing mounted from here on propagates to the distro.
        mount(None, Path::new("/"), None, libc::MS_REC | libc::MS_PRIVATE, None)
            .map_err(|e| format!("making / private: {e}"))
    }

    fn open(&mut self, source: Source, path: &Path) -> Result<(), String> {
        // O_PATH first: it never blocks (a FIFO) and lets the type be checked
        // before anything reads the file.
        let handle = File::from(open_o_path(path).map_err(|e| e.to_string())?);
        let md = handle.metadata().map_err(|e| e.to_string())?;
        let fd = match source {
            Source::Base | Source::Layer => {
                if !md.is_file() {
                    return Err("not a regular file".into());
                }
                // The loop device needs a readable fd: reopen this same file.
                OwnedFd::from(File::open(fd_path(&handle)).map_err(|e| e.to_string())?)
            }
            Source::Ro(_) => {
                if !md.is_dir() && !md.is_file() {
                    return Err("not a directory or a regular file".into());
                }
                OwnedFd::from(handle)
            }
        };
        self.opened.insert(source, fd);
        Ok(())
    }

    fn tmpfs(&mut self, target: &Path, options: &str) -> Result<(), String> {
        require_dir(target)?;
        mount(
            Some("tmpfs"),
            target,
            Some("tmpfs"),
            libc::MS_NOSUID | libc::MS_NODEV,
            Some(options),
        )
    }

    fn squashfs_kernel(&mut self, source: Source, target: &Path) -> Result<(), String> {
        require_dir(target)?;
        let image = self.fd(source)?;
        let name = std::fs::read_link(fd_path(image)).unwrap_or_default();
        let (device, device_path) = attach_loop(image, name.as_os_str().as_bytes())?;
        let mounted = mount(
            Some(&device_path),
            target,
            Some("squashfs"),
            libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV,
            None,
        );
        // Closing our fd leaves the mount as the device's only user; with
        // autoclear the kernel detaches it when that goes (or right now, if
        // the mount failed).
        drop(device);
        mounted.map_err(|e| format!("mounting {device_path}: {e}"))
    }

    fn squashfuse(&mut self, source: Source, target: &Path) -> Result<(), String> {
        require_dir(target)?;
        if !Path::new(SQUASHFUSE_PATH).is_file() {
            return Err(format!("{SQUASHFUSE_PATH} is not installed"));
        }
        let image = self.fd(source)?;
        // squashfuse opens the image the agent already opened (the caller's
        // path may now be covered by one of the agent's own mounts).
        let image_path = format!("/proc/{}/fd/{}", std::process::id(), image.as_raw_fd());
        let before = mount_ids_at(target)?;
        let parent = std::process::id() as libc::pid_t;
        let stdout = io::stderr().as_fd().try_clone_to_owned().map_err(|e| e.to_string())?;
        let mut cmd = Command::new(SQUASHFUSE_PATH);
        cmd.args(["-f", "-o", "ro,allow_other"])
            .arg(&image_path)
            .arg(target)
            .stdin(Stdio::null())
            // Never the protocol stream.
            .stdout(Stdio::from(stdout));
        // SAFETY: prctl/getppid are async-signal-safe.
        unsafe {
            cmd.pre_exec(move || {
                // It runs only as long as the agent: if the agent is killed,
                // squashfuse dies too and the namespace (with its mounts) goes.
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(io::Error::other("the agent exited"));
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().map_err(|e| format!("starting {SQUASHFUSE_PATH}: {e}"))?;
        let deadline = Instant::now() + SQUASHFUSE_READY_TIMEOUT;
        let failed = loop {
            match fuse_mounted_at(target, &before) {
                Ok(true) => break None,
                Ok(false) => {}
                Err(e) => break Some(e),
            }
            match child.try_wait() {
                Ok(Some(status)) => break Some(format!("squashfuse exited ({status}) without mounting")),
                Ok(None) => {}
                Err(e) => break Some(format!("waiting for squashfuse: {e}")),
            }
            if Instant::now() >= deadline {
                break Some(format!(
                    "squashfuse did not mount within {}s",
                    SQUASHFUSE_READY_TIMEOUT.as_secs()
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if let Some(why) = failed {
            let _ = umount_detach(target);
            let _ = child.kill();
            let _ = child.wait();
            return Err(why);
        }
        self.fuse.push(FuseMount {
            target: target.to_path_buf(),
            child,
        });
        Ok(())
    }

    fn bind_ro(&mut self, source: Source, target: &Path) -> Result<(), String> {
        let fd = self.fd(source)?;
        let is_dir = File::from(fd.try_clone().map_err(|e| e.to_string())?)
            .metadata()
            .map_err(|e| e.to_string())?
            .is_dir();
        let created = if is_dir {
            std::fs::create_dir(target)
        } else {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o444)
                .open(target)
                .map(drop)
        };
        created.map_err(|e| format!("creating the mount point: {e}"))?;
        let src = fd_path(fd);
        mount(Some(&src), target, None, libc::MS_BIND, None)?;
        let ro = libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV;
        if let Err(e) = mount(None, target, None, ro, None) {
            // Never leave a writable bind of the caller's path behind.
            let _ = umount_detach(target);
            return Err(format!("making the bind read-only: {e}"));
        }
        Ok(())
    }
}

/// The protocol stream, moved off fds 0 and 1.
pub struct ProtocolStdio {
    pub input: OwnedFd,
    pub output: OwnedFd,
}

/// Take stdin/stdout for the protocol: keep them on close-on-exec fds and
/// point fd 0 at /dev/null and fd 1 at stderr, so no child (squashfuse, bwrap)
/// and no stray print can read frames or write into the stream. The stream is
/// read and written with blocking calls, so it is made blocking if it came
/// non-blocking.
pub fn take_protocol_stdio() -> io::Result<ProtocolStdio> {
    let input = io::stdin().as_fd().try_clone_to_owned()?;
    let output = io::stdout().as_fd().try_clone_to_owned()?;
    set_blocking(&input)?;
    set_blocking(&output)?;
    let null = File::open("/dev/null")?;
    // SAFETY: dup2 on fds this process owns.
    if unsafe { libc::dup2(null.as_raw_fd(), 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let to_stdout = if unsafe { libc::fcntl(2, libc::F_GETFD) } >= 0 {
        2
    } else {
        null.as_raw_fd()
    };
    if unsafe { libc::dup2(to_stdout, 1) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(ProtocolStdio { input, output })
}

/// `open(path, O_PATH | O_CLOEXEC)`. Not through `OpenOptions`: std masks
/// custom flags with `O_ACCMODE`, which on musl includes `O_PATH`, so the
/// open would silently become a read open (and block on a FIFO).
fn open_o_path(path: &Path) -> io::Result<OwnedFd> {
    let c = CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: a valid CString; the returned fd is owned below.
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` was just opened and is owned by nothing else.
    Ok(unsafe { <OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fd) })
}

/// Clear `O_NONBLOCK` on an fd's open file description.
fn set_blocking(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: fcntl on an fd this process owns.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0
        && unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// `/proc/self/fd/<n>`: the file behind an open fd.
fn fd_path(fd: &impl AsRawFd) -> String {
    format!("/proc/self/fd/{}", fd.as_raw_fd())
}

fn require_dir(target: &Path) -> Result<(), String> {
    match std::fs::metadata(target) {
        Ok(md) if md.is_dir() => Ok(()),
        Ok(_) => Err(format!("the mount point {} is not a directory", target.display())),
        Err(e) => Err(format!("the mount point {} is missing ({e})", target.display())),
    }
}

/// Attach `image` to a free loop device, read-only with autoclear. Returns
/// the open device and its path.
fn attach_loop(image: &OwnedFd, name: &[u8]) -> Result<(File, String), String> {
    let ctl = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/loop-control")
        .map_err(|e| format!("/dev/loop-control: {e}"))?;
    let config = LoopConfig::read_only_autoclear(image.as_raw_fd() as u32, name);
    let mut last = String::new();
    for _ in 0..LOOP_ATTACH_TRIES {
        // SAFETY: an ioctl without an argument on an open fd.
        let n = unsafe { libc::ioctl(ctl.as_raw_fd(), LOOP_CTL_GET_FREE as _) };
        if n < 0 {
            return Err(format!("LOOP_CTL_GET_FREE: {}", io::Error::last_os_error()));
        }
        let path = format!("/dev/loop{n}");
        let device = File::open(&path).map_err(|e| format!("{path}: {e}"))?;
        // SAFETY: `config` is a valid `struct loop_config` for the call.
        let rc = unsafe { libc::ioctl(device.as_raw_fd(), LOOP_CONFIGURE as _, &config as *const LoopConfig) };
        if rc == 0 {
            return Ok((device, path));
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EBUSY) {
            return Err(format!("LOOP_CONFIGURE {path}: {err}"));
        }
        // Taken by someone else since GET_FREE: ask again.
        last = format!("{path}: {err}");
    }
    Err(format!(
        "no free loop device after {LOOP_ATTACH_TRIES} tries (last: {last})"
    ))
}

fn mount(
    src: Option<&str>,
    target: &Path,
    fstype: Option<&str>,
    flags: libc::c_ulong,
    data: Option<&str>,
) -> Result<(), String> {
    let cstr = |s: &str| CString::new(s).map_err(|_| format!("{s:?} contains a NUL byte"));
    let c_src = src.map(cstr).transpose()?;
    let c_target =
        CString::new(target.as_os_str().as_bytes()).map_err(|_| format!("{} contains a NUL byte", target.display()))?;
    let c_fs = fstype.map(cstr).transpose()?;
    let c_data = data.map(cstr).transpose()?;
    let ptr = |c: &Option<CString>| c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
    // SAFETY: every pointer is null or a CString alive for the call.
    let rc = unsafe {
        libc::mount(
            ptr(&c_src),
            c_target.as_ptr(),
            ptr(&c_fs),
            flags,
            ptr(&c_data) as *const libc::c_void,
        )
    };
    if rc != 0 {
        return Err(format!("mount: {}", io::Error::last_os_error()));
    }
    Ok(())
}

fn umount_detach(target: &Path) -> io::Result<()> {
    let c = CString::new(target.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: a valid CString for the call.
    if unsafe { libc::umount2(c.as_ptr(), libc::MNT_DETACH) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The mounts at `target` in this namespace: (mount id, fs type).
fn mounts_at(target: &Path) -> Result<Vec<(u64, String)>, String> {
    let text = std::fs::read_to_string("/proc/self/mountinfo").map_err(|e| format!("/proc/self/mountinfo: {e}"))?;
    Ok(parse_mounts_at(&text, target))
}

fn mount_ids_at(target: &Path) -> Result<Vec<u64>, String> {
    Ok(mounts_at(target)?.into_iter().map(|(id, _)| id).collect())
}

/// Whether a FUSE mount that was not there before now sits on `target`.
fn fuse_mounted_at(target: &Path, before: &[u64]) -> Result<bool, String> {
    Ok(mounts_at(target)?
        .iter()
        .any(|(id, fstype)| !before.contains(id) && (fstype == "fuse" || fstype.starts_with("fuse."))))
}

/// `/proc/<pid>/mountinfo` lines: `id parent major:minor root mount-point
/// options [optional...] - fstype source super-options`, with space, tab,
/// newline and backslash in paths written as `\ooo`.
fn parse_mounts_at(mountinfo: &str, target: &Path) -> Vec<(u64, String)> {
    let mut want = String::new();
    for &b in target.as_os_str().as_bytes() {
        match b {
            b' ' | b'\t' | b'\n' | b'\\' => want.push_str(&format!("\\{b:03o}")),
            _ => want.push(b as char),
        }
    }
    mountinfo
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(' ');
            let id = fields.next()?.parse().ok()?;
            let point = fields.nth(3)?;
            let fstype = line.split(" - ").nth(1)?.split(' ').next()?;
            (point == want).then(|| (id, fstype.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_structs_match_the_kernel_layout() {
        assert_eq!(std::mem::size_of::<LoopInfo64>(), 232);
        assert_eq!(std::mem::size_of::<LoopConfig>(), 304);
        let c = LoopConfig::read_only_autoclear(7, &[b'x'; 100]);
        assert_eq!(c.fd, 7);
        assert_eq!(c.info.lo_flags, LO_FLAGS_READ_ONLY | LO_FLAGS_AUTOCLEAR);
        // The name is cut to fit and stays NUL-terminated.
        assert_eq!(c.info.lo_file_name[LO_NAME_SIZE - 2], b'x');
        assert_eq!(c.info.lo_file_name[LO_NAME_SIZE - 1], 0);
    }

    #[test]
    fn mountinfo_lines_are_matched_on_the_escaped_mount_point() {
        let text = "\
22 1 0:21 / /proc rw,nosuid shared:5 - proc proc rw
101 90 7:3 / /sandbox-rootfs ro,nosuid,nodev - squashfs /dev/loop3 ro
102 90 0:55 / /sandbox-layer ro,nosuid,nodev - fuse.squashfuse squashfuse ro,user_id=0
103 90 0:56 / /host-mounts/with\\040space rw - tmpfs tmpfs rw
104 101 0:57 / /sandbox-rootfs rw shared:9 master:2 - fuse squashfuse rw
";
        assert_eq!(
            parse_mounts_at(text, Path::new("/sandbox-rootfs")),
            vec![(101, "squashfs".to_string()), (104, "fuse".to_string())]
        );
        assert_eq!(
            parse_mounts_at(text, Path::new("/host-mounts/with space")),
            vec![(103, "tmpfs".to_string())]
        );
        assert!(parse_mounts_at(text, Path::new("/sandbox")).is_empty());
    }

    #[test]
    fn open_checks_the_kind_of_each_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("image.sqfs");
        std::fs::write(&file, b"not really squashfs").unwrap();
        let mut ops = RealOps::default();
        assert_eq!(
            ops.open(Source::Base, dir.path()),
            Err("not a regular file".to_string())
        );
        ops.open(Source::Base, &file).expect("a regular file is an image");
        ops.open(Source::Ro(0), dir.path()).expect("a dir can be bound");
        ops.open(Source::Ro(1), &file).expect("a file can be bound");
        let missing = ops
            .open(Source::Layer, &dir.path().join("missing"))
            .expect_err("missing");
        assert!(missing.contains("No such file"), "{missing}");
        // A FIFO is refused without blocking on it.
        let fifo = dir.path().join("fifo");
        let c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert_eq!(ops.open(Source::Layer, &fifo), Err("not a regular file".to_string()));
        assert_eq!(
            ops.open(Source::Ro(2), &fifo),
            Err("not a directory or a regular file".to_string())
        );
        // The image is held open readable (the loop device reads it).
        let mut buf = [0u8; 3];
        let image = File::from(ops.opened[&Source::Base].try_clone().unwrap());
        std::io::Read::read_exact(&mut &image, &mut buf).unwrap();
        assert_eq!(&buf, b"not");
    }

    #[test]
    fn a_missing_mount_point_is_reported_before_any_mount() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = require_dir(&dir.path().join("sandbox-rootfs")).expect_err("missing");
        assert!(err.contains("is missing"), "{err}");
        let file = dir.path().join("f");
        std::fs::write(&file, b"").unwrap();
        assert!(require_dir(&file).expect_err("a file").contains("not a directory"));
    }
}
