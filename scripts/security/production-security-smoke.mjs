import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { PrismaClient } from "@prisma/client";

function loadDatabaseUrlFromEnvFile() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^DATABASE_URL=(.*)$/);
    if (!match) continue;
    process.env.DATABASE_URL = match[1].trim().replace(/^["']|["']$/g, "");
    return;
  }
}

loadDatabaseUrlFromEnvFile();

const baseUrl = (process.env.SECURITY_SMOKE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SMOKE_DESCRIPTION = "anonymous security smoke";
const manifestPath = path.join(
  process.cwd(),
  ".next",
  "server",
  "server-reference-manifest.json",
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entries = Object.entries(manifest.node ?? {});

const credentialEntry = entries.find(
  ([, entry]) => entry.exportedName === "loadStoredApiCredentials",
);
if (credentialEntry) {
  throw new Error("loadStoredApiCredentials is still registered as a Server Action");
}

const adminAction = entries.find(
  ([, entry]) => entry.exportedName === "createCashFlow",
);
if (!adminAction) throw new Error("Representative admin action createCashFlow is absent");
const [adminActionId] = adminAction;
const adminWorkers = Object.keys(adminAction[1].workers ?? {});
if (adminWorkers.includes("app/terminal/page")) {
  throw new Error("Representative admin mutation is still registered on the terminal worker");
}
const adminWorker = adminWorkers.find((worker) => worker !== "app/terminal/page");
if (!adminWorker) {
  throw new Error("Representative admin action has no admin worker route");
}

function workerToRoute(worker) {
  const parts = worker
    .replace(/^app\//, "")
    .split("/")
    .filter((part) => part && !part.startsWith("(") && part !== "page");
  return `/${parts.join("/")}`;
}

function isDisposableDatabaseUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes("stell22.ru") || lower.includes("stell22.com")) return false;
  return (
    lower.includes("localhost") ||
    lower.includes("127.0.0.1") ||
    lower.includes("0.0.0.0")
  );
}

const require = createRequire(import.meta.url);
const { encodeReply } = require("next/dist/compiled/react-server-dom-webpack/client.node");
const encodedArgs = await encodeReply([
  {
    amount: 1,
    flowType: "EXPENSE",
    accountName: "__security_smoke_nonexistent_account__",
    counterpartyName: "",
    articleName: "",
    description: SMOKE_DESCRIPTION,
    date: "2000-01-01",
  },
]);
const actionHeaders = {
  Accept: "text/x-component",
  "Next-Action": adminActionId,
};
if (typeof encodedArgs === "string") {
  actionHeaders["Content-Type"] = "text/plain;charset=UTF-8";
}

const terminalResponse = await fetch(`${baseUrl}/terminal`, {
  redirect: "manual",
  headers: { Accept: "text/html" },
});
if (!terminalResponse.ok) {
  throw new Error(`Anonymous GET /terminal failed with ${terminalResponse.status}`);
}
const terminalHtml = await terminalResponse.text();
const confidentialMarkers = [
  '"purchaseCost"',
  '"totalCost"',
  '"priceSort1"',
  '"priceSort2"',
  '"hourlyRate"',
  '"birthDate"',
  '"batches"',
  '"railLots"',
  "apiCred:",
];
const leakedMarkers = confidentialMarkers.filter((marker) => terminalHtml.includes(marker));
if (leakedMarkers.length > 0) {
  throw new Error(`Pre-PIN /terminal contains confidential data markers: ${leakedMarkers.join(", ")}`);
}

const terminalActionResponse = await fetch(`${baseUrl}/terminal`, {
  method: "POST",
  redirect: "manual",
  headers: actionHeaders,
  body: encodedArgs,
});
const terminalActionRedirect =
  terminalActionResponse.headers.get("x-action-redirect") ??
  terminalActionResponse.headers.get("location") ??
  "";
const terminalActionBody = await terminalActionResponse.text();
const unavailableOnTerminal =
  terminalActionResponse.ok &&
  !terminalActionRedirect &&
  (terminalActionBody.trim() === "" || terminalActionBody.trim() === "{}");
if (
  terminalActionResponse.ok &&
  !terminalActionRedirect.startsWith("/login") &&
  !unavailableOnTerminal
) {
  throw new Error(
    `Anonymous admin action was not rejected on /terminal (status ${terminalActionResponse.status}): ${terminalActionBody.slice(0, 300)}`,
  );
}

let cashFlowCountBefore = null;
let prisma = null;
if (isDisposableDatabaseUrl(process.env.DATABASE_URL)) {
  prisma = new PrismaClient();
  cashFlowCountBefore = await prisma.cashFlow.count({
    where: { description: SMOKE_DESCRIPTION },
  });
} else if (process.env.DATABASE_URL) {
  console.warn(
    "Skipping DB-unchanged check: DATABASE_URL is not a disposable local/test database.",
  );
}

const adminRoute = workerToRoute(adminWorker);
const adminActionResponse = await fetch(`${baseUrl}${adminRoute}`, {
  method: "POST",
  redirect: "manual",
  headers: actionHeaders,
  body: encodedArgs,
});
const adminRedirect =
  adminActionResponse.headers.get("x-action-redirect") ??
  adminActionResponse.headers.get("location") ??
  "";
const adminBody = await adminActionResponse.text();
const adminRejected =
  adminActionResponse.status === 303 ||
  adminActionResponse.status === 307 ||
  adminActionResponse.status === 308 ||
  adminRedirect.startsWith("/login") ||
  adminBody.includes("Требуется сессия администратора");
if (adminActionResponse.ok && !adminRejected) {
  throw new Error(
    `Anonymous admin action was not rejected on ${adminRoute} (status ${adminActionResponse.status}): ${adminBody.slice(0, 300)}`,
  );
}

if (prisma && cashFlowCountBefore != null) {
  const cashFlowCountAfter = await prisma.cashFlow.count({
    where: { description: SMOKE_DESCRIPTION },
  });
  await prisma.$disconnect();
  if (cashFlowCountAfter !== cashFlowCountBefore) {
    throw new Error(
      `Anonymous admin action changed disposable DB (${cashFlowCountBefore} → ${cashFlowCountAfter} cashflows)`,
    );
  }
}

console.log(
  "Production security smoke passed: pre-PIN payload is clean, credentials loader is absent, " +
    `anonymous admin mutation unavailable on /terminal (${terminalActionResponse.status}` +
    `${
      unavailableOnTerminal
        ? ", action unavailable on terminal worker"
        : terminalActionRedirect
          ? `, ${terminalActionRedirect}`
          : ""
    }), ` +
    `rejected on ${adminRoute} (${adminActionResponse.status}` +
    `${adminRedirect ? `, ${adminRedirect}` : ""})` +
    `${prisma ? ", disposable DB unchanged" : ""}.`,
);
