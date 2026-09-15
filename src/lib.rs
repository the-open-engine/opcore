//! Fast source verification, dependency feedback, and four ASP check providers.
//!
//! Start with the [`api`] module for the supported application entrypoints and the
//! [`api::ProviderProfile`] reference for Fast Verify, Rust-native, Node-native,
//! and Python-native. The executable exposes these through `check`, `sense`,
//! `run`, `doctor`, `status`, `rules`, `manifest`, and `serve --stdio`.
//!
//! The default checks parse an immutable Git view without executing repository code.
//! Native providers are explicitly selected and require trusted code or an external sandbox.
//! Implementation modules are private; this package is distributed as an executable.

mod analysis;
pub mod api;
mod cache;
mod cancel;
mod commands;
mod documentation;
mod engine;
mod facts;
mod hooks;
mod identity;
mod json;
mod limits;
mod local;
mod model;
mod parallel;
mod path;
mod policy;
mod protocol;
mod sense;
mod source;
