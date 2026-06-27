import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  className?: string;
}

interface DataTableProps<T extends { id: string }> {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
  className?: string;
  /** Горизонтальные отступы ячеек от краёв контейнера. */
  padded?: boolean;
}

const cellPad = "px-4 first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  empty = "Нет данных",
  className,
  padded = false,
}: DataTableProps<T>) {
  return (
    <div className={cn("rounded-lg border", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.key} className={cn(padded && cellPad, c.className)}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className={cn(
                  "text-muted-foreground h-24 text-center",
                  padded && cellPad,
                )}
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, index) => (
              <TableRow
                key={row.id}
                className={cn(index % 2 === 1 && "bg-muted/40 hover:bg-muted/55")}
              >
                {columns.map((c) => (
                  <TableCell key={c.key} className={cn(padded && cellPad, c.className)}>
                    {c.render
                      ? c.render(row)
                      : String((row as Record<string, unknown>)[c.key] ?? "")}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
