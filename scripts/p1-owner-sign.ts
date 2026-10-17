import { runOwnerSignCli } from "../src/server/internal/p1-production-adapter/owner-sign";

runOwnerSignCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch(() => process.exit(2));
