use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::Result;
use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

use crate::{
    cache::MemoryFactCache,
    cancel::CancelToken,
    engine::Engine,
    json::parse_unique_json,
    limits::{MAX_ASSESSMENT_BYTES, MAX_FRAME_BYTES},
    protocol::asp::{self, AspHost, AspSession, ProviderProfile, RpcFailure},
};

type PendingResponse = oneshot::Sender<Result<Value, RpcFailure>>;

enum Lifecycle {
    Fresh,
    AwaitingInitialized {
        baseline: Value,
    },
    Active(AspSession),
    Failed {
        error: RpcFailure,
        grant_accepted: bool,
    },
    ShuttingDown,
}

#[derive(Clone)]
struct HostClient {
    outbound: mpsc::Sender<Value>,
    pending: Arc<Mutex<HashMap<String, PendingResponse>>>,
    next_id: Arc<AtomicU64>,
}

#[async_trait]
impl AspHost for HostClient {
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        cancel: &CancelToken,
    ) -> Result<Value, RpcFailure> {
        let id = format!("opcore:{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let pending_key = id_key(&Value::String(id.clone()));
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().insert(pending_key.clone(), sender);
        if self
            .outbound
            .send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await
            .is_err()
        {
            self.pending.lock().remove(&pending_key);
            return Err(RpcFailure::unavailable(
                "stdio writer closed during host callback",
            ));
        }
        tokio::select! {
            response = receiver => match response {
                Ok(result) => result,
                Err(_) => Err(RpcFailure::unavailable("host callback response channel closed")),
            },
            () = cancel.cancelled() => {
                self.pending.lock().remove(&pending_key);
                Err(RpcFailure::cancelled())
            },
            () = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                self.pending.lock().remove(&pending_key);
                Err(RpcFailure::unavailable(format!("host callback {method} timed out")))
            }
        }
    }
}

/// Runs the bounded ASP JSON-RPC lifecycle over standard input and output.
///
/// # Errors
///
/// Returns an error for transport failures, oversized output, writer failure, or EOF before the
/// required `exit` notification.
pub async fn serve_stdio() -> Result<()> {
    serve_stdio_profile(ProviderProfile::Fast).await
}

/// Runs one selected bundled ASP provider over standard input and output.
///
/// # Errors
///
/// Returns an error for transport failures, oversized output, writer failure, or EOF before the
/// required `exit` notification.
pub async fn serve_stdio_profile(profile: ProviderProfile) -> Result<()> {
    serve_stdio_profile_at(profile, None).await
}

/// Runs one selected provider with a private host-supplied project path.
///
/// # Errors
///
/// Returns an error when the project path is invalid or the stdio provider lifecycle fails.
pub async fn serve_stdio_profile_at(
    profile: ProviderProfile,
    project_root: Option<String>,
) -> Result<()> {
    let project_root = project_root
        .map(|path| crate::path::RepoPath::from_protocol(&path))
        .transpose()?;
    let (outbound, outbound_rx) = mpsc::channel::<Value>(128);
    let writer = tokio::spawn(write_messages(outbound_rx));
    let server = Server::new(outbound, profile, project_root);
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut frame = Vec::new();
    let exit = serve_frames(&server, &mut stdin, &mut frame).await;
    server.cancel_all();
    server.pending.lock().clear();
    drop(server);
    writer.await??;
    match exit {
        Some(true) => Ok(()),
        Some(false) => anyhow::bail!("ASP exit notification arrived before shutdown"),
        None => anyhow::bail!("ASP stdio closed before exit notification"),
    }
}

async fn write_messages(mut messages: mpsc::Receiver<Value>) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    while let Some(message) = messages.recv().await {
        let bytes = bounded_message_bytes(&message)?;
        stdout.write_all(&bytes).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}

fn bounded_message_bytes(message: &Value) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() <= MAX_ASSESSMENT_BYTES {
        return Ok(bytes);
    }
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    Ok(serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": id,
        "error": { "code": -32010, "message": "provider-error", "data": {
            "failClass": "health", "retryable": false,
            "detail": "response exceeded the hard output bound"
        }}
    }))?)
}

