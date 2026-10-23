/**
 * Turns disposable measurements into a freeze verdict.
 * A passing synthetic interval is not FREEZE PASS and is not a production guarantee.
 */

import { UNCOVERED_PRODUCTION_CHANNELS } from "@/server/internal/p1-offline-writer-admission/contract";

export type RowFate = "committed" | "absent" | "not-tested";
export type HttpFate = "committed" | "rejected" | "rejected-all" | "accepted-some" | "not-tested";

export type OfflineFacts = {
  httpDirectBefore: HttpFate;
  httpProxyBefore: HttpFate;
  httpDirectDuring: HttpFate;
  httpProxyDuring: HttpFate;
  directAcceptedWhileProxyClosed: boolean;
  continuitySamples: number;
  continuityBreaks: number;
  blindCommitAfterDeclaration: RowFate;
  cooperativeRecheck: RowFate;
  terminatedBeforeCommit: RowFate;
  pastCheckCommitted: boolean;
  backgroundTicksAfterClose: number;
  scheduledRecheckCommitted: boolean;
  maxAppSessionsDuringLatch: number;
  newAppSqlAfterHttpFreeze: RowFate;
  postHocActivitySawThatSession: boolean;
  raceCommits: number;
  raceTrials: number;
  restartLoopWritesWhileOpen: boolean;
  restartLoopWritesWhileClosed: boolean;
  explicitStopStayedDown: boolean;
  crashRestartedByPolicy: boolean;
  crashWithOpenFileWroteAgain: boolean;
  crashWithClosedFileWrote: boolean;
  engineKillRestarted: boolean;
  operatorStartAfterStopWrote: boolean;
  daemonRestart: "not-tested";
  operatorBootstrapInsert: RowFate;
  appCannotUpdateAdmission: boolean;
  prismaMigrationsRelation: "absent" | "present";
  appOnlyIsProductionPath: boolean;
  serverActionsCovered: false;
  physicalDisconnectTested: false;
};

export type OfflineVerdict = {
  gate: "FREEZE_PASS_FORBIDDEN";
  freezePassAllowed: false;
  productionRelease: "NO-GO";
  p1Applied: false;
  reasons: string[];
  proven: string[];
  notProven: string[];
};

