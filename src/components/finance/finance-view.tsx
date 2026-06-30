"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { getDefaultDateFilterValue, type DateFilterValue } from "@/components/date-filter";
import type {
  FinanceAutoRule,
  FinanceCashFlowRow,
  FinanceDeal,
} from "@/mocks/finance-fixtures";
import { matchesDateFilter } from "@/lib/match-date-filter";
import {
  type FinanceData,
  assignCashFlow,
  createArticle,
  createAutoRule,
  createCashFlow,
  createCounterparty,
  createDeal,
  createStatement,
  deleteAutoRule,
  deleteCashFlow,
  deleteCounterparty,
  deleteDeal,
  importStatement,
  setDealStatus,
  updateAutoRule,
  updateCounterparty,
  updateDeal,
} from "@/server/finance";
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
import { CashflowFormDialog } from "@/components/finance/cashflow-form-dialog";
import { ArticleFormDialog } from "@/components/finance/article-form-dialog";
import {
  DealFormDialog,
  type DealFormValues,
} from "@/components/finance/deal-form-dialog";
import { StatementUploadDialog } from "@/components/finance/statement-upload-dialog";
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

export function FinanceView({ data }: { data: FinanceData }) {
  const [activeTab, setActiveTab] = useState<FinanceTab>("cashflow");
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(getDefaultDateFilterValue);
  const [, startTransition] = useTransition();

  const { batchOptions } = data;
  const [accounts, setAccounts] = useState(data.accounts);
  const [cashFlows, setCashFlows] = useState(data.cashFlows);
  const [articles, setArticles] = useState(data.articles);
  const [autoRules, setAutoRules] = useState(data.autoRules);
  const [counterparties, setCounterparties] = useState(data.counterparties);
  const [deals, setDeals] = useState(data.deals);
  const [statements, setStatements] = useState(data.statements);

  const [cashflowDialogOpen, setCashflowDialogOpen] = useState(false);
  const [articleDialogOpen, setArticleDialogOpen] = useState(false);
  const [dealDialogOpen, setDealDialogOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<FinanceDeal | null>(null);
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

  /** Обёртка server action: ловит ошибки и показывает тост. */
  const run = useCallback(
    (fn: () => Promise<void>) => {
      startTransition(async () => {
        try {
          await fn();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Не удалось выполнить операцию");
        }
      });
    },
    [startTransition],
  );

  const replaceCashFlow = (row: FinanceCashFlowRow) =>
    setCashFlows((prev) => prev.map((r) => (r.id === row.id ? row : r)));

  const replaceRule = (rule: FinanceAutoRule) =>
    setAutoRules((prev) => prev.map((r) => (r.id === rule.id ? rule : r)));

  const replaceDeal = (deal: FinanceDeal) =>
    setDeals((prev) => prev.map((d) => (d.id === deal.id ? deal : d)));

  const handleAdd = () => {
    switch (activeTab) {
      case "cashflow":
        setCashflowDialogOpen(true);
        break;
      case "articles":
        setArticleDialogOpen(true);
        break;
      case "rules":
        run(async () => {
          const rule = await createAutoRule({
            flowType: "EXPENSE",
            counterpartyName: null,
            logicOperator: "AND",
            descriptionKeywords: null,
            articleName: null,
            dealName: null,
          });
          setAutoRules((prev) => [rule, ...prev]);
          setHighlightRuleId(rule.id);
        });
        break;
      case "deals":
        setEditingDeal(null);
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

        <FinanceKpiBlock rows={filteredCashFlows} accounts={accounts} articles={articles} />

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
            counterparties={counterparties}
            deals={deals}
            onAssign={(id, patch) =>
              run(async () => {
                replaceCashFlow(await assignCashFlow(id, patch));
              })
            }
            onDelete={(id) =>
              run(async () => {
                await deleteCashFlow(id);
                setCashFlows((prev) => prev.filter((r) => r.id !== id));
                toast.success("Операция удалена");
              })
            }
            onAutoRuleCreated={(values) =>
              run(async () => {
                const rule = await createAutoRule(values);
                setAutoRules((prev) => [rule, ...prev]);
                toast.success("Автоправило сохранено");
              })
            }
          />
        )}
        {activeTab === "articles" && <FinanceArticlesTab articles={articles} />}
        {activeTab === "rules" && (
          <FinanceAutoRulesTab
            rules={autoRules}
            articles={articles}
            counterparties={counterparties}
            highlightRuleId={highlightRuleId}
            onHighlightDone={() => setHighlightRuleId(null)}
            onRuleUpdate={(id, patch) =>
              run(async () => {
                replaceRule(await updateAutoRule(id, patch));
              })
            }
            onRuleDelete={(id) =>
              run(async () => {
                await deleteAutoRule(id);
                setAutoRules((prev) => prev.filter((rule) => rule.id !== id));
                if (highlightRuleId === id) setHighlightRuleId(null);
                toast.success("Автоправило удалено");
              })
            }
          />
        )}
        {activeTab === "deals" && (
          <FinanceDealsTab
            deals={deals}
            cashFlows={cashFlows}
            onEdit={(deal) => {
              setEditingDeal(deal);
              setDealDialogOpen(true);
            }}
            onArchiveToggle={(deal) =>
              run(async () => {
                replaceDeal(
                  await setDealStatus(deal.id, deal.status === "ARCHIVED" ? "OPEN" : "ARCHIVED"),
                );
              })
            }
            onDelete={(deal) =>
              run(async () => {
                await deleteDeal(deal.id);
                setDeals((prev) => prev.filter((d) => d.id !== deal.id));
                toast.success("Сделка удалена");
              })
            }
          />
        )}
        {activeTab === "statements" && (
          <FinanceStatementsTab
            statements={statements}
            onUploadRequest={() => setStatementDialogOpen(true)}
          />
        )}
        {activeTab === "counterparties" && (
          <FinanceCounterpartiesTab
            counterparties={counterparties}
            onRegisterCreate={registerCounterpartyCreate}
            onCreate={(name) =>
              run(async () => {
                const cp = await createCounterparty(name);
                setCounterparties((prev) =>
                  [...prev, cp].sort((a, b) => a.name.localeCompare(b.name)),
                );
                toast.success("Контрагент добавлен");
              })
            }
            onUpdate={(id, name) =>
              run(async () => {
                const cp = await updateCounterparty(id, name);
                setCounterparties((prev) =>
                  prev
                    .map((c) => (c.id === id ? cp : c))
                    .sort((a, b) => a.name.localeCompare(b.name)),
                );
                toast.success("Контрагент обновлён");
              })
            }
            onDelete={(id) =>
              run(async () => {
                await deleteCounterparty(id);
                setCounterparties((prev) => prev.filter((c) => c.id !== id));
                toast.success("Контрагент удалён");
              })
            }
          />
        )}
      </div>

      <CashflowFormDialog
        open={cashflowDialogOpen}
        accounts={accounts}
        counterparties={counterparties}
        articles={articles}
        deals={deals}
        onOpenChange={setCashflowDialogOpen}
        onSubmit={(values) =>
          run(async () => {
            const row = await createCashFlow(values);
            setCashFlows((prev) => [row, ...prev]);
            toast.success("Операция добавлена");
          })
        }
      />

      <ArticleFormDialog
        open={articleDialogOpen}
        articles={articles}
        onOpenChange={setArticleDialogOpen}
        onSubmit={(values) =>
          run(async () => {
            const article = await createArticle(values);
            setArticles((prev) => [...prev, article]);
            toast.success("Статья добавлена");
          })
        }
      />

      <DealFormDialog
        open={dealDialogOpen}
        batches={batchOptions}
        deal={editingDeal}
        onOpenChange={setDealDialogOpen}
        onSubmit={(values: DealFormValues) =>
          run(async () => {
            if (editingDeal) {
              replaceDeal(await updateDeal(editingDeal.id, values));
              toast.success("Сделка обновлена");
            } else {
              const deal = await createDeal(values);
              setDeals((prev) => [deal, ...prev]);
              toast.success("Сделка добавлена");
            }
          })
        }
      />

      <StatementUploadDialog
        open={statementDialogOpen}
        accounts={accounts}
        onOpenChange={setStatementDialogOpen}
        onSubmit={(values) =>
          run(async () => {
            if (values.is1C) {
              const res = await importStatement(values.content, values.fileName);
              setStatements((prev) => [res.statement, ...prev]);
              setCashFlows((prev) => [...res.newCashFlows, ...prev]);
              setAccounts(res.accounts);
              setCounterparties(res.counterparties);
              toast.success(
                `Импортировано операций: ${res.importedCount}` +
                  (res.unassignedCount ? `, без статьи: ${res.unassignedCount}` : ""),
              );
            } else {
              const row = await createStatement(values);
              setStatements((prev) => [row, ...prev]);
              toast.success(`Выписка «${values.fileName}» загружена`);
            }
          })
        }
      />
    </>
  );
}