type ActiveRequests = Arc<Mutex<HashMap<String, CancelToken>>>;

enum Admission {
    Accepted,
    Duplicate,
    Busy,
}

struct Server {
    outbound: mpsc::Sender<Value>,
    lifecycle: Arc<Mutex<Lifecycle>>,
    pending: Arc<Mutex<HashMap<String, PendingResponse>>>,
    active: ActiveRequests,
    host: HostClient,
    engine: Arc<Engine>,
    profile: ProviderProfile,
    project_root: Option<crate::path::RepoPath>,
}

impl Server {
    fn new(
        outbound: mpsc::Sender<Value>,
        profile: ProviderProfile,
        project_root: Option<crate::path::RepoPath>,
    ) -> Self {
        let pending = Arc::new(Mutex::new(HashMap::<String, PendingResponse>::new()));
        let host = HostClient {
            outbound: outbound.clone(),
            pending: Arc::clone(&pending),
            next_id: Arc::new(AtomicU64::new(1)),
        };
        Self {
            outbound,
            lifecycle: Arc::new(Mutex::new(Lifecycle::Fresh)),
            pending,
            active: Arc::new(Mutex::new(HashMap::new())),
            host,
            engine: Arc::new(Engine::with_cache(Arc::new(MemoryFactCache::new()))),
            profile,
            project_root,
        }
    }

    async fn route(&self, incoming: Incoming) -> Option<bool> {
        match incoming {
            Incoming::Callback(object) => {
                route_callback_response(&object, &self.pending);
                None
            }
            Incoming::Request { method, params, id } => {
                self.route_request(&method, params, id).await;
                None
            }
            Incoming::Notification { method, params } => self.route_notification(&method, &params),
        }
    }

    async fn route_request(&self, method: &str, params: Value, id: Value) {
        match method {
            "initialize" => self.initialize(params, id).await,
            "check/evaluate" => self.evaluate(params, id).await,
            "shutdown" => self.shutdown(id).await,
            _ => {
                self.send_error(ErrorResponse::method_not_found(id, method))
                    .await;
            }
        }
    }

    fn route_notification(&self, method: &str, params: &Value) -> Option<bool> {
        match method {
            "initialized" => self.initialized(params),
            "workspace/baselineChanged" => self.baseline_changed(params),
            "$/cancelRequest" => self.cancel_request(params),
            "exit" => {
                return Some(matches!(*self.lifecycle.lock(), Lifecycle::ShuttingDown));
            }
            _ => {}
        }
        None
    }

    async fn initialize(&self, params: Value, id: Value) {
        if !valid_id(&id) {
            self.send_error(ErrorResponse::invalid_id()).await;
            return;
        }
        let response = initialize_state(&mut self.lifecycle.lock(), &params, self.profile);
        send_result(&self.outbound, id, response).await;
    }

    async fn evaluate(&self, params: Value, id: Value) {
        if !valid_id(&id) {
            self.send_error(ErrorResponse::invalid_id()).await;
            return;
        }
        let key = id_key(&id);
        let session = active_session(&self.lifecycle.lock());
        let Ok(session) = session else {
            send_result(&self.outbound, id, session.map(|_| Value::Null)).await;
            return;
        };
        let cancel = CancelToken::new();
        let admission = {
            let mut active = self.active.lock();
            if active.contains_key(&key) {
                Admission::Duplicate
            } else if !active.is_empty() {
                Admission::Busy
            } else {
                active.insert(key.clone(), cancel.clone());
                Admission::Accepted
            }
        };
        match admission {
            Admission::Duplicate => {
                self.send_error(ErrorResponse::duplicate_id(id)).await;
                return;
            }
            Admission::Busy => {
                send_result(
                    &self.outbound,
                    id,
                    Err(RpcFailure::unavailable(
                        "provider is already evaluating another request",
                    )),
                )
                .await;
                return;
            }
            Admission::Accepted => {}
        }
        self.spawn_evaluation(params, id, key, session, cancel);
    }

