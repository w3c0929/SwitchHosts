//! Download-type notifications: OS-level notification + chat webhooks.
//!
//! Configured per remote scheme via `notify_channel` (wecom / dingtalk /
//! other) and `webhooks` (a list of URLs). Fired by the refresh scanner
//! when a fetch-only (as_hosts = false) scheme with a `save_path`
//! completes or fails:
//!
//! - WeCom / DingTalk robots receive the standard JSON "text" payload;
//! - "other" channels receive the raw message as `text/plain`;
//! - an OS notification is attempted (best-effort — on an unpackaged
//!   Windows build the toast may not display without an AUMID shortcut);
//! - a `download_done` event is emitted so the renderer can show an
//!   in-app success/error toast (throttled there).
//!
//! Webhook POSTs and OS notifications run fire-and-forget: a slow or
//! unavailable endpoint must never block the refresh scanner.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};

use crate::http;
use crate::storage::AppState;

pub const CHANNEL_WECOM: &str = "wecom";
pub const CHANNEL_DINGTALK: &str = "dingtalk";
pub const CHANNEL_OTHER: &str = "other";

pub const FORMAT_TEXT: &str = "text";
pub const FORMAT_MARKDOWN: &str = "markdown";

/// 占位符：{title} 方案标题；{result} 下载完成/下载失败；{message} 结果详情
pub const PLACEHOLDER_TITLE: &str = "{title}";
pub const PLACEHOLDER_RESULT: &str = "{result}";
pub const PLACEHOLDER_MESSAGE: &str = "{message}";

/// Resolve the final notification text. `result` is "下载完成"/"下载失败",
/// `detail` holds the failure reason (empty on success). When the user
/// configured a `notify_message` template it is used instead, with
/// placeholders substituted; an empty template falls back to the built-in
/// outcome line.
pub fn resolve_notify_message(
    node_title: &str,
    template: &str,
    result: &str,
    detail: &str,
) -> String {
    if template.trim().is_empty() {
        return if detail.is_empty() {
            result.to_string()
        } else {
            format!("{result}：{detail}")
        };
    }
    template
        .replace(PLACEHOLDER_TITLE, node_title)
        .replace(PLACEHOLDER_RESULT, result)
        .replace(PLACEHOLDER_MESSAGE, detail)
}

/// 钉钉机器人「加签」模式：把 `timestamp` 与 HMAC-SHA256 签名拼进 URL。
/// 参考 https://open.dingtalk.com/document/robots/customize-robot-security-settings
/// stringToSign = "{timestamp}\n{secret}"，sign = urlEncode(base64(hmac))，
/// 拼接到机器人 URL 上（keyword / IP 白名单模式不需要加签，可留空密钥）。
pub fn dingtalk_sign(secret: &str, now_ms: i64) -> String {
    use base64::Engine as _;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let string_to_sign = format!("{now_ms}\n{secret}");
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(string_to_sign.as_bytes());
    let digest = mac.finalize().into_bytes();
    let b64 = base64::engine::general_purpose::STANDARD.encode(digest);
    // 查询参数 URL 编码：base64 中仅 + / = 需要转义
    let encoded = b64.replace('+', "%2B").replace('/', "%2F").replace('=', "%3D");
    format!("timestamp={now_ms}&sign={encoded}")
}

