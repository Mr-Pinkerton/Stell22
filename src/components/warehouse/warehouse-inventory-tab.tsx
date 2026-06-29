"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  type InventoryDocRow,
  type InventoryLineRow,
} from "@/mocks/warehouse-fixtures";
import {
  inventoryDeviation,
  inventoryDeviationSum,
} from "@/lib/warehouse-stock";
import { conductInventory, updateInventoryLineActual } from "@/server/warehouse";
import { formatIsoDate, formatMoney } from "@/lib/format";
import { scrollTableYClass } from "@/lib/scroll-classes";
import { cn } from "@/lib/utils";
import {
  ExpandableDetailRow,
  expandableChevronClass,
  expandableExpandedAccentClass,
  expandableExpandedChevronClass,
  expandableExpandedDetailClass,
  expandableExpandedSummaryClass,
  expandableNestedWrapExpandedClass,
  expandableSummaryCellClass,
  NestedTable,
  NestedTableCell,
} from "@/components/reports/expandable-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InventoryStatus } from "@/types/domain";

const INVENTORY_STATUS_LABEL: Record<InventoryStatus, string> = {
  DRAFT: "Черновик",
  CONDUCTED: "Проведена",
  CLOSED: "Закрыта",
};

const DRAFT_COL_WIDTHS = ["28%", "14%", "14%", "12%", "16%", "16%"] as const;

const HISTORY_COL_SPAN = 4;
const HISTORY_COL_WIDTHS = ["22%", "22%", "28%", "28%"] as const;

const cellPad = "px-3 first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";
const headClass = "bg-card text-base font-semibold h-11 align-middle";
const headLeftClass = cn(headClass, "text-left");
const headCenterClass = cn(headClass, "text-center");

interface WarehouseInventoryTabProps {
  docs: InventoryDocRow[];
  onDocsChange: (docs: InventoryDocRow[]) => void;
}

export function WarehouseInventoryTab({
  docs,
  onDocsChange: setDocs,
}: WarehouseInventoryTabProps) {
  const [pending, startTransition] = useTransition();

  const draft = useMemo(() => docs.find((d) => d.status === "DRAFT"), [docs]);
  const history = useMemo(
    () => docs.filter((d) => d.status !== "DRAFT").sort((a, b) => (a.date < b.date ? 1 : -1)),
    [docs],
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const updateDraftLine = (lineId: string, actualQty: number) => {
    if (!draft) return;
    // Оптимистично обновляем UI, затем сохраняем в БД.
    setDocs(
      docs.map((doc) =>
        doc.id !== draft.id
          ? doc
          : {
              ...doc,
              lines: doc.lines.map((line) =>
                line.id === lineId ? { ...line, actualQty } : line,
              ),
            },
      ),
    );
    startTransition(async () => {
      try {
        await updateInventoryLineActual(lineId, actualQty);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Ошибка сохранения");
      }
    });
  };

  const conductDraft = () => {
    if (!draft) return;
    startTransition(async () => {
      try {
        const updated = await conductInventory(draft.id);
        setDocs(docs.map((doc) => (doc.id === draft.id ? updated : doc)));
        toast.success("Инвентаризация проведена — остатки скорректированы");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Ошибка проведения");
      }
    });
  };

  return (
    <div className="space-y-6">
      {draft ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Текущая инвентаризация</h2>
              <p className="text-muted-foreground text-sm">
                {formatIsoDate(draft.date)} · {INVENTORY_STATUS_LABEL[draft.status]}
              </p>
            </div>
            <Button
              type="button"
              variant="brand"
              className="h-10 rounded-xl px-5"
              disabled={pending}
              onClick={conductDraft}
            >
              Провести
            </Button>
          </div>

          <Card className="surface-card ring-0">
            <CardContent className="p-0">
              <div className={scrollTableYClass}>
                <table className="w-full table-fixed border-collapse text-sm">
                  <colgroup>
                    {DRAFT_COL_WIDTHS.map((width, i) => (
                      <col key={i} style={{ width }} />
                    ))}
                  </colgroup>
                  <TableHeader className="[&_tr]:border-b">
                    <TableRow>
                      <TableHead className={cn(cellPad, headLeftClass)}>Номенклатура</TableHead>
                      <TableHead className={cn(cellPad, headCenterClass)}>Учётное</TableHead>
                      <TableHead className={cn(cellPad, headCenterClass)}>Фактическое</TableHead>
                      <TableHead className={cn(cellPad, headCenterClass)}>Отклонение</TableHead>
                      <TableHead className={cn(cellPad, headCenterClass)}>Сумма</TableHead>
                      <TableHead className={cn(cellPad, headCenterClass)} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {draft.lines.map((line, index) => (
                      <DraftLineRow
                        key={line.id}
                        line={line}
                        striped={index % 2 === 1}
                        onActualChange={(qty) => updateDraftLine(line.id, qty)}
                      />
                    ))}
                  </TableBody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>
      ) : (
        <p className="text-muted-foreground text-sm">Черновик инвентаризации не создан.</p>
      )}

      {history.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Проведённые инвентаризации</h2>
          <Card className="surface-card ring-0">
            <CardContent className="p-0">
              <div className={scrollTableYClass}>
                <table className="w-full table-fixed border-collapse text-sm">
                  <colgroup>
                    {HISTORY_COL_WIDTHS.map((width, i) => (
                      <col key={i} style={{ width }} />
                    ))}
                  </colgroup>
                  <TableHeader className="[&_tr]:border-b">
                    <TableRow>
                      <TableHead className={cn(cellPad, headLeftClass)}>Дата</TableHead>
                      <TableHead className={cn(cellPad, headCenterClass)}>Статус</TableHead>
                      <TableHead className={cn(cellPad, headCenterClass)}>Строк</TableHead>
                      <TableHead className={cn(cellPad, headCenterClass)} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((doc, index) => (
                      <HistoryRowGroup
                        key={doc.id}
                        doc={doc}
                        expanded={expandedId === doc.id}
                        striped={index % 2 === 1}
                        onToggle={() =>
                          setExpandedId((id) => (id === doc.id ? null : doc.id))
                        }
                      />
                    ))}
                  </TableBody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}

function DraftLineRow({
  line,
  striped,
  onActualChange,
}: {
  line: InventoryLineRow;
  striped: boolean;
  onActualChange: (qty: number) => void;
}) {
  const deviation = inventoryDeviation(line.accountedQty, line.actualQty);
  const deviationSum = inventoryDeviationSum(deviation, line.unitCost);

  return (
    <TableRow className={cn(striped && "bg-muted/40")}>
      <TableCell className={cn(cellPad, "font-medium")}>{line.name}</TableCell>
      <TableCell className={cn(cellPad, "text-center tabular-nums")}>{line.accountedQty}</TableCell>
      <TableCell className={cn(cellPad, "text-center")}>
        <Input
          type="number"
          min={0}
          value={line.actualQty}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            if (Number.isFinite(parsed) && parsed >= 0) onActualChange(parsed);
          }}
          className="border-border mx-auto h-9 w-24 rounded-lg text-center tabular-nums"
        />
      </TableCell>
      <TableCell
        className={cn(
          cellPad,
          "text-center tabular-nums",
          deviation < 0 && "text-red-600",
          deviation > 0 && "text-emerald-700",
        )}
      >
        {deviation > 0 ? `+${deviation}` : deviation}
      </TableCell>
      <TableCell
        className={cn(
          cellPad,
          "text-center tabular-nums",
          deviationSum < 0 && "text-red-600",
          deviationSum > 0 && "text-emerald-700",
        )}
      >
        {formatMoney(deviationSum)}
      </TableCell>
      <TableCell className={cn(cellPad, "text-center")} />
    </TableRow>
  );
}

