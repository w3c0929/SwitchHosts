//! Remote `hosts` refresh, both renderer-driven and time-driven.
//!
//! Mirrors the Electron implementation in
//! [src/main/actions/hosts/refresh.ts] and [src/main/libs/cron.ts]:
//!
//! - `refresh_one` fetches the URL of a remote node, writes the new
//!   content to `entries/<id>.hosts` if it differs from the current
//!   contents, and updates `last_refresh` / `last_refresh_ms` on the
//!   node in the manifest.
//! - The background scanner wakes when the *earliest* remote node
//!   becomes due (instead of a fixed 60s poll), so per-node intervals
//!   — including custom short ones like 10s — are honored as close to
//!   their configured value as the minimum wake floor allows. It falls
//!   back to a 60s poll only when no node has a due time yet.
//!
//! Locking discipline (per implementation-notes A5): the HTTP fetch
//! happens *outside* `store_lock`, since it can block for many
//! seconds. We acquire the lock only for the read-modify-write of
//! manifest.json, and *re-find* the target node by id at lock time so
//! a concurrent renderer edit doesn't get clobbered.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::http;
use crate::storage::{entries, manifest::Manifest, AppState};

/// Fallback poll interval: slept when no remote node has a due time
/// yet, and the upper bound for any single wake delay.
const SCAN_INTERVAL: Duration = Duration::from_secs(60);
/// Minimum wake delay. Prevents a busy loop when a refresh keeps
/// failing (the node's `last_refresh_ms` is never advanced, so it stays
/// "due" — without this floor the scanner would spin on it every tick).
const SCAN_MIN_WAKE: Duration = Duration::from_secs(5);

/// Result of a single refresh attempt. Translated into the renderer's
/// `IOperationResult` shape (`{success, code?, message?, data?}`) at
/// the command boundary.
#[derive(Debug)]
pub enum RefreshOutcome {
    /// Fetched and written.
    Updated { node: Value },
    /// Fetched, content unchanged on disk; node still touched
    /// (`last_refresh*` updated) so the next scan tick respects the
    /// interval.
    Unchanged { node: Value },
}

#[derive(Debug, Clone)]
pub enum RefreshError {
    /// Node id doesn't exist in the manifest.
    InvalidId,
    /// Node exists but isn't a remote node.
    NotRemote,
    /// Node has no URL set.
    NoUrl,
    /// HTTP / network failure, file:// read failure, etc.
    Fetch { message: String },
    /// Filesystem failure during the write or manifest update.
    Storage { message: String },
}

impl RefreshError {
    pub fn into_renderer_value(self) -> Value {
        let (code, message) = match self {
            RefreshError::InvalidId => ("invalid_id", "node not found".to_string()),
            RefreshError::NotRemote => ("not_remote", "node is not a remote hosts".to_string()),
            RefreshError::NoUrl => ("no_url", "remote node has no URL".to_string()),
            RefreshError::Fetch { message } => ("fetch_failed", message),
            RefreshError::Storage { message } => ("storage_failed", message),
        };
        json!({
            "success": false,
            "code": code,
            "message": message,
        })
    }
}

/// Refresh a single remote node by id.
pub async fn refresh_one<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: &str,
) -> Result<RefreshOutcome, RefreshError> {
    refresh_one_inner(app, state, id, true).await
}

