#!/usr/bin/env node
import { runAspProviderStdio } from "@the-open-engine/opcore-asp-provider";

declare const process: {
  argv: string[];
  exitCode?: number;
  stderr: { write(text: string): void };
};

if (!process.argv.includes("--stdio")) {
  process.stderr.write("Usage: opcore-asp-provider --stdio\n");
  process.exitCode = 64;
} else {
  runAspProviderStdio();
}
