//! `file://` PowerShell-script trigger detection.
//!
//! A remote scheme whose URL is a `file://` URL pointing at a local
//! `.ps1` file is treated as a *script-trigger* scheme: refreshing it
//! executes the script (trigger-type run) instead of fetching content.
//! The run result is written back to the internal entries cache so the
//! right-hand editor can display it.
//!
//! Both the refresh path (`refresh::refresh_one_inner`) and the
//! system-hosts aggregation path (`hosts_apply::aggregate::is_on`) use
//! [`script_path_from_url`], so a script scheme can never leak its
//! output into the system hosts file, regardless of the stored
//! `as_hosts` flag.

use std::path::PathBuf;

/// Tolerated file-extension spellings (case-insensitive). PowerShell
/// scripts are the supported trigger type.
const SCRIPT_EXT: &str = "ps1";

/// Return the local file path when `url` is a `file://` URL pointing at
/// a PowerShell script (extension `.ps1`, case-insensitive); `None`
/// otherwise.
///
/// Accepts the same `file://` spellings as `refresh::read_file_url`:
/// - `file:///C:/Users/x/foo.ps1` (Windows drive path)
/// - `file:///Users/x/foo.ps1` (POSIX absolute path)
/// - `file://localhost/Users/x/foo.ps1` (explicit localhost host)
///
/// Percent-encoding (e.g. `%20` for spaces) is decoded so paths picked
/// by a file dialog or written with URL escaping still resolve.
pub fn script_path_from_url(url: &str) -> Option<PathBuf> {
    let stripped = url.strip_prefix("file://")?;
    let path_part = stripped.strip_prefix("localhost").unwrap_or(stripped);
    let decoded = percent_decode(path_part);
    let path = PathBuf::from(normalize_drive_path(&decoded));
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext == SCRIPT_EXT {
        Some(path)
    } else {
        None
    }
}

/// `file:///C:/Users/x/foo` strips to `/C:/Users/x/foo` — drop the
/// leading slash when a Windows drive letter follows, so the path is a
/// plain `C:/Users/x/foo` that every platform's file APIs and
/// PowerShell accept uniformly.
fn normalize_drive_path(p: &str) -> String {
    let bytes = p.as_bytes();
    if p.starts_with('/')
        && bytes.len() >= 3
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
    {
        p[1..].to_string()
    } else {
        p.to_string()
    }
}

/// Convenience guard: is `url` a script-trigger URL?
pub fn is_script_trigger_url(url: &str) -> bool {
    script_path_from_url(url).is_some()
}

/// Decode `%XX` escapes into bytes (lenient: malformed sequences are
/// passed through verbatim), then interpret as UTF-8 lossily.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_ps1_url_resolves_to_path() {
        let p = script_path_from_url("file:///C:/Users/Administrator/Desktop/xin/智能模式Scoop(3).ps1")
            .expect("ps1 url");
        assert_eq!(
            p.to_string_lossy(),
            r"C:/Users/Administrator/Desktop/xin/智能模式Scoop(3).ps1"
        );
        assert!(is_script_trigger_url(
            "file:///C:/Users/Administrator/Desktop/xin/智能模式Scoop(3).ps1"
        ));
    }

    #[test]
    fn posix_and_localhost_forms_resolve() {
        assert_eq!(
            script_path_from_url("file:///Users/x/run.ps1")
                .unwrap()
                .to_string_lossy(),
            "/Users/x/run.ps1"
        );
        assert_eq!(
            script_path_from_url("file://localhost/Users/x/run.ps1")
                .unwrap()
                .to_string_lossy(),
            "/Users/x/run.ps1"
        );
    }

    #[test]
    fn extension_check_is_case_insensitive() {
        assert!(is_script_trigger_url("file:///C:/x/run.PS1"));
        assert!(is_script_trigger_url("file:///C:/x/run.Ps1"));
    }

    #[test]
    fn percent_encoding_is_decoded() {
        let p = script_path_from_url("file:///C:/My%20Scripts/run.ps1").expect("encoded ps1");
        assert_eq!(p.to_string_lossy(), "C:/My Scripts/run.ps1");
    }

    #[test]
    fn non_script_urls_are_rejected() {
        assert!(script_path_from_url("file:///C:/tmp/hosts").is_none());
        assert!(script_path_from_url("file:///C:/x/run.txt").is_none());
        assert!(script_path_from_url("file:///C:/x/run.ps1.txt").is_none());
        // Extension must be trailing — a query string defeats detection.
        assert!(script_path_from_url("file:///C:/x/run.ps1?x=1").is_none());
        // http(s) URLs never trigger.
        assert!(script_path_from_url("https://example.com/x.ps1").is_none());
        assert!(script_path_from_url("http://example.com/x.ps1").is_none());
        // Not a file:// URL at all.
        assert!(script_path_from_url("C:/x/run.ps1").is_none());
    }
}