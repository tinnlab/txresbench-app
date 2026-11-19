//! Windows: reading the registry (the 64-bit view of `HKEY_LOCAL_MACHINE`),
//! for the installer's WSL check (`wsl_run::installer_status`).

/// A NUL-terminated UTF-16 string for the Windows API.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `HKLM\<key>` exists (the 64-bit view of the registry).
pub(crate) fn hklm_key_exists(key: &str) -> bool {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY,
    };
    let key = wide(key);
    let mut handle: HKEY = std::ptr::null_mut();
    // SAFETY: `key` is NUL-terminated and outlives the call; `handle` is valid
    // for writes and is closed below when the call opened it.
    let err = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, key.as_ptr(), 0, KEY_READ | KEY_WOW64_64KEY, &mut handle) };
    if err != 0 {
        return false;
    }
    // SAFETY: `handle` was opened by the successful call above.
    unsafe { RegCloseKey(handle) };
    true
}

/// A REG_DWORD value under `HKLM\<key>` (64-bit view), if there is one.
pub(crate) fn hklm_dword(key: &str, value: &str) -> Option<u32> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_SUBKEY_WOW6464KEY,
    };
    let (key, value) = (wide(key), wide(value));
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: both names are NUL-terminated and outlive the call; `data` holds
    // the `size` bytes the call may write.
    let err = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (err == 0).then_some(data)
}

/// A REG_SZ value under `HKLM\<key>` (64-bit view), if there is one.
fn hklm_string(key: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    };
    let (key, value) = (wide(key), wide(value));
    let mut buf = vec![0u16; 256];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: both names are NUL-terminated and outlive the call; `buf` holds
    // the `size` bytes the call may write.
    let err = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if err != 0 {
        return None;
    }
    let chars = (size as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..chars]);
    Some(text.trim_end_matches('\0').to_string())
}

/// A Windows service of this name is installed.
pub(crate) fn service_exists(name: &str) -> bool {
    hklm_key_exists(&format!(r"SYSTEM\CurrentControlSet\Services\{name}"))
}

/// The Windows build number (22621 = Windows 11 22H2).
pub(crate) fn windows_build() -> Option<u32> {
    hklm_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber")?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On entries every Windows 10/11 has, or never has.
    #[test]
    fn the_readers_read_this_windows() {
        assert!(hklm_key_exists(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"));
        assert!(!hklm_key_exists(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\TxrNoSuchKey"));
        assert_eq!(hklm_dword(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentMajorVersionNumber"), Some(10));
        assert_eq!(hklm_dword(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "TxrNoSuchValue"), None);
        assert!(hklm_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "TxrNoSuchValue").is_none());
        assert!(windows_build().is_some_and(|b| b >= 10240), "{:?}", windows_build());
        assert!(service_exists("RpcSs"));
        assert!(!service_exists("TxrNoSuchService"));
    }
}