export function judgeOfflineAdmission(facts: OfflineFacts): OfflineVerdict {
  const reasons: string[] = [];
  const proven: string[] = [];
  const notProven: string[] = [...UNCOVERED_PRODUCTION_CHANNELS];

  if (facts.blindCommitAfterDeclaration === "committed") {
    reasons.push("A transaction opened before FREEZE committed after the declaration.");
  }
  if (facts.pastCheckCommitted) {
    reasons.push("Work that had already passed the admission check committed after FREEZE.");
  }
  if (facts.newAppSqlAfterHttpFreeze === "committed") {
    reasons.push("A new application-role SQL session committed while HTTP admission stayed closed.");
  }
  if (facts.raceCommits > 0) {
    reasons.push(`${facts.raceCommits} of ${facts.raceTrials} terminate races still committed.`);
  }
  if (facts.crashWithOpenFileWroteAgain) {
    reasons.push("unless-stopped brought the writer back after a process crash while the admission file stayed open.");
  }
  if (facts.engineKillRestarted) {
    reasons.push("docker kill was followed by an unless-stopped restart without a separate operator start.");
  }
  if (facts.backgroundTicksAfterClose > 1) {
    reasons.push("The in-process queue kept inserting after it was stopped.");
  }
  if (facts.httpDirectDuring !== "rejected-all" || facts.httpProxyDuring !== "rejected-all" || facts.continuityBreaks > 0) {
    reasons.push("The synthetic HTTP reject control did not hold for every sample.");
  }
  if (facts.maxAppSessionsDuringLatch > 0) {
    reasons.push("An application-role backend was visible during the latch sample.");
  }
  if (facts.directAcceptedWhileProxyClosed) {
    reasons.push("Closing only the proxy left the direct application path able to write.");
  }
  if (facts.operatorBootstrapInsert === "committed") {
    reasons.push("The trusted bootstrap superuser inserted during the window. That write was not banned.");
  }
  if (!facts.appCannotUpdateAdmission) {
    reasons.push("The application role updated the admission row. Membership in the owning role was enough.");
  }
  if (facts.serverActionsCovered === false) {
    reasons.push("Server Actions were not called. The synthetic route is not that surface.");
  }
  if (facts.physicalDisconnectTested === false) {
    reasons.push("Physical disconnection was not performed and is not evidence.");
  }
  if (facts.daemonRestart === "not-tested") {
    reasons.push("Docker daemon restart was not tested.");
  }
  if (facts.appOnlyIsProductionPath) {
    reasons.push("Startup facts say the app-only candidate is the production path. That contradicts this package.");
  }
  if (facts.prismaMigrationsRelation === "present") {
    reasons.push("A Prisma migration relation appeared on the disposable database.");
  }
  reasons.push("One disposable run is not a production freeze.");

  if (facts.httpDirectBefore === "committed" && facts.httpProxyBefore === "committed") {
    proven.push("Before isolation, the synthetic direct path and the synthetic proxy path both inserted a row.");
  }
  if (facts.httpDirectDuring === "rejected-all" && facts.httpProxyDuring === "rejected-all" && facts.continuityBreaks === 0) {
    proven.push("While both synthetic controls stayed closed, every sampled direct and proxy write was rejected.");
  }
  if (facts.cooperativeRecheck === "absent") {
    proven.push("A writer that checked the admission row again before COMMIT left no row.");
  }
  if (facts.terminatedBeforeCommit === "absent") {
    proven.push("Operator pg_terminate_backend before COMMIT left that held row absent.");
  }
  if (facts.backgroundTicksAfterClose === 0) {
    proven.push("The in-process queue did not start another insert after it was stopped and the flag was closed.");
  }
  if (!facts.scheduledRecheckCommitted) {
    proven.push("A timer that checked admission at fire time did not insert.");
  }
  if (facts.restartLoopWritesWhileOpen && !facts.restartLoopWritesWhileClosed) {
    proven.push("The container loop inserted while its admission file was open and stopped inserting after the file was closed.");
  }
  if (facts.explicitStopStayedDown) {
    proven.push("An explicit docker stop of the unless-stopped writer stayed exited.");
  }
  if (facts.crashRestartedByPolicy && !facts.crashWithClosedFileWrote) {
    proven.push("A process exit was restarted by unless-stopped, and the closed admission file kept that process from inserting.");
  }
  if (!facts.engineKillRestarted) {
    proven.push("docker kill left the unless-stopped writer exited. This daemon did not start it again.");
  }
  if (facts.appCannotUpdateAdmission) {
    proven.push("The application role could not update the admission row.");
  }
  if (facts.prismaMigrationsRelation === "absent" && !facts.appOnlyIsProductionPath) {
    proven.push("This run did not create _prisma_migrations. appOnlyIsProductionPath is false, so this candidate is not an accepted production path.");
  }
  if (facts.postHocActivitySawThatSession) {
    proven.push("One later pg_stat_activity sample still showed the application insert text. That sample does not account for sessions that had already exited.");
  } else if (facts.newAppSqlAfterHttpFreeze === "committed") {
    proven.push("The committed application insert was already gone from pg_stat_activity when the following sample was read.");
  }

  notProven.push("holders of the application password");
  notProven.push("host root and the bootstrap superuser");
  notProven.push("a non-cooperative session that commits before terminate");

  return {
    gate: "FREEZE_PASS_FORBIDDEN",
    freezePassAllowed: false,
    productionRelease: "NO-GO",
    p1Applied: false,
    reasons,
    proven,
    notProven,
  };
}
