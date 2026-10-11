import { HISTORICAL_APPLICATION_COMMIT } from "@/server/internal/p1-isolated-runner/contract";

export const DISPOSABLE_INTEGRATION_STATUS = "NOT_EXECUTED" as const;

export const OLD_APP_COMPATIBILITY_CASES = [
  {
    id: "old-checkpoint",
    requirement:
      "Build the application from the historical checkpoint and its generated Prisma client.",
    commit: HISTORICAL_APPLICATION_COMMIT,
  },
  {
    id: "database-after-exact-p1",
    requirement: "The disposable database has exactly the P1 object set and no later migration.",
  },
  {
    id: "bookkeeping-46",
    requirement: " _prisma_migrations has 46 successful rows and no failed or extra rows.",
  },
  {
    id: "create-batch",
    requirement: "createBatch from the historical purchases module inserts a batch.",
  },
  {
    id: "request-id-replay",
    requirement: "Repeating the same requestId does not create a second batch.",
  },
  {
    id: "update-batch",
    requirement: "updateBatch from the historical module updates the fixture batch.",
  },
  {
    id: "provenance-sql-null",
    requirement: "BatchCreationCommand.receiptProvenanceSnapshot remains SQL NULL.",
  },
  {
    id: "business-records",
    requirement: "Existing business records stay unchanged except the fixture operations.",
  },
  {
    id: "shadow-unchanged",
    requirement: "SHADOW row counts and the shadow gate stay unchanged.",
  },
  {
    id: "production-cost-flow-unchanged",
    requirement: "production_cost_flow stays absent or inactive.",
  },
  {
    id: "no-p2-p3-writer",
    requirement: "The historical process does not load the P2 writer or the P3 checker.",
  },
  {
    id: "no-app-container-replacement",
    requirement: "No application container is replaced.",
  },
  {
    id: "no-docker-entrypoint",
    requirement: "Setup does not invoke docker-entrypoint.sh.",
  },
] as const;

export function executeOldAppCompatibility(): never {
  throw new Error(
    "NOT EXECUTED: disposable old-application compatibility is not authorized in this candidate",
  );
}
