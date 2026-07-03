"use client";

import { Fragment, useMemo, useState } from "react";
import { ArrowLeftRight, Trash2, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  groupCashFlowsByDate,
  type FinanceArticle,
  type FinanceAutoRule,
  type FinanceCashFlowRow,
  type FinanceCounterparty,
  type FinanceDeal,
} from "@/mocks/finance-fixtures";
import { scrollTableYClass } from "@/lib/scroll-classes";
import { formatIsoDate, formatMoney } from "@/lib/format";
import { findMatchingAutoRule } from "@/lib/auto-rule-match";
import {
  CashflowArticleSelect,
  CashflowCounterpartySelect,
  CashflowDealSelect,
  type CashflowAssignPatch,
} from "@/components/finance/cashflow-inline-assign";
import { AutoRuleQuickButton } from "@/components/finance/auto-rule-quick-button";
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
    row.isTransfer && "!bg-sky-500/8 hover:!bg-sky-500/12",
    !row.isTransfer && !row.isAutoAssigned && "!bg-amber-500/10 hover:!bg-amber-500/15",
    !row.isTransfer &&
      row.dealId &&
      row.isAutoAssigned &&
      "!bg-violet-500/8 hover:!bg-violet-500/12",
  );
}

const transferMutedCellClass = "text-muted-foreground/70 text-center text-sm";

interface FinanceCashflowTabProps {
  rows: FinanceCashFlowRow[];
  articles: FinanceArticle[];
  counterparties: FinanceCounterparty[];
  deals: FinanceDeal[];
  autoRules: FinanceAutoRule[];
  onAssign?: (id: string, patch: CashflowAssignPatch) => void;
  onDelete?: (id: string) => void;
  onConvertToTransfer?: (row: FinanceCashFlowRow) => void;
  onUnlinkTransfer?: (id: string) => void;
  onAutoRuleCreated?: (values: AutoRuleFormValues) => void;
  onGoToRule?: (ruleId: string) => void;
}

export function FinanceCashflowTab({
  rows,
  articles,
  counterparties,
  deals,
  autoRules,
  onAssign,
  onDelete,
  onConvertToTransfer,
  onUnlinkTransfer,
  onAutoRuleCreated,
  onGoToRule,
}: FinanceCashflowTabProps) {
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [ruleSeed, setRuleSeed] = useState<FinanceCashFlowRow | null>(null);

  const groups = useMemo(() => groupCashFlowsByDate(rows), [rows]);

  const openRule = (row: FinanceCashFlowRow) => {
    setRuleSeed(row);
    setRuleDialogOpen(true);
  };

  const assignRow = (row: FinanceCashFlowRow, patch: CashflowAssignPatch) => {
    onAssign?.(row.id, patch);
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
                      {group.rows.map((row, index) => {
                        const matchedRule = row.isTransfer
                          ? null
                          : findMatchingAutoRule(autoRules, row);
                        return (
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
                          {row.isTransfer ? (
                            <TableCell className={cn(cellPad, "align-middle text-center")}>
                              <span className="bg-sky-500/12 text-sky-700 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium">
                                Перевод
                              </span>
                            </TableCell>
                          ) : (
                            <TableCell className={cn(cellPad, "align-middle text-center")}>
                              <CashflowCounterpartySelect
                                row={row}
                                counterparties={counterparties}
                                onAssign={(patch) => assignRow(row, patch)}
                              />
                            </TableCell>
                          )}
                          <TableCell className={cn(cellPad, "align-middle text-center")}>
                            <p className="mx-auto line-clamp-2 w-full whitespace-normal">
                              {row.description}
                            </p>
                          </TableCell>
                          {row.isTransfer ? (
                            <TableCell className={cn(cellPad, "align-middle")}>
                              <p className={transferMutedCellClass}>Между счетами</p>
                            </TableCell>
                          ) : (
                            <TableCell className={cn(cellPad, "align-middle text-center")}>
                              <CashflowArticleSelect
                                row={row}
                                articles={articles}
                                onAssign={(patch) => assignRow(row, patch)}
                              />
                            </TableCell>
                          )}
                          {row.isTransfer ? (
                            <TableCell className={cn(cellPad, "align-middle")}>
                              <p className={transferMutedCellClass}>—</p>
                            </TableCell>
                          ) : (
                            <TableCell className={cn(cellPad, "align-middle text-center")}>
                              <CashflowDealSelect
                                row={row}
                                deals={deals}
                                onAssign={(patch) => assignRow(row, patch)}
                              />
                            </TableCell>
                          )}
                          <TableCell className={cn(cellPad, "align-middle text-center")}>
                            <div className="flex items-center justify-center gap-0.5">
                              {!row.isTransfer && (
                                <AutoRuleQuickButton
                                  hasRule={Boolean(matchedRule)}
                                  onClick={() =>
                                    matchedRule ? onGoToRule?.(matchedRule.id) : openRule(row)
                                  }
                                />
                              )}
                              {!row.isTransfer && onConvertToTransfer && (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className={tableActionClass}
                                        aria-label="Сделать переводом"
                                        onClick={() => onConvertToTransfer(row)}
                                      >
                                        <ArrowLeftRight />
                                      </Button>
                                    }
                                  />
                                  <TooltipContent>Сделать переводом</TooltipContent>
                                </Tooltip>
                              )}
                              {row.isTransfer && onUnlinkTransfer && (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className={tableActionClass}
                                        aria-label="Убрать перевод"
                                        onClick={() => onUnlinkTransfer(row.id)}
                                      >
                                        <Unlink />
                                      </Button>
                                    }
                                  />
                                  <TooltipContent>Убрать перевод</TooltipContent>
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
                                      aria-label="Удалить"
                                      onClick={() => onDelete?.(row.id)}
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
                        );
                      })}
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
        counterparties={counterparties}
        onOpenChange={setRuleDialogOpen}
        onSubmit={onAutoRuleCreated}
      />
    </>
  );
}
