import { cn } from "@/lib/utils";
import {
  expandableExpandedSummaryClass,
} from "@/components/reports/expandable-table";

/** Активные строки сверху, архивные вниз (порядок внутри групп сохраняется). */
export function partitionActiveArchived<T>(
  rows: readonly T[],
  isArchived: (row: T) => boolean,
): T[] {
  const active: T[] = [];
  const archived: T[] = [];
  for (const row of rows) {
    (isArchived(row) ? archived : active).push(row);
  }
  return [...active, ...archived];
}

export const archivedRowMutedClass = "text-muted-foreground/70 opacity-60";

/** Классы строки DataTable для архивной записи. */
export function dataTableArchivedRowClass<T>(
  row: T,
  index: number,
  isArchived: (row: T) => boolean,
): string | undefined {
  if (!isArchived(row)) return undefined;
  return cn(
    archivedRowMutedClass,
    index % 2 === 1 && "!bg-muted/25 hover:!bg-muted/30",
    "hover:opacity-75",
  );
}

/** Классы раскрываемой строки-сводки (отчёты, сделки). */
export function expandableArchivedSummaryRowClass(options: {
  archived: boolean;
  expanded: boolean;
  striped: boolean;
}): string {
  const { archived, expanded, striped } = options;
  return cn(
    archived && archivedRowMutedClass,
    striped && !archived && !expanded && "bg-muted/40",
    striped && archived && !expanded && "bg-muted/25",
    expanded && !archived && expandableExpandedSummaryClass,
    expanded && archived && "bg-muted/30",
    !archived && !expanded && "hover:bg-muted/50",
    archived && !expanded && "hover:bg-muted/30 hover:opacity-75",
  );
}
