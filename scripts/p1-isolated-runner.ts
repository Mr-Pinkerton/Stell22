import { runCli } from "../src/server/internal/p1-isolated-runner/cli";

process.exit(runCli(process.argv.slice(2)));