async fn refresh_one_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: &str,
    emit_content_changed: bool,
) -> Result<RefreshOutcome, RefreshError> {
    // Step 1: snapshot the node from the current manifest. No lock —
    // we only need to read.
    let manifest = Manifest::load(&state.paths).map_err(|e| RefreshError::Storage {
        message: e.to_string(),
    })?;
    let snapshot = match find_node(&manifest.root, id) {
        Some(n) => n,
        None => return Err(RefreshError::InvalidId),
    };
    if snapshot.get("type").and_then(Value::as_str) != Some("remote") {
        return Err(RefreshError::NotRemote);
    }
    let url = match snapshot.get("url").and_then(Value::as_str) {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return Err(RefreshError::NoUrl),
    };
    // 内容用途：缺省/true 视为 hosts 内容；false = 仅抓取/触发，
    // 内容不进入 hosts 管线（不写 entries、不产生内容变更事件），
    // 按字节读取并原样镜像到 save_path。
    let as_hosts = snapshot.get("as_hosts").and_then(Value::as_bool) != Some(false);

    // Step 2 + 2.5 + 3: 按用途分两条路径。
    //  - hosts 方案：fetch_remote 按文本读取（hosts 上限 32MB、30s 超时），
    //    LF 规范化后镜像到 save_path，再写入内部 entries。
    //  - 仅抓取/下载方案（有 save_path）：流式下载（不设大小上限、默认
    //    30s 超时、禁用解压），响应字节原样写入 save_path，完成或失败时
    //    推送通知（Webhook + 系统通知 + 应用内提示）。
    //  - 仅抓取/触发方案（无 save_path）：发起请求、读取响应文本写回内部
    //    entries 供右侧查看（不产生内容变更事件、不进 hosts 管线）。
    let mut content_changed = false;
    // 下载型方案是否成功完成（成功后用 Step 4 的最新配置推送通知）
    let mut download_success_notify = false;
    if as_hosts {
        let new_content = fetch_remote(&url, state).await?;

        if let Some(save_path) = snapshot.get("save_path").and_then(Value::as_str) {
            let save_path = save_path.trim();
            if !save_path.is_empty() {
                if let Err(message) = write_save_copy(save_path, &new_content) {
                    log::warn!("remote {id}: failed to mirror content to save_path: {message}");
                }
            }
        }

        // 与内部 entries 比对（always LF on disk）。remote payload may use
        // CRLF, so normalize before comparing — otherwise a CRLF response
        // would defeat the equality check on every poll and we'd emit a
        // spurious "content changed" event each tick.
        let old_content =
            entries::read_entry(&state.paths.entries_dir, id).map_err(|e| RefreshError::Storage {
                message: e.to_string(),
            })?;
        let new_content_lf = entries::normalize_to_lf(&new_content);
        content_changed = old_content != new_content_lf;
        if content_changed {
            entries::write_entry(&state.paths.entries_dir, id, &new_content_lf).map_err(|e| {
                RefreshError::Storage {
                    message: e.to_string(),
                }
            })?;
        }
    } else {
        // 仅抓取/下载方案：不设大小上限、不设特殊超时（沿用默认 30s）。
        //  - 配置了 save_path（下载型）：流式下载，边下边写 `<目标>.part`，
        //    成功后原子替换目标文件（二进制字节原样保留，不整包驻留内存）；
        //    完成/失败时推送通知（Webhook + 系统通知 + 应用内提示）。失败
        //    返回错误（下载就是该方案的目的，应让用户看见）。
        //  - 未配置（触发型）：发起请求并读取响应文本写回内部 entries，供
        //    右侧查看（如 send-mail API 返回的 JSON）；不产生内容变更事件、
        //    不进 hosts 管线。
        match snapshot.get("save_path").and_then(Value::as_str) {
            Some(p) if !p.trim().is_empty() => {
                let result = download_to_file(&url, p.trim(), state).await;
                match result {
                    Ok(()) => {
                        // 成功：不在抓取时快照上发通知，等 Step 4 用
                        // 锁内重读的“最新”配置（updated_snapshot）再推送，
                        // 避免抓取期间用户切换渠道/改 webhook 造成竞态。
                        download_success_notify = true;
                    }
                    Err(e) => {
                        let message = match &e {
                            RefreshError::Fetch { message } => message.clone(),
                            _ => format!("{e:?}"),
                        };
                        // 失败：显式重新读取 manifest，用当时的配置推送
                        //（含失败描述），再返回错误。
                        if let Ok(fresh_manifest) = Manifest::load(&state.paths) {
                            if let Some(node) = find_node(&fresh_manifest.root, id) {
                                crate::webhook::notify_download_outcome(
                                    app,
                                    state,
                                    &node,
                                    false,
                                    &message,
                                );
                            }
                        }
                        return Err(e);
                    }
                }
            }
            _ => {
                // 触发型：读取响应文本并写回内部缓存（右侧编辑器在
                // hosts_refreshed 时自动重新加载显示）。
                let new_content = fetch_remote(&url, state).await?;
                entries::write_entry(&state.paths.entries_dir, id, &new_content)
                    .map_err(|e| RefreshError::Storage {
                        message: e.to_string(),
                    })?;
            }
        }
    }

    // Step 4: re-acquire the manifest under the store lock and stamp
    // last_refresh / last_refresh_ms on the (possibly relocated) node.
    let updated_snapshot = {
        let _guard = state.store_lock.lock().expect("store lock poisoned");
        let mut manifest = Manifest::load(&state.paths).map_err(|e| RefreshError::Storage {
            message: e.to_string(),
        })?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let stamp = format_timestamp(now_ms);
        let touched = stamp_node(&mut manifest.root, id, &stamp, now_ms);
        if !touched {
            // Concurrent delete between step 1 and now. Treat as
            // success — the entries file we just wrote is harmless
            // garbage that the next GC pass will clean up.
            return Err(RefreshError::InvalidId);
        }
        manifest
            .save(&state.paths)
            .map_err(|e| RefreshError::Storage {
                message: e.to_string(),
            })?;
        find_node(&manifest.root, id).unwrap_or(snapshot.clone())
    };

    // Step 5: tell the UI. Both events match the Electron broadcast
    // names so the existing renderer subscribers fire unchanged.
    let _ = app.emit(
        "hosts_refreshed",
        json!({ "_args": [updated_snapshot.clone()] }),
    );
    if content_changed && emit_content_changed {
        let _ = app.emit("hosts_content_changed", json!({ "_args": [id] }));
    }

    // 下载型成功通知：用 Step 4 锁内重读的最新配置推送（防竞态——
    // 用户可能正在切换渠道或增删 webhook）。
    if download_success_notify {
        crate::webhook::notify_download_outcome(app, state, &updated_snapshot, true, "");
    }

    if content_changed {
        Ok(RefreshOutcome::Updated {
            node: updated_snapshot,
        })
    } else {
        Ok(RefreshOutcome::Unchanged {
            node: updated_snapshot,
        })
    }
}

