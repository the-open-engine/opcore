mod daemon;
mod facts;
mod provider;

#[cfg(test)]
mod tests;

pub use daemon::*;
pub use facts::*;
pub use provider::*;

pub fn boundary_name() -> &'static str {
    "schema-versioned JSON/NDJSON protocol boundary"
}
