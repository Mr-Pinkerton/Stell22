import { runCli } from "../src/server/internal/p1-disposable-release/cli";

process.exit(runCli(process.argv.slice(2)));