    fn spawn_evaluation(
        &self,
        params: Value,
        id: Value,
        key: String,
        session: AspSession,
        cancel: CancelToken,
    ) {
        let outbound = self.outbound.clone();
        let active = Arc::clone(&self.active);
        let host = self.host.clone();
        let engine = Arc::clone(&self.engine);
        let profile = self.profile;
        let project_root = self.project_root.clone();
        tokio::spawn(async move {
            let result = asp::evaluate_for(
                params,
                session,
                profile,
                asp::EvaluationRuntime {
                    host: &host,
                    engine: &engine,
                    cancel,
                    project_root,
                },
            )
            .await;
            active.lock().remove(&key);
            send_result(&outbound, id, result).await;
        });
    }

    async fn shutdown(&self, id: Value) {
        if !valid_id(&id) {
            self.send_error(ErrorResponse::invalid_id()).await;
            return;
        }
        if matches!(*self.lifecycle.lock(), Lifecycle::ShuttingDown) {
            send_result(
                &self.outbound,
                id,
                Err(RpcFailure::input("shutdown may be called exactly once")),
            )
            .await;
            return;
        }
        *self.lifecycle.lock() = Lifecycle::ShuttingDown;
        self.cancel_all();
        wait_for_active(&self.active).await;
        let _ = self
            .outbound
            .send(json!({ "jsonrpc": "2.0", "id": id, "result": null }))
            .await;
    }

    fn initialized(&self, params: &Value) {
        let mut lifecycle = self.lifecycle.lock();
        let result = initialize_session(&mut lifecycle, params);
        if let Err(error) = result {
            fail_lifecycle(&mut lifecycle, error);
        }
    }

    fn baseline_changed(&self, params: &Value) {
        let result = if self.active.lock().is_empty() {
            asp::baseline_changed(params)
        } else {
            Err(RpcFailure::health(
                "baseline changed while evaluations were active",
            ))
        };
        update_baseline(&mut self.lifecycle.lock(), result);
    }

    fn cancel_request(&self, params: &Value) {
        if let Some(id) = params.get("id")
            && let Some(token) = self.active.lock().get(&id_key(id))
        {
            token.cancel();
        }
    }

    fn cancel_all(&self) {
        for token in self.active.lock().values() {
            token.cancel();
        }
    }

    async fn send_error(&self, error: ErrorResponse) {
        send_error(&self.outbound, error).await;
    }
}

async fn serve_frames<R: tokio::io::AsyncBufRead + Unpin>(
    server: &Server,
    reader: &mut R,
    frame: &mut Vec<u8>,
) -> Option<bool> {
    loop {
        match read_frame(reader, frame).await {
            Ok(false) => return None,
            Err(error) => {
                server.send_error(ErrorResponse::parse(error)).await;
                continue;
            }
            Ok(true) => {}
        }
        let incoming = match decode_incoming(frame) {
            Ok(incoming) => incoming,
            Err(error) => {
                server.send_error(error).await;
                continue;
            }
        };
        if let Some(clean) = server.route(incoming).await {
            return Some(clean);
        }
    }
}