pub fn dingtalk_sign_url(url: &str, secret: &str) -> String {
    if secret.trim().is_empty() {
        return url.to_string();
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    let now_ms = chrono::Utc::now().timestamp_millis();
    format!("{url}{sep}{}", dingtalk_sign(secret, now_ms))
}

/// Build the request body for a channel + format. Pure — unit-tested.
/// Returns `(content-type, bytes)`.
pub fn build_webhook_payload(
    channel: &str,
    format: &str,
    title: &str,
    message: &str,
) -> (String, Vec<u8>) {
    match channel {
        CHANNEL_WECOM => {
            if format == FORMAT_MARKDOWN {
                (
                    "application/json".to_string(),
                    json!({
                        "msgtype": "markdown",
                        "markdown": { "content": message },
                    })
                    .to_string()
                    .into_bytes(),
                )
            } else {
                text_json_payload(message)
            }
        }
        CHANNEL_DINGTALK => {
            if format == FORMAT_MARKDOWN {
                (
                    "application/json".to_string(),
                    json!({
                        "msgtype": "markdown",
                        "markdown": { "title": title, "text": message },
                    })
                    .to_string()
                    .into_bytes(),
                )
            } else {
                text_json_payload(message)
            }
        }
        _ => {
            let content_type = if format == FORMAT_MARKDOWN {
                "text/markdown; charset=utf-8"
            } else {
                "text/plain; charset=utf-8"
            };
            (content_type.to_string(), message.as_bytes().to_vec())
        }
    }
}

fn text_json_payload(message: &str) -> (String, Vec<u8>) {
    (
        "application/json".to_string(),
        json!({
            "msgtype": "text",
            "text": { "content": message },
        })
        .to_string()
        .into_bytes(),
    )
}

/// Notify about a download-type scheme's outcome: webhooks + OS
/// notification + in-app event. All non-blocking. `detail` is the
/// failure reason (empty on success).
pub fn notify_download_outcome<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    node: &Value,
    success: bool,
    detail: &str,
) {
    let channel = node
        .get("notify_channel")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let title = node
        .get("title")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| "SwitchHosts".to_string());

    // 解析最终文案：优先使用用户自定义模板（支持 {title} {result} {message}）
    let template = node
        .get("notify_message")
        .and_then(Value::as_str)
        .unwrap_or("");
    let format = node
        .get("notify_format")
        .and_then(Value::as_str)
        .unwrap_or(FORMAT_TEXT);
    let result = if success { "下载完成" } else { "下载失败" };
    let resolved = resolve_notify_message(&title, template, result, detail);
    let os_line = resolve_notify_message(&title, "", result, detail);

    // 1. In-app toast event (renderer throttles per id).
    let node_id = node.get("id").and_then(Value::as_str).map(String::from);
    let _ = app.emit(
        "download_done",
        json!({ "_args": [{ "id": node_id, "success": success, "message": resolved }] }),
    );

    // 2. OS notification (best effort).
    let os_msg = format!("{title}：{os_line}");
    let app_for_os = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app_for_os
            .notification()
            .builder()
            .title("SwitchHosts")
            .body(&os_msg)
            .show()
        {
            log::warn!("failed to show OS notification: {e}");
        }
    });

    // 3. Webhook pushes (fire-and-forget) — 读取按渠道的 webhook 列表
    //    （钉钉的「加签密钥」按同一渠道平行存储）。
    let webhooks: Vec<String> = node
        .get("notify_webhooks")
        .and_then(Value::as_object)
        .and_then(|m| m.get(channel))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let secrets: Vec<String> = if channel == CHANNEL_DINGTALK {
        node.get("notify_webhook_secrets")
            .and_then(Value::as_object)
            .and_then(|m| m.get(CHANNEL_DINGTALK))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|v| v.as_str().map(|s| s.trim().to_string()).unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if channel.is_empty() || webhooks.is_empty() {
        return;
    }
    let client = match http::build_client(state) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("failed to build webhook client: {e}");
            return;
        }
    };
    let channel = channel.to_string();
    let format = format.to_string();
    let title = title.clone();
    let message = resolved;
    tauri::async_runtime::spawn(async move {
        for (idx, url) in webhooks.into_iter().enumerate() {
            let secret = secrets.get(idx).cloned().unwrap_or_default();
            post_webhook(&client, &url, &secret, &channel, &format, &title, &message).await;
        }
    });
}

