fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = if args.first().is_some_and(|arg| arg == "watch") {
        lattice_graph_core::watch::run_watch_cli(&args)
    } else {
        lattice_graph_core::daemon::run_stdio()
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