enum Incoming {
    Callback(serde_json::Map<String, Value>),
    Request {
        method: String,
        params: Value,
        id: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

fn decode_incoming(frame: &[u8]) -> Result<Incoming, ErrorResponse> {
    let value =
        parse_unique_json(frame).map_err(|error| ErrorResponse::parse(error.to_string()))?;
    let object = value
        .as_object()
        .cloned()
        .ok_or_else(ErrorResponse::non_object)?;
    validate_jsonrpc(&object)?;
    let Some(method) = incoming_method(&object)? else {
        return Ok(Incoming::Callback(object));
    };
    validate_call_fields(&object)?;
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    Ok(incoming_call(&object, method, params))
}

fn incoming_method(
    object: &serde_json::Map<String, Value>,
) -> Result<Option<String>, ErrorResponse> {
    object.get("method").map_or(Ok(None), |method| {
        method
            .as_str()
            .map(str::to_owned)
            .map(Some)
            .ok_or_else(|| ErrorResponse::invalid_method(object))
    })
}

fn validate_call_fields(object: &serde_json::Map<String, Value>) -> Result<(), ErrorResponse> {
    if let Some(id) = object.get("id")
        && !valid_id(id)
    {
        return Err(ErrorResponse::invalid_id());
    }
    if object
        .get("params")
        .is_some_and(|params| !params.is_object() && !params.is_array())
    {
        let id = object.get("id").cloned().unwrap_or(Value::Null);
        return Err(ErrorResponse::invalid_request(
            id,
            "params must be an object or array",
        ));
    }
    Ok(())
}

fn incoming_call(
    object: &serde_json::Map<String, Value>,
    method: String,
    params: Value,
) -> Incoming {
    match object.get("id").cloned() {
        Some(id) => Incoming::Request { method, params, id },
        None => Incoming::Notification { method, params },
    }
}

fn validate_jsonrpc(object: &serde_json::Map<String, Value>) -> Result<(), ErrorResponse> {
    if object.get("jsonrpc").and_then(Value::as_str) == Some("2.0") {
        return Ok(());
    }
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    Err(ErrorResponse::invalid_request(id, "jsonrpc must equal 2.0"))
}

fn initialize_state(
    state: &mut Lifecycle,
    params: &Value,
    profile: ProviderProfile,
) -> Result<Value, RpcFailure> {
    if !matches!(state, Lifecycle::Fresh) {
        return Err(RpcFailure::input("initialize may be called exactly once"));
    }
    let (result, baseline) = asp::initialize_for(params, profile)?;
    *state = Lifecycle::AwaitingInitialized { baseline };
    Ok(result)
}

fn active_session(state: &Lifecycle) -> Result<AspSession, RpcFailure> {
    match state {
        Lifecycle::Active(session) => Ok(session.clone()),
        Lifecycle::Failed {
            error,
            grant_accepted: true,
        } => Err(error.clone()),
        Lifecycle::ShuttingDown => Err(RpcFailure::unavailable("provider is shutting down")),
        _ => Err(RpcFailure::provider_not_initialized()),
    }
}

fn initialize_session(state: &mut Lifecycle, params: &Value) -> Result<(), RpcFailure> {
    let session = match state {
        Lifecycle::AwaitingInitialized { baseline } => asp::initialized(params, baseline)?,
        _ => {
            return Err(RpcFailure::input(
                "initialized notification is out of order",
            ));
        }
    };
    *state = Lifecycle::Active(session);
    Ok(())
}

fn update_baseline(state: &mut Lifecycle, result: Result<Value, RpcFailure>) {
    match result {
        Ok(baseline) => match state {
            Lifecycle::Active(session) => session.baseline = baseline,
            _ => fail_lifecycle(
                state,
                RpcFailure::input("baselineChanged requires an active session"),
            ),
        },
        Err(error) => fail_lifecycle(state, error),
    }
}

fn fail_lifecycle(state: &mut Lifecycle, error: RpcFailure) {
    let grant_accepted = match state {
        Lifecycle::Active(_) => true,
        Lifecycle::Failed { grant_accepted, .. } => *grant_accepted,
        Lifecycle::Fresh | Lifecycle::AwaitingInitialized { .. } | Lifecycle::ShuttingDown => false,
    };
    *state = Lifecycle::Failed {
        error,
        grant_accepted,
    };
}

async fn wait_for_active(active: &ActiveRequests) {
    let deadline = Instant::now() + Duration::from_millis(500);
    while !active.lock().is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    frame: &mut Vec<u8>,
) -> Result<bool, String> {
    frame.clear();
    loop {
        let available = reader.fill_buf().await.map_err(|error| error.to_string())?;
        if available.is_empty() {
            return end_of_input(frame);
        }
        let take = line_prefix_len(available);
        let complete = available[..take].ends_with(b"\n");
        if frame.len().saturating_add(take) > MAX_FRAME_BYTES {
            reader.consume(take);
            if !complete {
                discard_to_newline(reader).await?;
            }
            frame.clear();
            return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
        }
        frame.extend_from_slice(&available[..take]);
        reader.consume(take);
        if complete {
            return finish_frame(frame);
        }
    }
}

fn end_of_input(frame: &mut Vec<u8>) -> Result<bool, String> {
    if frame.is_empty() {
        Ok(false)
    } else {
        frame.clear();
        Err("input ended before the JSON-RPC frame newline".into())
    }
}

fn line_prefix_len(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(bytes.len(), |index| index + 1)
}

async fn discard_to_newline<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<(), String> {
    loop {
        let available = reader.fill_buf().await.map_err(|error| error.to_string())?;
        if available.is_empty() {
            return Ok(());
        }
        let count = line_prefix_len(available);
        let ended = available[..count].ends_with(b"\n");
        reader.consume(count);
        if ended {
            return Ok(());
        }
    }
}

fn finish_frame(frame: &mut Vec<u8>) -> Result<bool, String> {
    frame.pop();
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
    if frame.is_empty() {
        Err("empty JSON-RPC frame".into())
    } else {
        Ok(true)
    }
}

fn route_callback_response(
    object: &serde_json::Map<String, Value>,
    pending: &Mutex<HashMap<String, PendingResponse>>,
) {
    let Some(id) = object.get("id") else { return };
    let Some(sender) = pending.lock().remove(&id_key(id)) else {
        return;
    };
    let result = match (object.get("result"), object.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => Err(callback_failure(error)),
        _ => Err(RpcFailure::contract(
            "host callback response must contain exactly one of result or error",
        )),
    };
    let _ = sender.send(result);
}

fn callback_failure(error: &Value) -> RpcFailure {
    parse_callback_failure(error).unwrap_or_else(malformed_callback_failure)
}

struct CallbackFailureEnvelope<'a> {
    code: i64,
    message: &'a str,
    data: &'a serde_json::Map<String, Value>,
}

fn callback_failure_envelope(error: &Value) -> Option<CallbackFailureEnvelope<'_>> {
    let object = error.as_object()?;
    let code = object.get("code").and_then(Value::as_i64)?;
    let message = object.get("message").and_then(Value::as_str)?;
    let data = object.get("data").and_then(Value::as_object)?;
    if data
        .keys()
        .any(|key| !matches!(key.as_str(), "failClass" | "retryable" | "detail"))
    {
        return None;
    }
    Some(CallbackFailureEnvelope {
        code,
        message,
        data,
    })
}

