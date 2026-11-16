"use client";

import { Fragment, useMemo, useState } from "react";
import { ArrowLeftRight, Pencil, Trash2, Unlink } from "lucide-react";
import { TableFilterSlot, tableBodyRowClass, tableHeadClass, tableStickyHeadRowClass, tableSurfaceCardClass } from "@/components/table-surface";
import { cn } from "@/lib/utils";
import {
  groupCashFlowsByDate,
  type FinanceArticle,
  type FinanceAutoRule,
  type FinanceCashFlowRow,
  type FinanceCounterparty,
  type FinanceDeal,
} from "@/mocks/finance-fixtures";
import { scrollTableYClass, scrollThinX } from "@/lib/scroll-classes";
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
import { tableActionClass } from "@/components/nomenclature/form-shared";

const COL_SPAN = 6;

const COL_WIDTHS = ["14%", "15%", "22%", "15%", "15%", "19%"] as const;

const cellPad = "px-4 first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";

const headClass = tableHeadClass;

const headLeftClass = cn(headClass, "text-left");

const headCenterClass = cn(headClass, "text-center");

const stickyTheadClass = "[&_tr]:border-b";

const stickyHeadRowClass = tableStickyHeadRowClass;

const stickyDateRowClass =
  "sticky top-[49px] z-10 h-[49px] border-border/40 bg-muted hover:bg-muted";

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
  filters?: React.ReactNode;
  rows: FinanceCashFlowRow[];
  /** Операции выбранного периода до текстовых фильтров таблицы. */
  periodOperationCount?: number;
  /** Самая поздняя сохранённая дата среди всех операций, не только текущего фильтра. */
  latestRecordedDate?: string | null;
  /** Явный переход к периоду последней операции. Сам фильтр не переключается. */
  onShowRecordedPeriod?: () => void;
  articles: FinanceArticle[];
  counterparties: FinanceCounterparty[];
  deals: FinanceDeal[];
  autoRules: FinanceAutoRule[];
  onAssign?: (id: string, patch: CashflowAssignPatch) => void;
  onDelete?: (id: string) => void;
  onEdit?: (row: FinanceCashFlowRow) => void;
  onConvertToTransfer?: (row: FinanceCashFlowRow) => void;
  onUnlinkTransfer?: (id: string) => void;
  onAutoRuleCreated?: (values: AutoRuleFormValues) => void;
  onGoToRule?: (ruleId: string) => void;
}

