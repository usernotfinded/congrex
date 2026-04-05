use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
const IO_DRAIN_TIMEOUT_MS: u64 = 2_000;
const EXEC_TIMEOUT_EXIT_CODE: i32 = 124;

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
    EditFile(EditFileParams),
    ExecuteCommand(ExecuteCommandParams),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditFileParams {
    file_path: String,
    search: String,
    replace: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecuteCommandParams {
    command: Vec<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: &'static str,
    message: String,
}

#[derive(Debug, Default)]
struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Debug)]
struct CommandResult {
    exit_code: i32,
    stdout: Captured,
    stderr: Captured,
    timed_out: bool,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let allowed_root = std::env::current_dir()
        .context("failed to get current directory")?
        .canonicalize()
        .context("failed to canonicalize current directory")?;
    log_stderr(
        "startup",
        &format!("allowed_root={}", allowed_root.display()),
    );

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                write_response(
                    &mut writer,
                    Response::error(None, "invalid_request", format!("stdin read error: {err}")),
                )?;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let response = handle_line(&line, &allowed_root).await;
        write_response(&mut writer, response)?;
    }

    Ok(())
}

async fn handle_line(line: &str, allowed_root: &Path) -> Response {
    let mut value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            return Response::error(None, "invalid_request", format!("invalid JSON: {err}"));
        }
    };
    let id = value.get("id").cloned();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("id");
    }
    let request: Request = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(err) => {
            return Response::error(id, "invalid_request", format!("invalid request: {err}"));
        }
    };

    let result = match request {
        Request::EditFile(params) => edit_file(params, allowed_root),
        Request::ExecuteCommand(params) => execute_command(params, allowed_root).await,
    };

    match result {
        Ok(result) => Response::ok(id, result),
        Err(error) => Response::from_error(id, error),
    }
}

fn edit_file(params: EditFileParams, allowed_root: &Path) -> std::result::Result<Value, RpcError> {
    validate_text("file_path", &params.file_path, false)?;
    validate_text("search", &params.search, true)?;
    validate_text("replace", &params.replace, true)?;
    if params.search.is_empty() {
        return Err(RpcError::invalid("search must not be empty"));
    }

    let path = resolve_existing_file(allowed_root, &params.file_path)
        .map_err(|err| RpcError::invalid(err.to_string()))?;
    let original = fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))
        .map_err(RpcError::internal)?;

    let (start, end) = find_unique_match(&original, &params.search)
        .map_err(|err| RpcError::invalid(err.to_string()))?;

    let mut updated = String::with_capacity(
        original.len().saturating_sub(end.saturating_sub(start)) + params.replace.len(),
    );
    updated.push_str(&original[..start]);
    updated.push_str(&params.replace);
    updated.push_str(&original[end..]);

    atomic_write(&path, updated.as_bytes()).map_err(RpcError::internal)?;
    log_stderr(
        "edit_file",
        &format!("path={} bytes_written={}", path.display(), updated.len()),
    );

    Ok(json!({
        "real_path": path.display().to_string(),
        "bytes_written": updated.len()
    }))
}

async fn execute_command(
    params: ExecuteCommandParams,
    allowed_root: &Path,
) -> std::result::Result<Value, RpcError> {
    if params.command.is_empty() {
        return Err(RpcError::invalid("command must not be empty"));
    }
    for arg in &params.command {
        validate_text("command argument", arg, false)?;
    }
    if let Some(cwd) = &params.cwd {
        validate_text("cwd", cwd, false)?;
    }

    let timeout_ms = params.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if timeout_ms == 0 || timeout_ms > MAX_TIMEOUT_MS {
        return Err(RpcError::invalid(format!(
            "timeout_ms must be between 1 and {MAX_TIMEOUT_MS}"
        )));
    }
    if let Some(reason) = blocked_command_reason(&params.command) {
        return Err(RpcError::unsafe_command(reason));
    }

    let cwd = resolve_directory(allowed_root, params.cwd.as_deref().unwrap_or("."))
        .map_err(|err| RpcError::invalid(err.to_string()))?;
    log_stderr(
        "execute_command",
        &format!("cwd={} command={:?}", cwd.display(), params.command),
    );

    let started = Instant::now();
    let mut command = Command::new(&params.command[0]);
    command
        .args(&params.command[1..])
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("TERM", "dumb")
        .env("NO_COLOR", "1");

    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| set_process_group());
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn {:?}", params.command))
        .map_err(RpcError::exec_failed)?;

    let output = capture_child(&mut child, Duration::from_millis(timeout_ms))
        .await
        .map_err(|err| RpcError::exec_failed(err.into()))?;

    Ok(json!({
        "exit_code": output.exit_code,
        "stdout": sanitize_output(&output.stdout.bytes),
        "stderr": sanitize_output(&output.stderr.bytes),
        "timed_out": output.timed_out,
        "stdout_truncated": output.stdout.truncated,
        "stderr_truncated": output.stderr.truncated,
        "duration_ms": started.elapsed().as_millis()
    }))
}

