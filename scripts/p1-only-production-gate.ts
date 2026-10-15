import { assessProductionP1Only } from "../src/server/internal/p1-isolated-runner/p1-only-migration";

const decision = assessProductionP1Only({});
console.log(`STOP ${decision.code}`);
if (decision.executionAuthorized || decision.spawned || decision.appContainerReplaced) {
  process.exit(1);
}
process.exit(2);