export function FinanceCashflowTab({
  filters,
  rows,
  periodOperationCount,
  latestRecordedDate = null,
  onShowRecordedPeriod,
  articles,
  counterparties,
  deals,
  autoRules,
  onAssign,
  onDelete,
  onEdit,
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
      <Card className={tableSurfaceCardClass}>
        <CardContent className="p-0">
          <TableFilterSlot filters={filters} />
          <div className={cn(scrollTableYClass, scrollThinX, "max-w-full")}>
            <table className="w-full min-w-[68rem] table-fixed border-collapse caption-bottom text-sm">
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
                      {(periodOperationCount ?? rows.length) === 0 ? (
                        <div className="space-y-2">
                          <p>Нет операций в выбранном периоде</p>
                          {latestRecordedDate ? (
                            <>
                              <p>
                                Последняя сохранённая операция: {formatIsoDate(latestRecordedDate)}
                              </p>
                              {onShowRecordedPeriod ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="h-8 rounded-lg px-3 text-xs"
                                  onClick={onShowRecordedPeriod}
                                >
                                  Показать период с последней операцией
                                </Button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : (
                        "Нет операций по выбранным фильтрам"
                      )}
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
                        const bank = row.source === "BANK";
                        const paired = row.pairedTransfer === true;
                        return (
                        <TableRow
                          key={row.id}
                          className={cn(
                            tableBodyRowClass,
                            "relative z-0 !h-auto",
                            index % 2 === 1 && "bg-muted/40",
                            rowHighlightClass(row),
                          )}
                        >
                          <TableCell className={cn(cellPad, "max-w-0 align-top py-2 whitespace-normal tabular-nums")}>
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
                              <p className="text-muted-foreground mt-0.5 text-xs font-normal break-words [overflow-wrap:anywhere]">
                                {row.accountName}
                                {row.bankDocument ? (
                                  <span className="ml-2 inline-flex rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                                    Банк
                                  </span>
                                ) : row.source === "BANK" ? (
                                  <span className="ml-2 inline-flex rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                                    Встречная
                                  </span>
                                ) : (
                                  <span className="ml-2 inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
                                    Вручную
                                  </span>
                                )}
                              </p>
                            </div>
                          </TableCell>
                          {row.isTransfer ? (
                            <TableCell className={cn(cellPad, "max-w-0 align-top whitespace-normal text-center")}>
                              <p className={cn(transferMutedCellClass, "break-words [overflow-wrap:anywhere]")}>
                                {row.counterpartyName ?? "Между счетами"}
                              </p>
                            </TableCell>
                          ) : (
                            <TableCell className={cn(cellPad, "max-w-0 align-top whitespace-normal py-2 text-center")}>
                              <CashflowCounterpartySelect
                                row={row}
                                counterparties={counterparties}
                                onAssign={(patch) => assignRow(row, patch)}
                              />
                            </TableCell>
                          )}
                          <TableCell className={cn(cellPad, "max-w-0 overflow-hidden align-top whitespace-normal py-2 text-left")}>
                            <p
                              data-slot="dds-description"
                              className="w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                              title={row.description}
                            >
                              {row.description}
                            </p>
                          </TableCell>
                          {row.isTransfer ? (
                            <TableCell className={cn(cellPad, "max-w-0 align-top whitespace-normal")}>
                              <p className={cn(transferMutedCellClass, "break-words [overflow-wrap:anywhere]")}>
                                Между счетами
                              </p>
                            </TableCell>
                          ) : (
                            <TableCell className={cn(cellPad, "max-w-0 align-top whitespace-normal py-2 text-center")}>
                              <CashflowArticleSelect
                                row={row}
                                articles={articles}
                                onAssign={(patch) => assignRow(row, patch)}
                              />
                            </TableCell>
                          )}
                          {row.isTransfer ? (
                            <TableCell className={cn(cellPad, "max-w-0 align-top whitespace-normal")}>
                              <p className={cn(transferMutedCellClass, "break-words [overflow-wrap:anywhere]")}>
                                —
                              </p>
                            </TableCell>
                          ) : (
                            <TableCell className={cn(cellPad, "max-w-0 align-top whitespace-normal py-2 text-center")}>
                              <CashflowDealSelect
                                row={row}
                                deals={deals}
                                onAssign={(patch) => assignRow(row, patch)}
                              />
                            </TableCell>
                          )}
                          <TableCell className={cn(cellPad, "max-w-0 align-top whitespace-normal py-2 text-center")}>
                            <div className="flex flex-wrap items-center justify-center gap-0.5">
                              {!row.isTransfer && (
                                <AutoRuleQuickButton
                                  hasRule={Boolean(matchedRule)}
                                  onClick={() =>
                                    matchedRule ? onGoToRule?.(matchedRule.id) : openRule(row)
                                  }
                                />
                              )}
                              {!bank && !row.isTransfer && onEdit && (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className={tableActionClass}
                                        aria-label="Изменить"
                                        onClick={() => onEdit(row)}
                                      >
                                        <Pencil />
                                      </Button>
                                    }
                                  />
                                  <TooltipContent>Изменить</TooltipContent>
                                </Tooltip>
                              )}
                              {!paired && onConvertToTransfer && (
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
                              {paired && onUnlinkTransfer && (
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
                              {!bank && (
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
                              )}
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