async fn capture_child(child: &mut Child, timeout: Duration) -> io::Result<CommandResult> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("stdout pipe unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("stderr pipe unavailable"))?;

    let mut stdout_task = tokio::spawn(read_capped(BufReader::new(stdout), MAX_OUTPUT_BYTES));
    let mut stderr_task = tokio::spawn(read_capped(BufReader::new(stderr), MAX_OUTPUT_BYTES));

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    let (exit_code, timed_out) = tokio::select! {
        status = child.wait() => {
            let status = status?;
            (status.code().unwrap_or(-1), false)
        }
        _ = &mut deadline => {
            kill_process_tree(child);
            (EXEC_TIMEOUT_EXIT_CODE, true)
        }
    };

    let stdout = join_capture(&mut stdout_task).await?;
    let stderr = join_capture(&mut stderr_task).await?;

    Ok(CommandResult {
        exit_code,
        stdout,
        stderr,
        timed_out,
    })
}

async fn read_capped<R: AsyncRead + Unpin>(mut reader: R, cap: usize) -> io::Result<Captured> {
    let mut buf = Vec::with_capacity(cap.min(8192));
    let mut tmp = [0u8; 8192];
    let mut truncated = false;

    loop {
        let n = reader.read(&mut tmp).await?;
        if n == 0 {
            break;
        }

        if buf.len() < cap {
            let remaining = cap - buf.len();
            let take = remaining.min(n);
            buf.extend_from_slice(&tmp[..take]);
            if take < n {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }

    Ok(Captured {
        bytes: buf,
        truncated,
    })
}

async fn join_capture(handle: &mut JoinHandle<io::Result<Captured>>) -> io::Result<Captured> {
    match tokio::time::timeout(Duration::from_millis(IO_DRAIN_TIMEOUT_MS), &mut *handle).await {
        Ok(joined) => match joined {
            Ok(result) => result,
            Err(err) => Err(io::Error::other(err)),
        },
        Err(_) => {
            handle.abort();
            Ok(Captured::default())
        }
    }
}

fn resolve_existing_file(root: &Path, raw: &str) -> Result<PathBuf> {
    let candidate = make_path(root, raw);
    let real = candidate
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", candidate.display()))?;
    if !real.starts_with(root) {
        bail!("path escapes current working directory");
    }
    if !real.is_file() {
        bail!("path is not an existing file");
    }
    Ok(real)
}

fn resolve_directory(root: &Path, raw: &str) -> Result<PathBuf> {
    let candidate = make_path(root, raw);
    let real = candidate
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", candidate.display()))?;
    if !real.starts_with(root) {
        bail!("cwd escapes current working directory");
    }
    if !real.is_dir() {
        bail!("cwd is not a directory");
    }
    Ok(real)
}

fn make_path(root: &Path, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn find_unique_match(haystack: &str, needle: &str) -> Result<(usize, usize)> {
    let mut found = None;
    let mut offset = 0usize;

    while let Some(pos) = haystack[offset..].find(needle) {
        let start = offset + pos;
        if found.is_some() {
            bail!("search string is not unique");
        }
        found = Some((start, start + needle.len()));
        offset = start + 1;
    }

    found.ok_or_else(|| anyhow!("search string not found"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("path has no parent directory")?;
    let temp = parent.join(format!(
        ".congrex-executor-{}-{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let permissions = fs::metadata(path)?.permissions();

    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .with_context(|| format!("failed to create {}", temp.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::set_permissions(&temp, permissions)?;

        #[cfg(not(windows))]
        {
            fs::rename(&temp, path)?;
        }
        #[cfg(windows)]
        {
            if fs::rename(&temp, path).is_err() {
                let _ = fs::remove_file(path);
                fs::rename(&temp, path)?;
            }
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// [P2 FIX] Comprehensive command denylist — defense-in-depth alongside the
/// TypeScript-side validation. Both layers must pass before a command runs.
///
/// Categories:
///   1. Privilege escalation (sudo, su, doas, pkexec)
///   2. Interactive shells (bash, sh, zsh, cmd, powershell, etc.)
///   3. Remote access / exfiltration (ssh, scp, curl, wget, nc, etc.)
///   4. System / disk management (dd, mkfs, systemctl, shutdown, etc.)
///   5. Container / VM (docker, kubectl, podman)
///   6. macOS automation (osascript, automator)
///   7. Package managers (apt, brew, pip, cargo install, etc.)
///   8. Credential access (security, keychain, gpg)
///   9. Interpreter inline eval (-c, -e, -p)
///  10. Destructive filesystem ops (rm -rf, find -delete, etc.)
///  11. Destructive git operations (push, clean, reset, etc.)
///  12. Shell operators in arguments (pipes, redirects, chaining)
fn blocked_command_reason(command: &[String]) -> Option<String> {
    let program = program_name(command.first()?);
    let args = &command[1..];

    // ── Category 1-2: Privilege escalation + shells ──
    if matches!(
        program.as_str(),
        "sudo" | "su" | "doas" | "pkexec" | "runas"
            | "bash" | "sh" | "zsh" | "fish" | "csh" | "tcsh" | "ksh" | "dash"
            | "cmd" | "powershell" | "pwsh"
    ) {
        return Some(format!("program '{program}' is blocked (shell or privilege escalation)"));
    }

    // ── Category 1b: Execution wrappers that bypass denylists ──
    if matches!(
        program.as_str(),
        "nohup" | "env" | "xargs" | "nice" | "ionice" | "timeout" | "stdbuf"
            | "setsid" | "start" | "open" | "xdg-open"
    ) {
        return Some(format!("program '{program}' is blocked (execution wrapper / launcher)"));
    }

    // ── Category 1c: Background / scheduling / multiplexing ──
    if matches!(
        program.as_str(),
        "screen" | "tmux" | "at" | "batch" | "crontab" | "nq"
    ) {
        return Some(format!("program '{program}' is blocked (background/scheduling)"));
    }

    // ── Category 3: Remote access / data exfiltration ──
    if matches!(
        program.as_str(),
        "ssh" | "scp" | "sftp" | "rsync" | "telnet" | "ftp"
            | "nc" | "ncat" | "netcat" | "socat"
            | "curl" | "wget" | "httpie"
    ) {
        return Some(format!("program '{program}' is blocked (network/remote access)"));
    }

    // ── Category 4: System management / disk ──
    if matches!(
        program.as_str(),
        "dd" | "mkfs" | "fdisk" | "parted" | "diskutil" | "format"
            | "systemctl" | "service" | "launchctl"
            | "shutdown" | "reboot" | "halt" | "init"
    ) {
        return Some(format!("program '{program}' is blocked (system/disk management)"));
    }

    // ── Category 5: Container / VM ──
    if matches!(
        program.as_str(),
        "docker" | "podman" | "kubectl" | "vagrant" | "virsh"
    ) {
        return Some(format!("program '{program}' is blocked (container/VM)"));
    }

    // ── Category 6: macOS automation ──
    if matches!(program.as_str(), "osascript" | "automator") {
        return Some(format!("program '{program}' is blocked (macOS automation)"));
    }

    // ── Category 7: Package managers ──
    if matches!(
        program.as_str(),
        "apt" | "apt-get" | "yum" | "dnf" | "pacman" | "brew"
            | "pip" | "pip3" | "gem" | "cargo" | "go"
    ) {
        return Some(format!("program '{program}' is blocked (package manager)"));
    }

    // ── Category 8: Credential access ──
    if matches!(
        program.as_str(),
        "security" | "keychain" | "pass" | "gpg"
    ) {
        return Some(format!("program '{program}' is blocked (credential access)"));
    }

    // ── Category 9: Interpreter inline eval ──
    if matches!(
        program.as_str(),
        "python" | "python3" | "node" | "deno" | "ruby" | "perl" | "php" | "lua"
            | "gcc" | "g++" | "clang" | "clang++" | "cc" | "c++"
    ) {
        if matches!(program.as_str(), "gcc" | "g++" | "clang" | "clang++" | "cc" | "c++") {
            return Some(format!("program '{program}' is blocked (compiler as code execution vector)"));
        }
        if args
            .iter()
            .any(|arg| matches!(arg.as_str(), "-c" | "-e" | "-p" | "--eval" | "--print"))
        {
            return Some(format!("inline eval flags for '{program}' are blocked"));
        }
    }

    // ── Category 10: Destructive filesystem ops ──
    if program == "rm" && rm_has_force_and_recursive(args) {
        return Some("rm with both recursive and force flags is blocked".to_string());
    }
    if program == "find"
        && args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir"
            )
        })
    {
        return Some("find with mutation actions (-delete, -exec) is blocked".to_string());
    }
    if program == "chmod" || program == "chown" || program == "chgrp" {
        return Some(format!("program '{program}' is blocked (permission changes)"));
    }

    // ── Category 11: Destructive git operations ──
    if program == "git" {
        if let Some(subcmd) = args.first() {
            let sub = subcmd.to_ascii_lowercase();
            if matches!(
                sub.as_str(),
                "push" | "clean" | "reset" | "rebase" | "merge" | "cherry-pick"
                    | "rm" | "mv" | "remote" | "config" | "filter-branch"
            ) {
                return Some(format!("'git {sub}' is blocked (destructive git operation)"));
            }
        }
    }

    // ── Category 12: Shell operators in arguments ──
    for arg in args {
        for ch in ['|', ';', '&', '`', '$'] {
            if arg.contains(ch) {
                return Some(format!(
                    "argument contains shell operator '{ch}' — use argv-form only"
                ));
            }
        }
        if arg.contains(">>") || (arg.starts_with('>') && arg.len() > 1) {
            return Some("argument contains shell redirection — use argv-form only".to_string());
        }
    }

    None
}

fn program_name(raw: &str) -> String {
    let raw = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(raw)
        .to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stripped) = raw.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    raw
}

fn rm_has_force_and_recursive(args: &[String]) -> bool {
    let mut has_f = false;
    let mut has_r = false;
    for arg in args {
        if !arg.starts_with('-') {
            continue;
        }
        has_f |= arg.contains('f');
        has_r |= arg.contains('r') || arg.contains('R');
    }
    has_f && has_r
}

fn validate_text(
    label: &str,
    value: &str,
    allow_layout: bool,
) -> std::result::Result<(), RpcError> {
    for ch in value.chars() {
        if ch == '\u{1b}' {
            return Err(RpcError::invalid(format!(
                "{label} contains ANSI escape bytes"
            )));
        }
        if is_bidi_control(ch) {
            return Err(RpcError::invalid(format!(
                "{label} contains BiDi control characters"
            )));
        }
        if ch.is_control() && !(allow_layout && matches!(ch, '\n' | '\r' | '\t')) {
            return Err(RpcError::invalid(format!(
                "{label} contains hidden control characters"
            )));
        }
    }
    Ok(())
}

fn sanitize_output(bytes: &[u8]) -> String {
    let chars: Vec<char> = String::from_utf8_lossy(bytes).chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if ch == '\u{1b}' {
            i += 1;
            if i >= chars.len() {
                break;
            }
            match chars[i] {
                '[' => {
                    i += 1;
                    while i < chars.len() {
                        let c = chars[i];
                        i += 1;
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                ']' => {
                    i += 1;
                    while i < chars.len() {
                        if chars[i] == '\u{7}' {
                            i += 1;
                            break;
                        }
                        if chars[i] == '\u{1b}' && i + 1 < chars.len() && chars[i + 1] == '\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => i += 1,
            }
            continue;
        }

        if is_bidi_control(ch) || (ch.is_control() && !matches!(ch, '\n' | '\r' | '\t')) {
            i += 1;
            continue;
        }

        out.push(ch);
        i += 1;
    }

    out
}

fn is_bidi_control(ch: char) -> bool {
    matches!(
        ch,
        '\u{061C}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'
            | '\u{202B}'
            | '\u{202C}'
            | '\u{202D}'
            | '\u{202E}'
            | '\u{2066}'
            | '\u{2067}'
            | '\u{2068}'
            | '\u{2069}'
    )
}

fn write_response(writer: &mut BufWriter<impl Write>, response: Response) -> Result<()> {
    serde_json::to_writer(&mut *writer, &response)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn log_stderr(action: &str, message: &str) {
    let _ = writeln!(
        io::stderr().lock(),
        "[{}] {} {}",
        now_millis(),
        action,
        message
    );
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl Response {
    fn ok(id: Option<Value>, result: Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Option<Value>, code: &'static str, message: String) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(RpcError { code, message }),
        }
    }

    fn from_error(id: Option<Value>, error: RpcError) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

impl RpcError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_params",
            message: message.into(),
        }
    }

    fn unsafe_command(message: impl Into<String>) -> Self {
        Self {
            code: "unsafe_command",
            message: message.into(),
        }
    }

    fn internal(err: anyhow::Error) -> Self {
        Self {
            code: "internal_error",
            message: err.to_string(),
        }
    }

    fn exec_failed(err: anyhow::Error) -> Self {
        Self {
            code: "exec_failed",
            message: err.to_string(),
        }
    }
}

#[cfg(unix)]
fn set_process_group() -> io::Result<()> {
    unsafe extern "C" {
        fn setpgid(pid: i32, pgid: i32) -> i32;
    }
    if unsafe { setpgid(0, 0) } == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn set_process_group() -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn kill_process_tree(child: &mut Child) {
    unsafe extern "C" {
        fn getpgid(pid: i32) -> i32;
        fn killpg(pgid: i32, sig: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    if let Some(pid) = child.id() {
        let pgid = unsafe { getpgid(pid as i32) };
        if pgid != -1 {
            let _ = unsafe { killpg(pgid, SIGKILL) };
        }
    }
    let _ = child.start_kill();
}

#[cfg(windows)]
fn kill_process_tree(child: &mut Child) {
    let _ = child.start_kill();
}
