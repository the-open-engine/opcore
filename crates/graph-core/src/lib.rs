pub mod artifact;
pub mod daemon;
pub mod extraction;
pub mod pipeline;
pub mod protocol;
pub mod query;
pub mod search;
pub mod store;
pub mod watch;

pub const GRAPH_PROVIDER_NAME: &str = "lattice-graph";
pub const GRAPH_SCHEMA_VERSION: u32 = 1;
