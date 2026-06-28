"use client";

import { Fragment, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  groupCashFlowsByDate,
  type FinanceArticle,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import { scrollTableYClass } from "@/lib/scroll-classes";
import { formatIsoDate, formatMoney } from "@/lib/format";
import {
  CashflowArticleSelect,
  CashflowCounterpartySelect,
  CashflowDealSelect,
} from "@/components/finance/cashflow-inline-assign";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AutoRuleFormDialog,
  type AutoRuleFormValues,
} from "@/components/finance/auto-rule-form-dialog";

const COL_SPAN = 6;

const COL_WIDTHS = ["14%", "15%", "26%", "15%", "15%", "15%"] as const;

const cellPad = "px-4 first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";

const headClass = "bg-card text-base font-semibold h-11 align-middle";

const headLeftClass = cn(headClass, "text-left");

const headCenterClass = cn(headClass, "text-center");

const stickyTheadClass = "[&_tr]:border-b";

const stickyHeadRowClass =
  "sticky top-0 z-20 bg-card shadow-[0_1px_0_0_var(--border)] hover:bg-card";

const stickyDateRowClass =
  "sticky top-11 z-10 bg-muted/95 hover:bg-muted/95 border-border/40 backdrop-blur-sm";

const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

function rowHighlightClass(row: FinanceCashFlowRow) {
  return cn(
    !row.isAutoAssigned && "!bg-amber-500/10 hover:!bg-amber-500/15",
    row.dealId && row.isAutoAssigned && "!bg-violet-500/8 hover:!bg-violet-500/12",
  );
}

interface FinanceCashflowTabProps {
  rows: FinanceCashFlowRow[];
  articles: FinanceArticle[];
  onRowUpdate?: (id: string, patch: Partial<FinanceCashFlowRow>) => void;
  onAutoRuleCreated?: (values: AutoRuleFormValues) => void;
}

export function FinanceCashflowTab({
  rows,
  articles,
  onRowUpdate,
  onAutoRuleCreated,
}: FinanceCashflowTabProps) {
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [ruleSeed, setRuleSeed] = useState<FinanceCashFlowRow | null>(null);

  const groups = useMemo(() => groupCashFlowsByDate(rows), [rows]);

  const openRule = (row: FinanceCashFlowRow) => {
    setRuleSeed(row);
    setRuleDialogOpen(true);
  };

  const assignRow = (row: FinanceCashFlowRow, patch: Partial<FinanceCashFlowRow>) => {
    onRowUpdate?.(row.id, patch);
  };

  return (
    <>
      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <div className={scrollTableYClass}>
            <table className="w-full table-fixed border-collapse caption-bottom text-sm">
              <colgroup>
                {COL_WIDTHS.map((width, i) => (
                  <col key={i} style={{ width }} />
                ))}
              </colgroup>
              <TableHeader className={stickyTheadClass}>
                <TableRow className={cn("hover:bg-transparent", stickyHeadRowClass)}>
                  <TableHead className={cn(cellPad, headLeftClass)}>Сумма</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Контрагент</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Назначение</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Статья</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Сделка</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass, "w-28")} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={COL_SPAN}
                      className={cn(cellPad, "text-muted-foreground h-24 text-center")}
                    >
                      Операций за период нет
                    </TableCell>
                  </TableRow>
                ) : (
                  groups.map((group) => (
                    <Fragment key={group.date}>
                      <TableRow className={stickyDateRowClass}>
                        <TableCell
                          colSpan={COL_SPAN}
                          className={cn(
                            cellPad,
                            "text-muted-foreground py-2 text-xs font-semibold tracking-wide uppercase",
                          )}
                        >
                          {formatIsoDate(group.date)}
                        </TableCell>
                      </TableRow>
                      {group.rows.map((row, index) => (
                        <TableRow
                          key={row.id}
                          className={cn(
                            index % 2 === 1 && "bg-muted/40",
                            rowHighlightClass(row),
                          )}
                        >
                          <TableCell className={cn(cellPad, "align-middle tabular-nums")}>
                            <div>
                              <span
                                className={cn(
                                  "font-medium",
                                  row.flowType === "INCOME" && "text-emerald-700",
                                )}
                              >
                                {row.flowType === "INCOME" ? "+" : "−"}
                                {formatMoney(row.amount)}
                              </span>
                              <p className="text-muted-foreground mt-0.5 text-xs font-normal">
                                {row.accountName}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className={cn(cellPad, "align-middle text-center")}>
                            <CashflowCounterpartySelect
                              row={row}
                              onAssign={(patch) => assignRow(row, patch)}
                            />
                          </TableCell>
                          <TableCell className={cn(cellPad, "align-middle text-center")}>
                            <p className="mx-auto line-clamp-2 w-full whitespace-normal">
                              {row.description}
                            </p>
                          </TableCell>
                          <TableCell className={cn(cellPad, "align-middle text-center")}>
                            <CashflowArticleSelect
                              row={row}
                              articles={articles}
                              onAssign={(patch) => assignRow(row, patch)}
                            />
                          </TableCell>
                          <TableCell className={cn(cellPad, "align-middle text-center")}>
                            <CashflowDealSelect
                              row={row}
                              onAssign={(patch) => assignRow(row, patch)}
                            />
                          </TableCell>
                          <TableCell className={cn(cellPad, "align-middle text-center")}>
                            <div className="flex items-center justify-center gap-0.5">
                              {!row.isAutoAssigned && (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className={tableActionClass}
                                        onClick={() => openRule(row)}
                                      >
                                        <Plus />
                                      </Button>
                                    }
                                  />
                                  <TooltipContent>Добавить правило</TooltipContent>
                                </Tooltip>
                              )}
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className={tableActionClass}
                                      onClick={() =>
                                        toast.message("Редактирование — прототип")
                                      }
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
                                      onClick={() => toast.message("Удаление — прототип")}
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
                      ))}
                    </Fragment>
                  ))
                )}
              </TableBody>
            </table>
          </div>
        </CardContent>
      </Card>

      <AutoRuleFormDialog
        open={ruleDialogOpen}
        seed={ruleSeed}
        articles={articles}
        onOpenChange={setRuleDialogOpen}
        onSubmit={onAutoRuleCreated}
      />
    </>
  );
}