/// Refresh every remote node in the manifest. Failures are collected
/// per-node and returned alongside successes so the caller (renderer
/// or background scanner) can decide what to do.
pub async fn refresh_all<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
) -> Vec<(String, Result<RefreshOutcome, RefreshError>)> {
    let manifest = match Manifest::load(&state.paths) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("manifest load failed: {e}");
            return Vec::new();
        }
    };
    let ids = collect_remote_ids(&manifest.root);
    refresh_many(app, state, ids).await
}

async fn refresh_many<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    ids: Vec<String>,
) -> Vec<(String, Result<RefreshOutcome, RefreshError>)> {
    let mut results = Vec::with_capacity(ids.len());
    let mut changed_ids = Vec::new();
    for id in ids {
        let outcome = refresh_one_inner(app, state, &id, false).await;
        if matches!(&outcome, Ok(RefreshOutcome::Updated { .. })) {
            changed_ids.push(id.clone());
        }
        if let Err(e) = &outcome {
            // Auto-refresh failures are otherwise invisible (log-only).
            // Broadcast an event so the UI can distinguish "refresh ran
            // but failed" from "refresh never ran".
            let mut v = e.clone().into_renderer_value();
            if let Some(obj) = v.as_object_mut() {
                obj.insert("id".to_string(), json!(id.clone()));
            }
            let _ = app.emit("hosts_refresh_failed", json!({ "_args": [v] }));
        }
        results.push((id, outcome));
    }
    emit_content_changed_batch(app, &changed_ids);
    results
}

fn emit_content_changed_batch<R: Runtime>(app: &AppHandle<R>, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let _ = app.emit("hosts_content_changed_batch", json!({ "_args": [ids] }));
}

fn log_refresh_errors(results: &[(String, Result<RefreshOutcome, RefreshError>)]) {
    for (id, outcome) in results {
        if let Err(e) = outcome {
            log::warn!("{id}: {e:?}");
        }
    }
}

// ---- background scanner ----------------------------------------------------

/// Spawn the background scanner. After the initial startup delay it
/// runs `scan_once` (refreshing every remote node whose
/// `refresh_interval` has elapsed), then sleeps *until the earliest
/// remaining due time* rather than a fixed 60s — so a custom 10s
/// interval actually fires about every 10s. Returns a flag the caller
/// can flip to false to ask the scanner to exit on its next wake —
/// currently unused but lets us avoid a stranded task if the bootstrap
/// path needs it later.
pub fn start_background_scanner<R: Runtime>(app: AppHandle<R>) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_task = stop.clone();
    tauri::async_runtime::spawn(async move {
        // First tick after a small delay so the renderer's startup
        // burst (manifest reload, config push) doesn't compete with a
        // potentially-blocking HTTP fan-out.
        tokio::time::sleep(Duration::from_secs(5)).await;
        if stop_for_task.load(Ordering::Relaxed) {
            return;
        }
        if should_refresh_all_on_startup(&app) {
            let state_guard = app.state::<AppState>();
            let results = refresh_all(&app, state_guard.inner()).await;
            log_refresh_errors(&results);
            let _ = app.emit("reload_list", json!({ "_args": [] }));
        }
        loop {
            if stop_for_task.load(Ordering::Relaxed) {
                break;
            }
            scan_once(&app).await;
            // Sleep until the earliest next due moment — or wake earlier
            // when the user changes the list (toggles a scheme on, edits
            // an interval): `set_list` calls refresh_wake.notify_one(),
            // so an enable is picked up within milliseconds instead of
            // waiting out the (up to 60s) idle poll.
            let delay = next_scan_delay(&app).await;
            let state_guard = app.state::<AppState>();
            let wake = state_guard.refresh_wake.notified();
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = wake => {}
            }
        }
    });
    stop
}

/// How long the scanner should sleep before its next wake: the
/// remaining time until the *earliest* remote node becomes due,
/// clamped to `[SCAN_MIN_WAKE, SCAN_INTERVAL]`, or `SCAN_INTERVAL`
/// when no node will ever be due.
async fn next_scan_delay<R: Runtime>(app: &AppHandle<R>) -> Duration {
    let state_guard = app.state::<AppState>();
    let manifest = match Manifest::load(&state_guard.paths) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("manifest load failed: {e}");
            return SCAN_INTERVAL;
        }
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    scan_delay_from_wait(next_due_wait_ms(&manifest.root, now_ms))
}

