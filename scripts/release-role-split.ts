import { runReleaseCli } from "../src/server/internal/p1-production-release/cli";

process.exit(runReleaseCli(process.argv.slice(2)));
