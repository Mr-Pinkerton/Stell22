"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { getDefaultDateFilterValue, type DateFilterValue } from "@/components/date-filter";
import {
  financeArticles,
  financeAutoRules,
  financeCashFlows,
  financeDeals,
  financeStatements,
  createEmptyAutoRule,
} from "@/mocks/finance-fixtures";
import { matchesDateFilter } from "@/lib/match-date-filter";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { SegmentTabs } from "@/components/reports/report-shared";
import { FinanceKpiBlock } from "@/components/finance/finance-kpi-block";
import { FinanceCashflowTab } from "@/components/finance/finance-cashflow-tab";
import { FinanceArticlesTab } from "@/components/finance/finance-articles-tab";
import { FinanceAutoRulesTab } from "@/components/finance/finance-auto-rules-tab";
import { FinanceDealsTab } from "@/components/finance/finance-deals-tab";
import { FinanceStatementsTab } from "@/components/finance/finance-statements-tab";
import { FinanceCounterpartiesTab } from "@/components/finance/finance-counterparties-tab";
import { autoRuleValuesToRow } from "@/components/finance/auto-rule-form-dialog";
import {
  CashflowFormDialog,
  cashflowValuesToRow,
} from "@/components/finance/cashflow-form-dialog";
import {
  ArticleFormDialog,
  articleValuesToRow,
} from "@/components/finance/article-form-dialog";
import { DealFormDialog, dealValuesToRow } from "@/components/finance/deal-form-dialog";
import {
  StatementUploadDialog,
  statementUploadToRow,
} from "@/components/finance/statement-upload-dialog";
import { Button } from "@/components/ui/button";

type FinanceTab =
  | "cashflow"
  | "articles"
  | "rules"
  | "deals"
  | "statements"
  | "counterparties";

const TABS: { key: FinanceTab; label: string }[] = [
  { key: "cashflow", label: "ДДС" },
  { key: "articles", label: "Статьи" },
  { key: "rules", label: "Автоправила" },
  { key: "deals", label: "Сделки" },
  { key: "statements", label: "Выписки" },
  { key: "counterparties", label: "Контрагенты" },
];

const tabActionButtonClass =
  "h-10 shrink-0 cursor-pointer rounded-xl px-5 [&_svg]:stroke-[1.75]";

export function FinanceView() {
  const [activeTab, setActiveTab] = useState<FinanceTab>("cashflow");
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(getDefaultDateFilterValue);

  const [cashFlows, setCashFlows] = useState(financeCashFlows);
  const [articles, setArticles] = useState(financeArticles);
  const [autoRules, setAutoRules] = useState(financeAutoRules);
  const [deals, setDeals] = useState(financeDeals);
  const [statements, setStatements] = useState(financeStatements);

  const [cashflowDialogOpen, setCashflowDialogOpen] = useState(false);
  const [articleDialogOpen, setArticleDialogOpen] = useState(false);
  const [dealDialogOpen, setDealDialogOpen] = useState(false);
  const [statementDialogOpen, setStatementDialogOpen] = useState(false);
  const [highlightRuleId, setHighlightRuleId] = useState<string | null>(null);

  const counterpartyCreateRef = useRef<(() => void) | null>(null);

  const filteredCashFlows = useMemo(
    () => cashFlows.filter((row) => matchesDateFilter(row.date, dateFilter)),
    [cashFlows, dateFilter],
  );

  const registerCounterpartyCreate = useCallback((fn: () => void) => {
    counterpartyCreateRef.current = fn;
  }, []);

  const handleAdd = () => {
    switch (activeTab) {
      case "cashflow":
        setCashflowDialogOpen(true);
        break;
      case "articles":
        setArticleDialogOpen(true);
        break;
      case "rules": {
        const rule = createEmptyAutoRule();
        setAutoRules((prev) => [rule, ...prev]);
        setHighlightRuleId(rule.id);
        break;
      }
      case "deals":
        setDealDialogOpen(true);
        break;
      case "statements":
        setStatementDialogOpen(true);
        break;
      case "counterparties":
        counterpartyCreateRef.current?.();
        break;
    }
  };

  return (
    <>
      <PageHeader
        title="Финансы"
        canExport
        onExport={() => toast.message("Экспорт — прототип")}
      />

      <div className="space-y-4">
        <FiltersBar
          date
          dateAllTime
          dateFilterValue={dateFilter}
          onDateFilterChange={setDateFilter}
        />

        <FinanceKpiBlock rows={filteredCashFlows} />

        <SegmentTabs
          ariaLabel="Финансы"
          tabs={TABS}
          value={activeTab}
          onChange={setActiveTab}
          trailing={
            <Button className={tabActionButtonClass} onClick={handleAdd}>
              <Plus />
              Добавить
            </Button>
          }
        />

        {activeTab === "cashflow" && (
          <FinanceCashflowTab
            rows={filteredCashFlows}
            articles={articles}
            onRowUpdate={(id, patch) => {
              setCashFlows((prev) =>
                prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
              );
            }}
            onAutoRuleCreated={(values) => {
              setAutoRules((prev) => [autoRuleValuesToRow(values), ...prev]);
              toast.success("Автоправило сохранено (прототип)");
            }}
          />
        )}
        {activeTab === "articles" && <FinanceArticlesTab articles={articles} />}
        {activeTab === "rules" && (
          <FinanceAutoRulesTab
            rules={autoRules}
            articles={articles}
            highlightRuleId={highlightRuleId}
            onHighlightDone={() => setHighlightRuleId(null)}
            onRuleUpdate={(id, patch) => {
              setAutoRules((prev) =>
                prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
              );
            }}
            onRuleDelete={(id) => {
              setAutoRules((prev) => prev.filter((rule) => rule.id !== id));
              if (highlightRuleId === id) setHighlightRuleId(null);
            }}
          />
        )}
        {activeTab === "deals" && (
          <FinanceDealsTab deals={deals} cashFlows={cashFlows} />
        )}
        {activeTab === "statements" && (
          <FinanceStatementsTab
            statements={statements}
            onUploadRequest={() => setStatementDialogOpen(true)}
          />
        )}
        {activeTab === "counterparties" && (
          <FinanceCounterpartiesTab onRegisterCreate={registerCounterpartyCreate} />
        )}
      </div>

      <CashflowFormDialog
        open={cashflowDialogOpen}
        onOpenChange={setCashflowDialogOpen}
        onSubmit={(values) => {
          setCashFlows((prev) => [...prev, cashflowValuesToRow(values)]);
          toast.success("Операция добавлена (прототип)");
        }}
      />

      <ArticleFormDialog
        open={articleDialogOpen}
        articles={articles}
        onOpenChange={setArticleDialogOpen}
        onSubmit={(values) => {
          setArticles((prev) => [...prev, articleValuesToRow(values)]);
          toast.success("Статья добавлена (прототип)");
        }}
      />

      <DealFormDialog
        open={dealDialogOpen}
        onOpenChange={setDealDialogOpen}
        onSubmit={(values) => {
          setDeals((prev) => [dealValuesToRow(values), ...prev]);
          toast.success("Сделка добавлена (прототип)");
        }}
      />

      <StatementUploadDialog
        open={statementDialogOpen}
        onOpenChange={setStatementDialogOpen}
        onSubmit={(values) => {
          setStatements((prev) => [statementUploadToRow(values), ...prev]);
          toast.success(`Выписка «${values.fileName}» загружена (прототип)`);
        }}
      />
    </>
  );
}