/// Milliseconds until the nearest due remote node, or `None` when no
/// node has a due time (no remote nodes at all, every interval is 0,
/// or no usable URL). Mirrors the eligibility rules of
/// [`collect_due_remote_ids`].
fn next_due_wait_ms(nodes: &[Value], now_ms: i64) -> Option<i64> {
    let mut earliest: Option<i64> = None;
    walk_remote(nodes, &mut |node| {
        // 关闭（on !== true）的方案不参与自动刷新，也不占用唤醒节奏
        if !is_enabled(node) {
            return;
        }
        let interval_sec = node
            .get("refresh_interval")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if interval_sec <= 0 {
            return;
        }
        let url_ok = node
            .get("url")
            .and_then(Value::as_str)
            .map(|u| {
                u.starts_with("http://") || u.starts_with("https://") || u.starts_with("file://")
            })
            .unwrap_or(false);
        if !url_ok {
            return;
        }
        let last_ms = node
            .get("last_refresh_ms")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        // Never refreshed → already due (0). Otherwise: remaining time
        // until interval_sec elapses since last_refresh_ms.
        let wait_ms = if last_ms == 0 {
            0
        } else {
            (interval_sec * 1000).saturating_sub(now_ms - last_ms)
        };
        earliest = Some(earliest.map_or(wait_ms, |e| e.min(wait_ms)));
    });
    earliest
}

/// Convert a raw "milliseconds until next due" value into the actual
/// sleep duration, enforcing the minimum-wake floor (no busy loops)
/// and the maximum poll cap.
fn scan_delay_from_wait(wait_ms: Option<i64>) -> Duration {
    match wait_ms {
        Some(w) => Duration::from_millis(w.max(0) as u64).clamp(SCAN_MIN_WAKE, SCAN_INTERVAL),
        None => SCAN_INTERVAL,
    }
}

async fn scan_once<R: Runtime>(app: &AppHandle<R>) {
    let state_guard = app.state::<AppState>();
    let state = state_guard.inner();
    let manifest = match Manifest::load(&state.paths) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("manifest load failed: {e}");
            return;
        }
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let due_ids = collect_due_remote_ids(&manifest.root, now_ms);
    if due_ids.is_empty() {
        return;
    }
    let results = refresh_many(app, state, due_ids).await;
    log_refresh_errors(&results);
    // Mirror the Electron `broadcast(events.reload_list)` at the end
    // of every scan so List components rerun loadHostsData.
    let _ = app.emit("reload_list", json!({ "_args": [] }));
}

fn should_refresh_all_on_startup<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state_guard = app.state::<AppState>();
    state_guard
        .config
        .lock()
        .map(|cfg| cfg.refresh_remote_hosts_on_startup)
        .unwrap_or(false)
}

// ---- fetch -----------------------------------------------------------------

async fn fetch_remote(url: &str, state: &AppState) -> Result<String, RefreshError> {
    if let Some(stripped) = url.strip_prefix("file://") {
        return read_file_url(stripped, url);
    }

    let client = http::build_client(state).map_err(|message| RefreshError::Fetch { message })?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| RefreshError::Fetch {
            message: e.to_string(),
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(RefreshError::Fetch {
            message: format!("HTTP {}", status.as_u16()),
        });
    }
    http::response_text_with_limit(response, http::MAX_REMOTE_HOSTS_BYTES)
        .await
        .map_err(|message| RefreshError::Fetch { message })
}

fn read_file_url(stripped: &str, original: &str) -> Result<String, RefreshError> {
    // After `strip_prefix("file://")`:
    //   `file:///Users/x/foo`        → `/Users/x/foo`
    //   `file://localhost/Users/x/y` → `localhost/Users/x/y`
    // We tolerate the optional `localhost` host segment so both forms
    // work the same way. Anything else is treated as an opaque path.
    let path = stripped.strip_prefix("localhost").unwrap_or(stripped);
    http::read_text_file_with_limit(Path::new(path), http::MAX_REMOTE_HOSTS_BYTES).map_err(
        |message| RefreshError::Fetch {
            message: format!("{original}: {message}"),
        },
    )
}

/// Download-type scheme (as_hosts = false + configured save_path):
/// stream the payload to `<target>.part` and atomically rename it over
/// the target on success, so a large / binary file is written
/// incrementally (no whole-body buffering) and a failed download never
/// leaves a half-written file at the target path. No artificial size
/// cap; the default request timeout applies.
async fn download_to_file(
    url: &str,
    save_path: &str,
    state: &AppState,
) -> Result<(), RefreshError> {
    let target = PathBuf::from(save_path);

    if let Some(stripped) = url.strip_prefix("file://") {
        let src = PathBuf::from(stripped.strip_prefix("localhost").unwrap_or(stripped));
        return copy_file_download(&src, &target).map_err(|message| RefreshError::Fetch {
            message,
        });
    }

    let client = http::build_download_client(state)
        .map_err(|message| RefreshError::Fetch { message })?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| RefreshError::Fetch {
            message: e.to_string(),
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(RefreshError::Fetch {
            message: format!("HTTP {}", status.as_u16()),
        });
    }

    let target_desc = target.display().to_string();
    let part = part_of(&target);
    let mut file = open_part_file(&target).map_err(|message| RefreshError::Fetch { message })?;
    let result = stream_response_to_part(&mut response, &mut file, &target_desc).await;
    drop(file);
    match result {
        Ok(()) => finalize_part_file(&part, &target)
            .map_err(|message| RefreshError::Fetch { message }),
        Err(message) => {
            abort_part_file(&part);
            Err(RefreshError::Fetch { message })
        }
    }
}