fn parse_callback_failure(error: &Value) -> Option<RpcFailure> {
    let envelope = callback_failure_envelope(error)?;
    let class = envelope.data.get("failClass").and_then(Value::as_str)?;
    let (message, fail_class) = callback_failure_class(class)?;
    Some(RpcFailure {
        code: envelope.code,
        message,
        fail_class,
        retryable: callback_retryable(envelope.data.get("retryable"))?,
        detail: callback_detail(envelope.data.get("detail"), envelope.message)?,
    })
}

fn callback_failure_class(class: &str) -> Option<(&'static str, &'static str)> {
    match class {
        "health" => Some(("host-callback-health", "health")),
        "contract" => Some(("host-callback-contract", "contract")),
        "policy" => Some(("host-callback-policy", "policy")),
        "input" => Some(("host-callback-input", "input")),
        _ => None,
    }
}

fn callback_retryable(value: Option<&Value>) -> Option<bool> {
    value.map_or(Some(false), Value::as_bool)
}

fn callback_detail(value: Option<&Value>, message: &str) -> Option<String> {
    value.map_or_else(
        || Some(message.to_owned()),
        |value| value.as_str().map(str::to_owned),
    )
}

fn malformed_callback_failure() -> RpcFailure {
    RpcFailure::contract("host callback returned a malformed ASP error")
}

async fn send_result(outbound: &mpsc::Sender<Value>, id: Value, result: Result<Value, RpcFailure>) {
    let message = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error.to_json() }),
    };
    let _ = outbound.send(message).await;
}

struct ErrorResponse {
    id: Value,
    code: i64,
    message: &'static str,
    fail_class: &'static str,
    retryable: bool,
    detail: String,
}

