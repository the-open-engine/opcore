//! Generate the public CLI reference from the executable's argument definitions.

use std::fmt::Write as _;

use clap::CommandFactory as _;

#[allow(
    dead_code,
    reason = "Only the executable parses these shared argument fields"
)]
#[path = "../src/cli_args.rs"]
mod cli_args;

fn main() -> Result<(), std::fmt::Error> {
    let mut root = cli_args::Cli::command();
    root.build();
    let mut output = String::from(concat!(
        "# CLI reference\n\nGenerated from the executable's Rust argument definitions and doc comments.\n\n",
        "For installation and removal commands provided by npm and the archive installer, ",
        "see [Getting started](docs/getting-started.html#update-or-remove).\n\n"
    ));
    let mut commands = vec![(String::from("opcore"), root)];
    while let Some((name, mut command)) = commands.pop() {
        writeln!(
            output,
            "## `{name}`\n\n```text\n{}```\n",
            command.render_long_help()
        )?;
        let children = command
            .get_subcommands()
            .filter(|child| !child.is_hide_set() && child.get_name() != "help")
            .cloned()
            .collect::<Vec<_>>();
        for child in children.into_iter().rev() {
            let invocation = format!("{name} {}", child.get_name());
            commands.push((invocation.clone(), child.bin_name(invocation)));
        }
    }
    println!("{output}");
    Ok(())
}