fn part_of(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!("{name}.part"))
}

/// Open `<target>.part` for streaming writes; parent dirs are created
/// on demand.
fn open_part_file(target: &Path) -> Result<std::fs::File, String> {
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create directory {}: {e}", parent.display()))?;
        }
    }
    let part = part_of(target);
    std::fs::File::create(&part)
        .map_err(|e| format!("failed to create {}: {e}", part.display()))
}

/// Atomically replace `target` with the completed `.part` file. Windows
/// `rename` cannot overwrite an existing file, so fall back to
/// remove-then-rename there.
fn finalize_part_file(part: &Path, target: &Path) -> Result<(), String> {
    if std::fs::rename(part, target).is_err() {
        let _ = std::fs::remove_file(target);
        std::fs::rename(part, target).map_err(|e| {
            format!(
                "failed to move {} to {}: {e}",
                part.display(),
                target.display()
            )
        })?;
    }
    Ok(())
}

fn abort_part_file(part: &Path) {
    let _ = std::fs::remove_file(part);
}

/// Stream every response chunk into the part file, flushing at the end.
async fn stream_response_to_part(
    response: &mut reqwest::Response,
    file: &mut std::fs::File,
    target_desc: &str,
) -> Result<(), String> {
    use std::io::Write;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk)
            .map_err(|e| format!("failed to write {target_desc}: {e}"))?;
    }
    file.flush()
        .map_err(|e| format!("failed to flush {target_desc}: {e}"))?;
    Ok(())
}

/// `file://` download: copy the local source to the target through the
/// same staged (.part → rename) path.
fn copy_file_download(src: &Path, target: &Path) -> Result<(), String> {
    let part = part_of(target);
    let mut file = open_part_file(target)?;
    {
        use std::io::Write;
        let mut input = std::fs::File::open(src)
            .map_err(|e| format!("read {}: {e}", src.display()))?;
        std::io::copy(&mut input, &mut file)
            .map_err(|e| format!("copy {} -> {}: {e}", src.display(), target.display()))?;
        file.flush()
            .map_err(|e| format!("failed to flush {}: {e}", target.display()))?;
    }
    drop(file);
    finalize_part_file(&part, target)
}

/// Write the mirror copy of a remote hosts entry to the user-configured
/// `save_path`. The content is normalized to LF (same invariant as the
/// internal entries store), parent directories are created on demand,
/// and an unmodified file is left untouched so repeated scan ticks
/// don't churn its mtime.
fn write_save_copy(save_path: &str, content: &str) -> Result<(), String> {
    let path = Path::new(save_path);
    let normalized = entries::normalize_to_lf(content);

    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing == normalized {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!("failed to create directory {}: {e}", parent.display())
            })?;
        }
    }

    std::fs::write(path, normalized.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

// ---- tree helpers ----------------------------------------------------------

fn find_node(nodes: &[Value], id: &str) -> Option<Value> {
    for node in nodes {
        if node.get("id").and_then(Value::as_str) == Some(id) {
            return Some(node.clone());
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            if let Some(found) = find_node(children, id) {
                return Some(found);
            }
        }
    }
    None
}

fn stamp_node(nodes: &mut [Value], id: &str, ts_str: &str, ts_ms: i64) -> bool {
    for node in nodes.iter_mut() {
        if node.get("id").and_then(Value::as_str) == Some(id) {
            if let Some(obj) = node.as_object_mut() {
                obj.insert("last_refresh".to_string(), json!(ts_str));
                obj.insert("last_refresh_ms".to_string(), json!(ts_ms));
                return true;
            }
        }
        if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
            if stamp_node(children, id, ts_str, ts_ms) {
                return true;
            }
        }
    }
    false
}

fn collect_remote_ids(nodes: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    walk_remote(nodes, &mut |node| {
        // 与 aggregate.rs 的约定一致：只有启用的（on === true）方案
        // 才参与自动刷新；开关关闭的方案不再被扫描器触碰。
        if is_enabled(node) {
            if let Some(id) = node.get("id").and_then(Value::as_str) {
                out.push(id.to_string());
            }
        }
    });
    out
}

fn collect_due_remote_ids(nodes: &[Value], now_ms: i64) -> Vec<String> {
    let mut out = Vec::new();
    walk_remote(nodes, &mut |node| {
        if !is_enabled(node) {
            return;
        }
        let interval_sec = node
            .get("refresh_interval")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if interval_sec <= 0 {
            return;
        }
        // Accept any URL the manual refresh path can fetch — http,
        // https and file. Electron's cron skipped file:// URLs but
        // that was an oversight: local reads are cheap and "auto
        // refresh from a file watched on disk" is a real workflow.
        let url_ok = node
            .get("url")
            .and_then(Value::as_str)
            .map(|u| {
                u.starts_with("http://") || u.starts_with("https://") || u.starts_with("file://")
            })
            .unwrap_or(false);
        if !url_ok {
            return;
        }
        let last_ms = node
            .get("last_refresh_ms")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let due = last_ms == 0 || (now_ms - last_ms) / 1000 >= interval_sec;
        if due {
            if let Some(id) = node.get("id").and_then(Value::as_str) {
                out.push(id.to_string());
            }
        }
    });
    out
}