impl ErrorResponse {
    fn parse(detail: impl Into<String>) -> Self {
        Self {
            id: Value::Null,
            code: -32700,
            message: "parse-error",
            fail_class: "input",
            retryable: false,
            detail: detail.into(),
        }
    }

    fn invalid_request(id: Value, detail: impl Into<String>) -> Self {
        Self {
            id,
            code: -32600,
            message: "invalid-request",
            fail_class: "input",
            retryable: false,
            detail: detail.into(),
        }
    }

    fn non_object() -> Self {
        Self::invalid_request(Value::Null, "JSON-RPC frame must be an object")
    }

    fn invalid_method(object: &serde_json::Map<String, Value>) -> Self {
        let id = object.get("id").cloned().unwrap_or(Value::Null);
        Self::invalid_request(id, "method must be a string")
    }

    fn invalid_id() -> Self {
        Self::invalid_request(Value::Null, "request id must be a string or number")
    }

    fn duplicate_id(id: Value) -> Self {
        Self::invalid_request(id, "duplicate live request id")
    }

    fn method_not_found(id: Value, method: &str) -> Self {
        Self {
            id,
            code: -32601,
            message: "method-not-found",
            fail_class: "contract",
            retryable: false,
            detail: format!("unsupported method {method}"),
        }
    }
}

async fn send_error(outbound: &mpsc::Sender<Value>, error: ErrorResponse) {
    let _ = outbound
        .send(json!({
            "jsonrpc": "2.0", "id": error.id,
            "error": { "code": error.code, "message": error.message, "data": {
                "failClass": error.fail_class,
                "retryable": error.retryable,
                "detail": error.detail
            }}
        }))
        .await;
}

fn valid_id(id: &Value) -> bool {
    id.is_string() || id.as_i64().is_some() || id.as_u64().is_some()
}

fn id_key(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_require_newline_and_recover_after_oversize_input() {
        let mut partial = BufReader::new(&b"{}"[..]);
        assert!(read_frame(&mut partial, &mut Vec::new()).await.is_err());

        let mut bytes = vec![b' '; MAX_FRAME_BYTES + 1];
        bytes.extend_from_slice(b"\n{}\n");
        let mut input = BufReader::new(bytes.as_slice());
        let mut frame = Vec::new();
        assert!(read_frame(&mut input, &mut frame).await.is_err());
        assert!(read_frame(&mut input, &mut frame).await.unwrap());
        assert_eq!(frame, b"{}");
    }

    #[test]
    fn callback_failures_preserve_the_authoritative_fail_class() {
        for class in ["health", "contract", "policy", "input"] {
            let failure = callback_failure(&json!({
                "code": -32099,
                "message": "callback failed",
                "data": { "failClass": class, "retryable": true, "detail": "bounded detail" }
            }));
            assert_eq!(failure.fail_class, class);
            assert!(failure.retryable);
            assert_eq!(failure.code, -32099);
        }
    }

    #[test]
    fn malformed_callback_error_is_a_contract_failure() {
        let failure = callback_failure(&json!({
            "code": -32012,
            "message": "scope denied",
            "data": { "failClass": "unknown" }
        }));
        assert_eq!(failure.fail_class, "contract");
    }

    #[test]
    fn request_ids_reject_fractional_numbers() {
        assert!(valid_id(&json!(1)));
        assert!(valid_id(&json!("one")));
        assert!(!valid_id(&json!(1.5)));
        assert!(!valid_id(&Value::Null));
    }

    #[test]
    fn every_method_rejects_fractional_ids_and_scalar_params() {
        let fractional =
            decode_incoming(br#"{"jsonrpc":"2.0","id":1.5,"method":"unknown","params":{}}"#);
        assert!(matches!(fractional, Err(error) if error.code == -32600));

        let scalar =
            decode_incoming(br#"{"jsonrpc":"2.0","id":"one","method":"shutdown","params":false}"#);
        assert!(matches!(scalar, Err(error) if error.code == -32600));
    }
}