function HistoryRowGroup({
  doc,
  expanded,
  striped,
  onToggle,
}: {
  doc: InventoryDocRow;
  expanded: boolean;
  striped: boolean;
  onToggle: () => void;
}) {
  const totalDeviation = doc.lines.reduce(
    (sum, line) =>
      sum +
      inventoryDeviationSum(
        inventoryDeviation(line.accountedQty, line.actualQty),
        line.unitCost,
      ),
    0,
  );

  return (
    <Fragment>
      <TableRow
        className={cn(
          "cursor-pointer align-middle",
          striped && !expanded && "bg-muted/40",
          expanded && expandableExpandedSummaryClass,
          !expanded && "hover:bg-muted/50",
        )}
        onClick={onToggle}
      >
        <TableCell
          className={cn(
            expandableSummaryCellClass,
            expanded && expandableExpandedAccentClass,
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {expanded ? (
              <ChevronDown
                className={cn(expandableChevronClass, expandableExpandedChevronClass)}
              />
            ) : (
              <ChevronRight className={expandableChevronClass} />
            )}
            <span className="tabular-nums">{formatIsoDate(doc.date)}</span>
          </div>
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center")}>
          <Badge variant={doc.status === "CLOSED" ? "outline" : "secondary"}>
            {INVENTORY_STATUS_LABEL[doc.status]}
          </Badge>
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {doc.lines.length}
        </TableCell>
        <TableCell
          className={cn(expandableSummaryCellClass, "text-center font-medium tabular-nums")}
        >
          {formatMoney(totalDeviation)}
        </TableCell>
      </TableRow>

      {expanded && (
        <ExpandableDetailRow colSpan={HISTORY_COL_SPAN} className={expandableExpandedDetailClass}>
          <div className={expandableNestedWrapExpandedClass}>
            <NestedTable
              headers={["Номенклатура", "Учётное", "Фактическое", "Отклонение", "Сумма"]}
              isEmpty={doc.lines.length === 0}
              empty="Пусто"
            >
              {doc.lines.map((line) => {
                const deviation = inventoryDeviation(line.accountedQty, line.actualQty);
                const deviationSum = inventoryDeviationSum(deviation, line.unitCost);
                return (
                  <TableRow key={line.id}>
                    <NestedTableCell className="font-medium">{line.name}</NestedTableCell>
                    <NestedTableCell className="text-center tabular-nums">
                      {line.accountedQty}
                    </NestedTableCell>
                    <NestedTableCell className="text-center tabular-nums">
                      {line.actualQty}
                    </NestedTableCell>
                    <NestedTableCell
                      className={cn(
                        "text-center tabular-nums",
                        deviation < 0 && "text-red-600",
                        deviation > 0 && "text-emerald-700",
                      )}
                    >
                      {deviation > 0 ? `+${deviation}` : deviation}
                    </NestedTableCell>
                    <NestedTableCell
                      className={cn(
                        "text-center tabular-nums",
                        deviationSum < 0 && "text-red-600",
                        deviationSum > 0 && "text-emerald-700",
                      )}
                    >
                      {formatMoney(deviationSum)}
                    </NestedTableCell>
                  </TableRow>
                );
              })}
            </NestedTable>
          </div>
        </ExpandableDetailRow>
      )}
    </Fragment>
  );
}
