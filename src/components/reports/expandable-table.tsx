import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Заголовок основной таблицы с раскрываемыми строками. */
export const expandableMainHeadClass =
  "bg-card text-base font-semibold h-11 px-4 py-0 align-middle first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";

export const expandableMainHeadRowClass = "[&_tr]:border-border/30";

/** Ячейки строки-сводки — те же горизонтальные отступы, что у заголовка. */
export const expandableSummaryCellClass =
  "px-4 py-3 align-middle first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";

/** Отступы вложенной таблицы (иерархия). */
export const expandableNestedWrapClass = "py-3 pr-5 pl-7 md:pr-6 md:pl-8";

export const expandableNestedCellPad = "px-4 py-2.5 first:pl-5 last:pr-6 md:first:pl-6";

export const expandableNestedTableShellClass = "overflow-x-auto rounded-xl border bg-card";

export const expandableNestedHeadClass = "bg-muted/30 h-10 text-sm font-semibold";

export const expandableSummaryBorderClass = "border-border/30 border-b";

export const expandableChevronClass = "size-4 shrink-0 opacity-70";

/** Фиксированные доли ширины — table-fixed + colgroup, колонки не плывут. */
export const expandableColWidths8 = [
  "20%",
  "10%",
  "12%",
  "9%",
  "11%",
  "11%",
  "10%",
  "9%",
] as const;

export const expandableColWidths6 = [
  "22%",
  "14%",
  "12%",
  "14%",
  "14%",
  "14%",
] as const;

export function ExpandableColGroup({ widths }: { widths: readonly string[] }) {
  return (
    <colgroup>
      {widths.map((width, i) => (
        <col key={i} style={{ width }} />
      ))}
    </colgroup>
  );
}

interface ExpandableMainHeaderProps {
  labels: readonly string[];
  centerFrom?: number;
}

export function ExpandableMainHeader({
  labels,
  centerFrom = 1,
}: ExpandableMainHeaderProps) {
  return (
    <TableHeader className={expandableMainHeadRowClass}>
      <TableRow>
        {labels.map((label, i) => (
          <TableHead
            key={`${label}-${i}`}
            className={cn(expandableMainHeadClass, i >= centerFrom && label && "text-center")}
          >
            {label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/** Обёртка таблицы отчёта: table-fixed + colgroup. */
export function ExpandableReportTable({
  widths,
  header,
  children,
}: {
  widths: readonly string[];
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Table className="table-fixed">
      <ExpandableColGroup widths={widths} />
      {header}
      <TableBody>{children}</TableBody>
    </Table>
  );
}

interface NestedTableProps {
  headers: string[];
  children: React.ReactNode;
  empty?: string;
  isEmpty?: boolean;
}

export function NestedTable({ headers, children, empty, isEmpty }: NestedTableProps) {
  if (isEmpty && empty) {
    return <p className="text-muted-foreground pl-2 text-sm">{empty}</p>;
  }

  return (
    <div className={expandableNestedTableShellClass}>
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((h, i) => (
              <TableHead
                key={h}
                className={cn(
                  expandableNestedHeadClass,
                  expandableNestedCellPad,
                  i > 0 && "text-center",
                )}
              >
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

export function NestedTableCell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <TableCell className={cn(expandableNestedCellPad, className)}>{children}</TableCell>;
}

/** Раскрытая детализация — вторая строка на всю ширину. */
export function ExpandableDetailRow({
  colSpan,
  children,
  className,
}: {
  colSpan: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <TableRow className={cn("hover:bg-transparent", className)}>
      <TableCell colSpan={colSpan} className="p-0">
        {children}
      </TableCell>
    </TableRow>
  );
}
