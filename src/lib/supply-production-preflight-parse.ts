export const SUPPLY_PREFLIGHT_RESULT_PARSE_FAILED = "SUPPLY_PREFLIGHT_RESULT_PARSE_FAILED";

export const SUPPLY_PREFLIGHT_RESULT_LINE =
  /^SUPPLY_PREFLIGHT_RESULT=([0-9]+),([0-9]+),([0-9]+),([0-9]+)$/;

export type SupplyPreflightCounts = {
  total: number;
  deducted_positive: number;
  shortfall_only: number;
  open_deducted_positive: number;
};

export function parseSupplyPreflightStdout(stdout: string): SupplyPreflightCounts {
  const found: SupplyPreflightCounts[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(SUPPLY_PREFLIGHT_RESULT_LINE);
    if (!match) continue;
    found.push({
      total: Number(match[1]),
      deducted_positive: Number(match[2]),
      shortfall_only: Number(match[3]),
      open_deducted_positive: Number(match[4]),
    });
  }
  if (found.length !== 1) {
    throw new Error(SUPPLY_PREFLIGHT_RESULT_PARSE_FAILED);
  }
  return found[0];
}

export function formatSupplyPreflightMarkers(counts: SupplyPreflightCounts): string {
  const blocker = counts.open_deducted_positive > 0 ? "YES" : "NO";
  return [
    `SUPPLY_PREFLIGHT_TOTAL=${counts.total}`,
    `SUPPLY_PREFLIGHT_DEDUCTED_POSITIVE=${counts.deducted_positive}`,
    `SUPPLY_PREFLIGHT_SHORTFALL_ONLY=${counts.shortfall_only}`,
    `SUPPLY_PREFLIGHT_OPEN_DEDUCTED_POSITIVE=${counts.open_deducted_positive}`,
    `SUPPLY_DATA_BLOCKER=${blocker}`,
  ].join("\n");
}
