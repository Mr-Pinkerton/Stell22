import { runProductionAdapterCli } from "../src/server/internal/p1-production-adapter/cli";

process.exit(runProductionAdapterCli(process.argv.slice(2)));
