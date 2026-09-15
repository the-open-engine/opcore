pub(super) fn is_pinned_builtin(specifier: &str) -> bool {
    let Some(module) = specifier.strip_prefix("node:") else {
        return false;
    };
    // Public built-in identifiers from Node v24.16.0; underscore-prefixed internals are excluded.
    matches!(
        module,
        "assert"
            | "assert/strict"
            | "async_hooks"
            | "buffer"
            | "child_process"
            | "cluster"
            | "console"
            | "constants"
            | "crypto"
            | "dgram"
            | "diagnostics_channel"
            | "dns"
            | "dns/promises"
            | "domain"
            | "events"
            | "fs"
            | "fs/promises"
            | "http"
            | "http2"
            | "https"
            | "inspector"
            | "inspector/promises"
            | "module"
            | "net"
            | "os"
            | "path"
            | "path/posix"
            | "path/win32"
            | "perf_hooks"
            | "process"
            | "punycode"
            | "querystring"
            | "readline"
            | "readline/promises"
            | "repl"
            | "sea"
            | "sqlite"
            | "stream"
            | "stream/consumers"
            | "stream/promises"
            | "stream/web"
            | "string_decoder"
            | "sys"
            | "test"
            | "test/reporters"
            | "timers"
            | "timers/promises"
            | "tls"
            | "trace_events"
            | "tty"
            | "url"
            | "util"
            | "util/types"
            | "v8"
            | "vm"
            | "wasi"
            | "worker_threads"
            | "zlib"
    )
}

#[cfg(test)]
mod tests {
    use super::is_pinned_builtin;

    #[test]
    fn accepts_only_explicit_pinned_names() {
        for specifier in ["node:fs", "node:fs/promises", "node:test/reporters"] {
            assert!(is_pinned_builtin(specifier));
        }
        for specifier in ["fs", "node:", "node:not-real", "node:fs/unknown"] {
            assert!(!is_pinned_builtin(specifier));
        }
    }
}
