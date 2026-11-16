//! hosts 文本解码：兼容 BOM、UTF-16 与 Windows 旧编码（GBK/CP936）。
//!
//! 背景：Windows 上大量 hosts 文件由记事本等工具保存为 ANSI(GBK) 或
//! 「UTF-8 带 BOM」。直接 `from_utf8_lossy` 会把中文注释变成替换字符，
//! 用户一旦编辑保存，原文即被永久破坏。这里统一按 BOM → UTF-8 →
//! GBK 的顺序解码，并对无法识别的内容报错而不是静默损坏。
//!
//! 写入仍统一为 UTF-8：内部缓存与 entries 一直是 UTF-8，系统 hosts 的
//! 写回保持原有行为，避免改变已验收的写入链路。

use std::path::Path;

/// 解码 hosts 文本。
///
/// - UTF-8 BOM（EF BB BF）：去掉 BOM 后按 UTF-8 解码。
/// - UTF-16 LE/BE BOM：按对应端序解码。
/// - 无 BOM：先按严格 UTF-8，失败再用 GBK（CP936/GB18030 兼容）。
/// - UTF-32 / 含 NUL / 无法解码：返回错误。
pub(crate) fn decode(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(b"\xff\xfe\0\0") || bytes.starts_with(b"\0\0\xfe\xff") {
        return Err("UTF-32 hosts files are not supported".to_string());
    }
    if bytes.starts_with(b"\xff\xfe") || bytes.starts_with(b"\xfe\xff") {
        let little_endian = bytes[0] == 0xff;
        let body = &bytes[2..];
        if body.len() % 2 != 0 {
            return Err("incomplete UTF-16 hosts file".to_string());
        }
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|b| {
                if little_endian {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        return String::from_utf16(&units).map_err(|e| format!("invalid UTF-16 hosts file: {e}"));
    }

    let body = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    if body.contains(&0) {
        return Err("hosts file contains NUL bytes".to_string());
    }
    if let Ok(text) = std::str::from_utf8(body) {
        return Ok(text.to_string());
    }
    // 无 BOM 且不是合法 UTF-8：按 GBK（CP936）兜底。encoding_rs 的 GBK
    // 解码器对 GB18030 常见字节也有覆盖。
    let (text, _, had_errors) = encoding_rs::GBK.decode(body);
    if had_errors {
        return Err("hosts file is neither valid UTF-8 nor GBK".to_string());
    }
    Ok(text.into_owned())
}

/// 读取文件（带大小上限）并按 [`decode`] 解码。
pub(crate) fn read_text_file(path: &Path, max_bytes: usize) -> Result<String, String> {
    let bytes = crate::http::read_file_with_limit(path, max_bytes)?;
    decode(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_without_bom() {
        assert_eq!(decode("127.0.0.1 a.com\n".as_bytes()).unwrap(), "127.0.0.1 a.com\n");
    }

    #[test]
    fn strips_utf8_bom() {
        let mut bytes = b"\xef\xbb\xbf".to_vec();
        bytes.extend_from_slice("127.0.0.1 a.com\n".as_bytes());
        assert_eq!(decode(&bytes).unwrap(), "127.0.0.1 a.com\n");
    }

    #[test]
    fn decodes_utf16_le_with_bom() {
        let text = "127.0.0.1 中文注释\n";
        let mut bytes = b"\xff\xfe".to_vec();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode(&bytes).unwrap(), text);
    }

    #[test]
    fn decodes_utf16_be_with_bom() {
        let text = "# 注释\n";
        let mut bytes = b"\xfe\xff".to_vec();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(decode(&bytes).unwrap(), text);
    }

    #[test]
    fn decodes_gbk_without_bom() {
        // "# 公司内网" 的 GBK 字节
        let gbk = [
            0x23, 0x20, 0xB9, 0xAB, 0xCB, 0xBE, 0xC4, 0xDA, 0xCD, 0xF8, 0x0A,
        ];
        assert_eq!(decode(&gbk).unwrap(), "# 公司内网\n");
    }

    #[test]
    fn rejects_utf32_and_nul_bytes() {
        assert!(decode(b"\xff\xfe\0\0").is_err());
        assert!(decode(b"127.0.0.1\0a.com").is_err());
    }

    #[test]
    fn roundtrips_a_real_file() {
        let dir = std::env::temp_dir().join(format!(
            "swh-hosts-text-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hosts");
        std::fs::write(&path, b"# \xB9\xAB\xCB\xBE\n127.0.0.1 a.com\n").unwrap();
        let text = read_text_file(&path, 1024).unwrap();
        assert_eq!(text, "# 公司\n127.0.0.1 a.com\n");
        std::fs::remove_dir_all(dir).ok();
    }
}