fn walk_remote(nodes: &[Value], visit: &mut impl FnMut(&Value)) {
    for node in nodes {
        if node.get("type").and_then(Value::as_str) == Some("remote") {
            visit(node);
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            walk_remote(children, visit);
        }
    }
}

/// A remote node participates in *automatic* refresh only when it is
/// enabled (`on === true`). Mirrors the inclusion rule in
/// `hosts_apply::aggregate` (`on` missing → not enabled), so a scheme
/// that is switched off is neither applied to the system hosts nor
/// auto-refreshed. Manual refresh (`refresh_one`) is unaffected.
fn is_enabled(node: &Value) -> bool {
    node.get("on").and_then(Value::as_bool) == Some(true)
}

fn format_timestamp(ms: i64) -> String {
    // Mirror the Electron `dayjs().format('YYYY-MM-DD HH:mm:ss')`
    // shape so renderer code that displays last_refresh as-is keeps
    // looking the same.
    chrono::DateTime::<chrono::Local>::from(
        std::time::UNIX_EPOCH + Duration::from_millis(ms as u64),
    )
    .format("%Y-%m-%d %H:%M:%S")
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> Vec<Value> {
        // Mixed types under a folder so the walk_remote / find_node /
        // stamp_node passes are exercised against realistic shapes.
        // Remote nodes carry `on: true` so the automatic-refresh
        // eligibility tests exercise them.
        json!([
            { "id": "local-1", "type": "local", "on": true },
            {
                "id": "folder-a",
                "type": "folder",
                "children": [
                    {
                        "id": "remote-1",
                        "type": "remote",
                        "on": true,
                        "url": "https://example.com/hosts",
                        "refresh_interval": 60,
                        "last_refresh_ms": 0,
                    },
                    {
                        "id": "remote-2",
                        "type": "remote",
                        "on": true,
                        "url": "https://example.com/other",
                        "refresh_interval": 60,
                        "last_refresh_ms": 1_000,
                    },
                    {
                        "id": "remote-no-interval",
                        "type": "remote",
                        "on": true,
                        "url": "https://example.com/never",
                        "refresh_interval": 0,
                        "last_refresh_ms": 0,
                    },
                    {
                        "id": "remote-bad-scheme",
                        "type": "remote",
                        "on": true,
                        "url": "ftp://nope.example.com/hosts",
                        "refresh_interval": 60,
                        "last_refresh_ms": 0,
                    },
                    {
                        "id": "remote-off",
                        "type": "remote",
                        "on": false,
                        "url": "https://example.com/off",
                        "refresh_interval": 60,
                        "last_refresh_ms": 0,
                    },
                ]
            },
            {
                "id": "remote-file",
                "type": "remote",
                "on": true,
                "url": "file:///tmp/hosts",
                "refresh_interval": 60,
                "last_refresh_ms": 0,
            },
        ])
        .as_array()
        .cloned()
        .unwrap()
    }

    #[test]
    fn find_node_locates_top_level_then_nested() {
        let nodes = tree();
        assert_eq!(
            find_node(&nodes, "local-1")
                .and_then(|n| n.get("type").and_then(Value::as_str).map(String::from)),
            Some("local".into())
        );
        assert_eq!(
            find_node(&nodes, "remote-1")
                .and_then(|n| n.get("url").and_then(Value::as_str).map(String::from)),
            Some("https://example.com/hosts".into())
        );
        assert!(find_node(&nodes, "missing").is_none());
    }

    #[test]
    fn stamp_node_writes_both_fields_and_returns_true_only_when_found() {
        let mut nodes = tree();
        let touched = stamp_node(&mut nodes, "remote-2", "2026-05-09 14:00:00", 1_700_000);
        assert!(touched);
        let stamped = find_node(&nodes, "remote-2").unwrap();
        assert_eq!(
            stamped.get("last_refresh").and_then(Value::as_str),
            Some("2026-05-09 14:00:00")
        );
        assert_eq!(
            stamped.get("last_refresh_ms").and_then(Value::as_i64),
            Some(1_700_000)
        );

        // Unrelated nodes must not be touched.
        let untouched = find_node(&nodes, "remote-1").unwrap();
        assert_eq!(
            untouched.get("last_refresh_ms").and_then(Value::as_i64),
            Some(0)
        );

        assert!(!stamp_node(&mut nodes, "missing-id", "ts", 0));
    }

    #[test]
    fn collect_remote_ids_skips_local_folder_and_disabled_nodes() {
        let ids = collect_remote_ids(&tree());
        // remote-off (on: false) must be excluded like local/folder nodes.
        assert_eq!(
            ids,
            vec![
                "remote-1",
                "remote-2",
                "remote-no-interval",
                "remote-bad-scheme",
                "remote-file"
            ]
        );
    }

    #[test]
    fn collect_due_remote_ids_respects_interval_url_scheme_and_first_run() {
        // now = 1_000_000 ms.
        // remote-1: last_ms=0 → first-run due.
        // remote-2: last_ms=1_000, interval=60s → 999 sec elapsed → due.
        // remote-no-interval: interval=0 → skip.
        // remote-bad-scheme: ftp:// → skip.
        // remote-off: on=false → skipped regardless of interval.
        // remote-file: file:// is allowed, last_ms=0 → due.
        let due = collect_due_remote_ids(&tree(), 1_000_000);
        assert_eq!(due, vec!["remote-1", "remote-2", "remote-file"]);
    }

    #[test]
    fn collect_due_remote_ids_skips_disabled_remote_nodes() {
        // remote-off has a valid interval and last_refresh_ms = 0 (would
        // be due), but the switch is off — it must never be refreshed by
        // the scanner. A node with a missing `on` field (new item, never
        // toggled) is treated as disabled too, matching aggregate.rs.
        let nodes = json!([
            {
                "id": "remote-off",
                "type": "remote",
                "on": false,
                "url": "https://example.com/off",
                "refresh_interval": 10,
                "last_refresh_ms": 0,
            },
            {
                "id": "remote-no-on",
                "type": "remote",
                "url": "https://example.com/no-on",
                "refresh_interval": 10,
                "last_refresh_ms": 0,
            },
        ])
        .as_array()
        .cloned()
        .unwrap();
        assert!(collect_due_remote_ids(&nodes, 1_000_000).is_empty());
        assert!(collect_remote_ids(&nodes).is_empty());
    }

    #[test]
    fn collect_due_remote_ids_skips_when_interval_not_yet_elapsed() {
        // Stamp remote-2 at now-30s and ask for due nodes; with a 60s
        // interval it must not be reported.
        let mut nodes = tree();
        let now_ms: i64 = 10_000_000;
        stamp_node(&mut nodes, "remote-2", "ignored", now_ms - 30_000);
        let due = collect_due_remote_ids(&nodes, now_ms);
        assert!(!due.contains(&"remote-2".into()));
        // remote-1 (last_ms=0) is still due.
        assert!(due.contains(&"remote-1".into()));
    }

    #[test]
    fn format_timestamp_matches_yyyy_mm_dd_hh_mm_ss_layout() {
        // The exact value depends on the local timezone; only the
        // shape is part of the contract with the renderer's display.
        let s = format_timestamp(1_700_000_000_000);
        let bytes = s.as_bytes();
        assert_eq!(bytes.len(), 19);
        assert_eq!(bytes[4], b'-');
        assert_eq!(bytes[7], b'-');
        assert_eq!(bytes[10], b' ');
        assert_eq!(bytes[13], b':');
        assert_eq!(bytes[16], b':');
        for i in [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
            assert!(
                bytes[i].is_ascii_digit(),
                "char at {i} should be a digit: {s}"
            );
        }
    }

    #[test]
    fn write_save_copy_creates_file_with_parent_dirs() {
        let root = std::env::temp_dir().join(format!(
            "swh-save-copy-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("nested").join("mirror.hosts");
        let path_str = path.to_string_lossy().into_owned();

        write_save_copy(&path_str, "127.0.0.1 example.com\n").expect("write save copy");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read mirror"),
            "127.0.0.1 example.com\n"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn write_save_copy_normalizes_crlf_and_skips_rewrite_when_identical() {
        let root = std::env::temp_dir().join(format!(
            "swh-save-copy-crlf-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("mirror.hosts");
        let path_str = path.to_string_lossy().into_owned();

        // First write stores LF; a later CRLF payload with the same
        // logical content must be treated as identical and not rewrite.
        write_save_copy(&path_str, "line1\r\nline2\r\n").expect("first write");
        let mtime_after_first = std::fs::metadata(&path).expect("stat").modified().unwrap();

        write_save_copy(&path_str, "line1\r\nline2\r\n").expect("second write (noop)");
        let mtime_after_second = std::fs::metadata(&path).expect("stat").modified().unwrap();

        assert_eq!(std::fs::read_to_string(&path).expect("read"), "line1\nline2\n");
        assert_eq!(mtime_after_first, mtime_after_second, "mtime must not change on identical content");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn write_save_copy_overwrites_different_content() {
        let root = std::env::temp_dir().join(format!(
            "swh-save-copy-diff-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("mirror.hosts");
        let path_str = path.to_string_lossy().into_owned();

        write_save_copy(&path_str, "old content\n").expect("first write");
        write_save_copy(&path_str, "new content\n").expect("overwrite");

        assert_eq!(std::fs::read_to_string(&path).expect("read"), "new content\n");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn part_file_staging_preserves_binary_and_cleans_up() {
        let root = std::env::temp_dir().join(format!(
            "swh-save-bytes-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let target = root.join("nested").join("installer.7z.exe");
        let part = part_of(&target);
        let payload: Vec<u8> = (0u8..=255).cycle().take(1024 * 64).collect();

        // 旧目标文件存在时，.part 完成后应原子替换且不残留 .part。
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"old").unwrap();

        let mut file = open_part_file(&target).expect("open part");
        let written = std::io::Write::write_all(&mut file, &payload);
        assert!(written.is_ok());
        {
            use std::io::Write;
            file.flush().unwrap();
        }
        drop(file);

        finalize_part_file(&part, &target).expect("finalize");

        assert_eq!(std::fs::read(&target).expect("read target"), payload);
        assert!(!part.exists(), "part file must not remain");
        assert!(
            std::fs::metadata(&target).unwrap().len() == payload.len() as u64,
            "old content must be fully replaced"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn copy_file_download_stages_and_replaces() {
        let root = std::env::temp_dir().join(format!(
            "swh-copy-dl-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("src.bin");
        let dst = root.join("sub").join("dst.bin");
        let payload: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
        std::fs::write(&src, &payload).unwrap();

        copy_file_download(&src, &dst).expect("copy file download");

        assert_eq!(std::fs::read(&dst).unwrap(), payload);
        assert!(!dst.with_file_name("dst.bin.part").exists());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn write_save_copy_reports_failure_on_invalid_path() {
        // A path whose parent is an existing *file* cannot be created.
        let root = std::env::temp_dir().join(format!(
            "swh-save-copy-fail-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let blocker = root.join("blocker");
        std::fs::write(&blocker, "i am a file").expect("write blocker");
        let bad_path = blocker.join("mirror.hosts");
        let bad = bad_path.to_string_lossy().into_owned();

        assert!(write_save_copy(&bad, "content").is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn next_due_wait_ms_tracks_earliest_due_event() {
        let now: i64 = 10_000_000;
        // r1: 10s interval, refreshed 5s ago → due in 5s.
        // r2: 60s interval, refreshed 40s ago → due in 20s.
        // r3: 10s interval, never refreshed → due now.
        let nodes = json!([
            {
                "id": "r1", "type": "remote", "on": true, "url": "https://example.com/a",
                "refresh_interval": 10, "last_refresh_ms": now - 5_000,
            },
            {
                "id": "r2", "type": "remote", "on": true, "url": "https://example.com/b",
                "refresh_interval": 60, "last_refresh_ms": now - 40_000,
            },
            {
                "id": "r3", "type": "remote", "on": true, "url": "https://example.com/c",
                "refresh_interval": 10, "last_refresh_ms": 0,
            },
        ])
        .as_array()
        .cloned()
        .unwrap();
        assert_eq!(next_due_wait_ms(&nodes, now), Some(0));

        // Drop the "due now" node: the earliest remaining is r1 at 5s.
        let nodes = json!([
            {
                "id": "r1", "type": "remote", "on": true, "url": "https://example.com/a",
                "refresh_interval": 10, "last_refresh_ms": now - 5_000,
            },
            {
                "id": "r2", "type": "remote", "on": true, "url": "https://example.com/b",
                "refresh_interval": 60, "last_refresh_ms": now - 40_000,
            },
        ])
        .as_array()
        .cloned()
        .unwrap();
        assert_eq!(next_due_wait_ms(&nodes, now), Some(5_000));
    }

    #[test]
    fn next_due_wait_ms_skips_disabled_and_unusable_nodes() {
        let now: i64 = 10_000_000;
        let nodes = json!([
            // interval 0 → never auto-refresh.
            {
                "id": "off", "type": "remote", "on": true, "url": "https://example.com/off",
                "refresh_interval": 0, "last_refresh_ms": now - 100_000,
            },
            // switch off → excluded from the wake computation entirely.
            {
                "id": "switched-off", "type": "remote", "on": false, "url": "https://example.com/x",
                "refresh_interval": 10, "last_refresh_ms": now - 100_000,
            },
            // no id-less / non-remote nodes are walked at all.
            {
                "id": "local", "type": "local", "url": "https://example.com/x",
                "refresh_interval": 10, "last_refresh_ms": now - 100_000,
            },
            // bad scheme is not refreshable by the scanner.
            {
                "id": "ftp", "type": "remote", "on": true, "url": "ftp://example.com/x",
                "refresh_interval": 10, "last_refresh_ms": now - 100_000,
            },
        ])
        .as_array()
        .cloned()
        .unwrap();
        assert_eq!(next_due_wait_ms(&nodes, now), None);
        assert_eq!(next_due_wait_ms(&[], now), None);
    }

    #[test]
    fn scan_delay_from_wait_clamps_to_floor_and_cap() {
        assert_eq!(scan_delay_from_wait(None), SCAN_INTERVAL);
        assert_eq!(scan_delay_from_wait(Some(0)), SCAN_MIN_WAKE);
        assert_eq!(scan_delay_from_wait(Some(-5_000)), SCAN_MIN_WAKE);
        assert_eq!(scan_delay_from_wait(Some(5_000)), SCAN_MIN_WAKE);
        assert_eq!(scan_delay_from_wait(Some(30_000)), Duration::from_secs(30));
        assert_eq!(scan_delay_from_wait(Some(120_000)), SCAN_INTERVAL);
    }
}
