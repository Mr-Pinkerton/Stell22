"use client";

import { Fragment, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react";
import type {
  FinanceCashFlowRow,
  FinanceDeal,
} from "@/mocks/finance-fixtures";
import { formatMoney } from "@/lib/format";
import {
  expandableArchivedSummaryRowClass,
  partitionActiveArchived,
} from "@/lib/table-archive";
import { cn } from "@/lib/utils";
import { scrollTableYClass } from "@/lib/scroll-classes";
import {
  ExpandableDetailRow,
  expandableChevronClass,
  expandableExpandedAccentClass,
  expandableExpandedChevronClass,
  expandableExpandedDetailClass,
  expandableNestedWrapExpandedClass,
  expandableSummaryCellClass,
  NestedTable,
  NestedTableCell,
} from "@/components/reports/expandable-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const COL_SPAN = 4;
const COL_WIDTHS = ["38%", "20%", "18%", "24%"] as const;

const cellPad = "px-4 first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";

const headClass = "bg-card text-base font-semibold h-11 align-middle";

const headLeftClass = cn(headClass, "text-left");

const headCenterClass = cn(headClass, "text-center");

const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const DETAIL_HEADERS = ["Источник", "Описание", "Сумма"] as const;

interface DealLine {
  source: string;
  description: string;
  amount: number;
}

function buildDealLines(deal: FinanceDeal, cashFlows: FinanceCashFlowRow[]): DealLine[] {
  const lines: DealLine[] = [];

  if (deal.batchNames.length > 0) {
    lines.push({
      source: "Закупки",
      description: deal.batchNames.join(", "),
      amount: deal.purchaseTotal ?? 0,
    });
  }

  const ddsRows = cashFlows.filter((cf) => cf.dealId === deal.id);
  for (const cf of ddsRows) {
    lines.push({
      source: "ДДС",
      description: cf.description,
      amount: cf.flowType === "EXPENSE" ? cf.amount : -cf.amount,
    });
  }

  if (ddsRows.length === 0 && deal.deliveryExtra > 0) {
    lines.push({
      source: "ДДС",
      description: "Доставка и доп. расходы",
      amount: deal.deliveryExtra,
    });
  }

  return lines;
}

interface FinanceDealsTabProps {
  deals: FinanceDeal[];
  cashFlows: FinanceCashFlowRow[];
  onEdit?: (deal: FinanceDeal) => void;
  onArchiveToggle?: (deal: FinanceDeal) => void;
  onDelete?: (deal: FinanceDeal) => void;
}

export function FinanceDealsTab({
  deals,
  cashFlows,
  onEdit,
  onArchiveToggle,
  onDelete,
}: FinanceDealsTabProps) {
  const [showArchive, setShowArchive] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const filtered = deals.filter((d) => showArchive || d.status !== "ARCHIVED");
    return partitionActiveArchived(filtered, (d) => d.status === "ARCHIVED");
  }, [deals, showArchive]);

  return (
    <div className="space-y-4">
      <label className="border-border bg-card hover:border-[#98a2b3] hover:bg-muted/40 inline-flex h-10 cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 text-sm font-medium transition-colors">
        <Checkbox checked={showArchive} onCheckedChange={(v) => setShowArchive(v === true)} />
        <Label className="cursor-pointer font-medium">Архив</Label>
      </label>

      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <div className={scrollTableYClass}>
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                {COL_WIDTHS.map((width, i) => (
                  <col key={i} style={{ width }} />
                ))}
              </colgroup>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={cn(cellPad, headLeftClass)}>Сделка</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Сумма</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Статус</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={COL_SPAN}
                      className={cn(cellPad, "text-muted-foreground h-24 text-center")}
                    >
                      Сделок нет
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row, index) => (
                    <DealRowGroup
                      key={row.id}
                      deal={row}
                      cashFlows={cashFlows}
                      expanded={expandedId === row.id}
                      striped={index % 2 === 1}
                      onToggle={() =>
                        setExpandedId((id) => (id === row.id ? null : row.id))
                      }
                      onEdit={onEdit}
                      onArchiveToggle={onArchiveToggle}
                      onDelete={onDelete}
                    />
                  ))
                )}
              </TableBody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DealRowGroup({
  deal,
  cashFlows,
  expanded,
  striped,
  onToggle,
  onEdit,
  onArchiveToggle,
  onDelete,
}: {
  deal: FinanceDeal;
  cashFlows: FinanceCashFlowRow[];
  expanded: boolean;
  striped: boolean;
  onToggle: () => void;
  onEdit?: (deal: FinanceDeal) => void;
  onArchiveToggle?: (deal: FinanceDeal) => void;
  onDelete?: (deal: FinanceDeal) => void;
}) {
  const lines = useMemo(() => buildDealLines(deal, cashFlows), [deal, cashFlows]);

  const archived = deal.status === "ARCHIVED";

  return (
    <Fragment>
      <TableRow
        className={cn(
          "cursor-pointer align-middle",
          expandableArchivedSummaryRowClass({ archived, expanded, striped }),
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
            <span className={cn("truncate font-medium", archived && "font-normal")}>
              {deal.name}
            </span>
          </div>
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center font-medium tabular-nums")}>
          {formatMoney(deal.total)}
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center")}>
          <Badge
            variant={deal.status === "OPEN" ? "secondary" : "outline"}
            className={archived ? "opacity-80" : undefined}
          >
            {deal.status === "OPEN" ? "Открыта" : "Архив"}
          </Badge>
        </TableCell>
        <TableCell
          className={cn(expandableSummaryCellClass, "text-center")}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={tableActionClass}
                    aria-label="Редактировать"
                    onClick={() => onEdit?.(deal)}
                  >
                    <Pencil />
                  </Button>
                }
              />
              <TooltipContent>Редактировать</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={tableActionClass}
                    aria-label={deal.status === "ARCHIVED" ? "Вернуть из архива" : "В архив"}
                    onClick={() => onArchiveToggle?.(deal)}
                  >
                    {deal.status === "ARCHIVED" ? <ArchiveRestore /> : <Archive />}
                  </Button>
                }
              />
              <TooltipContent>
                {deal.status === "ARCHIVED" ? "Вернуть из архива" : "В архив"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={tableActionClass}
                    aria-label="Удалить"
                    onClick={() => onDelete?.(deal)}
                  >
                    <Trash2 />
                  </Button>
                }
              />
              <TooltipContent>Удалить</TooltipContent>
            </Tooltip>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <ExpandableDetailRow colSpan={COL_SPAN} className={expandableExpandedDetailClass}>
          <div className={expandableNestedWrapExpandedClass}>
            <NestedTable headers={[...DETAIL_HEADERS]} isEmpty={lines.length === 0} empty="Пусто">
              {lines.map((line, i) => (
                <TableRow key={`${deal.id}-${i}`}>
                  <NestedTableCell className="font-medium">{line.source}</NestedTableCell>
                  <NestedTableCell className="text-center whitespace-normal">
                    {line.description}
                  </NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">
                    {formatMoney(line.amount)}
                  </NestedTableCell>
                </TableRow>
              ))}
            </NestedTable>
            <p className="text-muted-foreground mt-3 pl-2 text-xs leading-relaxed">
              Новые расходы по сделке добавляются в ДДС и отображаются здесь после разнесения.
            </p>
          </div>
        </ExpandableDetailRow>
      )}
    </Fragment>
  );
}