async fn post_webhook(
    client: &reqwest::Client,
    url: &str,
    secret: &str,
    channel: &str,
    format: &str,
    title: &str,
    message: &str,
) {
    let (content_type, body) = build_webhook_payload(channel, format, title, message);
    // 钉钉「加签」模式：把签名拼进 URL 后再发送
    let target = if channel == CHANNEL_DINGTALK {
        dingtalk_sign_url(url, secret)
    } else {
        url.to_string()
    };
    let result = client
        .post(&target)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(body)
        .send()
        .await;
    match result {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => log::warn!("webhook {url} returned HTTP {}", resp.status().as_u16()),
        Err(e) => log::warn!("webhook {url} failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wecom_text_payload_is_text_json() {
        let (ct, body) = build_webhook_payload(CHANNEL_WECOM, FORMAT_TEXT, "标题", "下载完成");
        assert_eq!(ct, "application/json");
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["msgtype"], "text");
        assert_eq!(v["text"]["content"], "下载完成");
    }

    #[test]
    fn wecom_markdown_uses_markdown_msgtype() {
        let (ct, body) = build_webhook_payload(CHANNEL_WECOM, FORMAT_MARKDOWN, "t", "# ✅ 下载完成");
        assert_eq!(ct, "application/json");
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["msgtype"], "markdown");
        assert_eq!(v["markdown"]["content"], "# ✅ 下载完成");
    }

    #[test]
    fn dingtalk_markdown_carries_title_and_text() {
        let (ct, body) = build_webhook_payload(CHANNEL_DINGTALK, FORMAT_MARKDOWN, "我的方案", "**下载完成**");
        assert_eq!(ct, "application/json");
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["msgtype"], "markdown");
        assert_eq!(v["markdown"]["title"], "我的方案");
        assert_eq!(v["markdown"]["text"], "**下载完成**");
    }

    #[test]
    fn other_text_is_plain_other_markdown_is_markdown_ct() {
        let (ct, body) = build_webhook_payload(CHANNEL_OTHER, FORMAT_TEXT, "t", "hello 🔔");
        assert_eq!(ct, "text/plain; charset=utf-8");
        assert_eq!(String::from_utf8(body).unwrap(), "hello 🔔");

        let (ct2, body2) = build_webhook_payload(CHANNEL_OTHER, FORMAT_MARKDOWN, "t", "#标题");
        assert_eq!(ct2, "text/markdown; charset=utf-8");
        assert_eq!(String::from_utf8(body2).unwrap(), "#标题");
    }

    #[test]
    fn unknown_channel_falls_back_to_plain_text() {
        let (ct, _) = build_webhook_payload("slack", FORMAT_TEXT, "t", "x");
        assert_eq!(ct, "text/plain; charset=utf-8");
    }

    #[test]
    fn empty_template_keeps_builtin_outcome_line() {
        assert_eq!(
            resolve_notify_message("方案A", "", "下载完成", ""),
            "下载完成"
        );
        assert_eq!(
            resolve_notify_message("方案A", "", "下载失败", "HTTP 404"),
            "下载失败：HTTP 404"
        );
    }

    #[test]
    fn template_substitutes_placeholders() {
        let out = resolve_notify_message(
            "PortableGit",
            "【{title}】{result}：{message}",
            "下载失败",
            "HTTP 500",
        );
        assert_eq!(out, "【PortableGit】下载失败：HTTP 500");
    }

    #[test]
    fn dingtalk_sign_has_expected_shape_and_no_raw_b64_chars() {
        let sign = dingtalk_sign("SEC_test_secret", 1_700_000_000_000);
        assert!(sign.starts_with("timestamp=1700000000000&sign="));
        let sig = sign[sign.find("sign=").unwrap() + 5..].to_string();
        // URL 编码后的 base64：不允许出现未转义的 + / =
        assert!(!sig.contains('+') && !sig.contains('/') && !sig.contains('='));
    }

    #[test]
    fn dingtalk_sign_url_appends_without_breaking_query() {
        let base = "https://oapi.dingtalk.com/robot/send?access_token=abc";
        let signed = dingtalk_sign_url(base, "SEC_x");
        assert!(signed.starts_with(&format!("{base}&timestamp=")));
        let sign_pos = signed.find("&sign=").expect("sign query present");
        let sig = &signed[sign_pos + 6..];
        assert!(
            !sig.contains('+') && !sig.contains('/') && !sig.contains('='),
            "sign must be URL-encoded"
        );
        // 密钥为空时原样返回
        assert_eq!(dingtalk_sign_url(base, ""), base);
    }
}