"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { ArrowLeftRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { getDefaultDateFilterValue, type DateFilterValue } from "@/components/date-filter";
import type {
  FinanceArticle,
  FinanceAutoRule,
  FinanceCashFlowRow,
  FinanceDeal,
} from "@/mocks/finance-fixtures";
import { matchesDateFilter } from "@/lib/match-date-filter";
import { computeAccountBalances, isAccountConfirmed } from "@/lib/account-balance";
import {
  type FinanceData,
  assignCashFlow,
  createArticle,
  createArticleCategory,
  createAutoRule,
  createCashFlow,
  createCounterparty,
  createDeal,
  createStatement,
  createTransfer,
  deleteArticle,
  deleteArticleCategory,
  deleteAutoRule,
  deleteCashFlow,
  deleteCounterparty,
  deleteDeal,
  deleteStatement,
  getStatementDetail,
  importStatement,
  reapplyAutoRules,
  setDealStatus,
  updateArticle,
  updateArticleCategory,
  updateAutoRule,
  updateCounterparty,
  updateDeal,
} from "@/server/finance";
import { exportXlsx } from "@/lib/export-xlsx";
import { XLSX_FMT, type XlsxSheet } from "@/lib/xlsx-types";
import { formatIsoDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { SegmentTabs } from "@/components/reports/report-shared";

const flowTypeLabel = (t: "INCOME" | "EXPENSE") => (t === "INCOME" ? "Доход" : "Расход");
const dealStatusLabel = (s: string) =>
  s === "OPEN" ? "Открыта" : s === "ARCHIVED" ? "Архив" : s;
import { FinanceKpiBlock } from "@/components/finance/finance-kpi-block";
import { FinanceCashflowTab } from "@/components/finance/finance-cashflow-tab";
import { FinanceAutoRulesTab } from "@/components/finance/finance-auto-rules-tab";
import { FinanceDealsTab } from "@/components/finance/finance-deals-tab";
import { FinanceStatementsTab } from "@/components/finance/finance-statements-tab";
import {
  FinanceReferenceTab,
  type ReferenceTab,
} from "@/components/finance/finance-reference-tab";
import { CashflowFormDialog } from "@/components/finance/cashflow-form-dialog";
import { TransferFormDialog } from "@/components/finance/transfer-form-dialog";
import { ArticleFormDialog } from "@/components/finance/article-form-dialog";
import {
  DealFormDialog,
  type DealFormValues,
} from "@/components/finance/deal-form-dialog";
import { StatementUploadDialog } from "@/components/finance/statement-upload-dialog";
import { Button } from "@/components/ui/button";

type FinanceTab = "cashflow" | "reference" | "rules" | "deals" | "statements";

const TABS: { key: FinanceTab; label: string }[] = [
  { key: "cashflow", label: "ДДС" },
  { key: "reference", label: "Справочник" },
  { key: "rules", label: "Автоправила" },
  { key: "deals", label: "Сделки" },
  { key: "statements", label: "Выписки" },
];

const tabActionButtonClass =
  "h-10 shrink-0 cursor-pointer rounded-xl px-5 [&_svg]:stroke-[1.75]";

export function FinanceView({ data }: { data: FinanceData }) {
  const [activeTab, setActiveTab] = useState<FinanceTab>("cashflow");
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(getDefaultDateFilterValue);
  const [, startTransition] = useTransition();
  const [exporting, startExport] = useTransition();

  const [referenceTab, setReferenceTab] = useState<ReferenceTab>("articles");

  const { batchOptions } = data;
  const [accounts, setAccounts] = useState(data.accounts);
  const [cashFlows, setCashFlows] = useState(data.cashFlows);
  const [articles, setArticles] = useState(data.articles);
  const [categories, setCategories] = useState(data.categories);
  const [autoRules, setAutoRules] = useState(data.autoRules);
  const [counterparties, setCounterparties] = useState(data.counterparties);
  const [deals, setDeals] = useState(data.deals);
  const [statements, setStatements] = useState(data.statements);

  const [cashflowDialogOpen, setCashflowDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [articleDialogOpen, setArticleDialogOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<FinanceArticle | null>(null);
  const [dealDialogOpen, setDealDialogOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<FinanceDeal | null>(null);
  const [statementDialogOpen, setStatementDialogOpen] = useState(false);
  const [highlightRuleId, setHighlightRuleId] = useState<string | null>(null);

  const counterpartyCreateRef = useRef<(() => void) | null>(null);
  const categoryCreateRef = useRef<(() => void) | null>(null);
  const accountCreateRef = useRef<(() => void) | null>(null);

  const filteredCashFlows = useMemo(
    () => cashFlows.filter((row) => matchesDateFilter(row.date, dateFilter)),
    [cashFlows, dateFilter],
  );

  // Остаток на счетах считается от «якорей» по ВСЕМ операциям (без фильтра
  // периода) — это остаток на текущую дату, а не за выбранный период.
  // Неподтверждённые счета (в карантине после импорта) не участвуют — как и их
  // операции, которых нет в `cashFlows`. Отдаём остаток по каждому счёту, чтобы
  // плитка показала основные крупно, остальные — мелко.
  const balanceTileAccounts = useMemo(() => {
    const confirmed = accounts.filter((a) => isAccountConfirmed(a.confirmed));
    const balances = computeAccountBalances(
      confirmed.map((a) => ({
        id: a.id,
        openingBalance: a.openingBalance ?? 0,
        balanceAsOf: a.openingDate ?? null,
      })),
      cashFlows.map((r) => ({
        accountId: r.accountId ?? "",
        date: r.date,
        flowType: r.flowType,
        amount: r.amount,
      })),
    );
    return confirmed.map((a) => ({
      id: a.id,
      name: a.name,
      balance: balances.get(a.id) ?? a.openingBalance ?? 0,
      isPrimary: a.isPrimary,
      confirmed: a.confirmed,
    }));
  }, [accounts, cashFlows]);

  const buildFinanceSheet = (): XlsxSheet => {
    // На вкладке «Справочник» выгружаем активную подвкладку.
    const exportKey = activeTab === "reference" ? referenceTab : activeTab;
    switch (exportKey) {
      case "articles":
        return {
          name: "Статьи",
          columns: [
            { header: "Название", key: "name", width: 28 },
            { header: "Тип", key: "flowType", width: 12 },
            { header: "Категория", key: "category", width: 20 },
            { header: "Накладные", key: "overhead", width: 12 },
          ],
          rows: articles.map((a) => ({
            name: a.name,
            flowType: flowTypeLabel(a.flowType),
            category: a.categoryName,
            overhead: a.isOverhead ? "Да" : "Нет",
          })),
        };
      case "categories":
        return {
          name: "Категории",
          columns: [
            { header: "Название", key: "name", width: 32 },
            { header: "Накладные", key: "overhead", width: 12 },
            { header: "Статей", key: "count", numFmt: XLSX_FMT.int },
          ],
          rows: categories.map((c) => ({
            name: c.name,
            overhead: c.isOverhead ? "Да" : "Нет",
            count: c.articleCount,
          })),
        };
      case "accounts":
        return {
          name: "Счета",
          columns: [
            { header: "Счёт", key: "name", width: 32 },
            { header: "Начальный остаток", key: "opening", numFmt: XLSX_FMT.money },
            { header: "На дату", key: "date", width: 14 },
            { header: "Остаток", key: "balance", numFmt: XLSX_FMT.money },
            { header: "Подтверждён", key: "confirmed", width: 14 },
          ],
          rows: accounts.map((a) => ({
            name: a.name,
            opening: a.openingBalance ?? 0,
            date: a.openingDate ? formatIsoDate(a.openingDate) : "",
            balance: a.balance,
            confirmed: a.confirmed === false ? "Нет" : "Да",
          })),
        };
      case "rules":
        return {
          name: "Автоправила",
          columns: [
            { header: "Тип", key: "flowType", width: 12 },
            { header: "Контрагент", key: "counterparty", width: 28 },
            { header: "Логика", key: "logic", width: 10 },
            { header: "Ключевые слова", key: "keywords", width: 28 },
            { header: "Статья", key: "article", width: 22 },
            { header: "Сделка", key: "deal", width: 22 },
          ],
          rows: autoRules.map((r) => ({
            flowType: flowTypeLabel(r.flowType),
            counterparty: r.counterpartyName ?? "",
            logic: r.logicOperator,
            keywords: r.descriptionKeywords ?? "",
            article: r.articleName ?? "",
            deal: r.dealName ?? "",
          })),
        };
      case "deals":
        return {
          name: "Сделки",
          columns: [
            { header: "Сделка", key: "name", width: 28 },
            { header: "Статус", key: "status", width: 12 },
            { header: "Сумма", key: "total", numFmt: XLSX_FMT.money },
            { header: "Доставка", key: "delivery", numFmt: XLSX_FMT.money },
            { header: "Партии", key: "batches", width: 32 },
          ],
          rows: deals.map((d) => ({
            name: d.name,
            status: dealStatusLabel(d.status),
            total: d.total,
            delivery: d.deliveryExtra,
            batches: d.batchNames.join(", "),
          })),
        };
      case "statements":
        return {
          name: "Выписки",
          columns: [
            { header: "Дата", key: "date", width: 14 },
            { header: "Счёт", key: "account", width: 28 },
            { header: "Операций", key: "ops", numFmt: XLSX_FMT.int },
            { header: "Без статьи", key: "unassigned", numFmt: XLSX_FMT.int },
            { header: "Загружена", key: "uploaded", width: 12 },
          ],
          rows: statements.map((s) => ({
            date: formatIsoDate(s.date),
            account: s.accountName ?? "",
            ops: s.operationsCount,
            unassigned: s.unassignedCount,
            uploaded: s.uploaded ? "Да" : "Нет",
          })),
        };
      case "counterparties":
        return {
          name: "Контрагенты",
          columns: [
            { header: "Название", key: "name", width: 32 },
            { header: "ИНН", key: "inn", width: 16 },
          ],
          rows: counterparties.map((c) => ({ name: c.name, inn: c.inn ?? "" })),
        };
      default:
        return {
          name: "ДДС",
          columns: [
            { header: "Дата", key: "date", width: 14 },
            { header: "Тип", key: "flowType", width: 10 },
            { header: "Сумма", key: "amount", numFmt: XLSX_FMT.money },
            { header: "Счёт", key: "account", width: 24 },
            { header: "Контрагент", key: "counterparty", width: 28 },
            { header: "Описание", key: "description", width: 36 },
            { header: "Статья", key: "article", width: 22 },
            { header: "Сделка", key: "deal", width: 22 },
          ],
          rows: filteredCashFlows.map((r) => ({
            date: formatIsoDate(r.date),
            flowType: r.isTransfer ? "Перевод" : flowTypeLabel(r.flowType),
            amount: r.amount,
            account: r.accountName,
            counterparty: r.counterpartyName ?? "",
            description: r.description,
            article: r.articleName ?? "",
            deal: r.dealName ?? "",
          })),
        };
    }
  };

  const handleExport = () =>
    startExport(async () => {
      try {
        const sheet = buildFinanceSheet();
        await exportXlsx(`финансы-${sheet.name.toLowerCase()}`, [sheet]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Не удалось выгрузить");
      }
    });

  const registerCounterpartyCreate = useCallback((fn: () => void) => {
    counterpartyCreateRef.current = fn;
  }, []);

  const registerCategoryCreate = useCallback((fn: () => void) => {
    categoryCreateRef.current = fn;
  }, []);

  const registerAccountCreate = useCallback((fn: () => void) => {
    accountCreateRef.current = fn;
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

  const handleReapply = () =>
    run(async () => {
      const res = await reapplyAutoRules();
      if (res.assigned > 0) {
        const map = new Map(res.updated.map((r) => [r.id, r]));
        setCashFlows((prev) => prev.map((r) => map.get(r.id) ?? r));
        toast.success(`Разнесено по правилам: ${res.assigned}`);
      } else {
        toast.message("Нет неразнесённых операций под правила");
      }
    });

  const replaceDeal = (deal: FinanceDeal) =>
    setDeals((prev) => prev.map((d) => (d.id === deal.id ? deal : d)));

  const handleAddReference = () => {
    switch (referenceTab) {
      case "articles":
        setEditingArticle(null);
        setArticleDialogOpen(true);
        break;
      case "categories":
        categoryCreateRef.current?.();
        break;
      case "counterparties":
        counterpartyCreateRef.current?.();
        break;
      case "accounts":
        accountCreateRef.current?.();
        break;
    }
  };

  const handleAdd = () => {
    switch (activeTab) {
      case "cashflow":
        setCashflowDialogOpen(true);
        break;
      case "reference":
        handleAddReference();
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
    }
  };

  return (
    <>
      <PageHeader
        title="Финансы"
        canExport
        exporting={exporting}
        onExport={handleExport}
      />

      <div className="space-y-4">
        <FiltersBar
          date
          dateAllTime
          dateFilterValue={dateFilter}
          onDateFilterChange={setDateFilter}
        />

        <FinanceKpiBlock rows={filteredCashFlows} accounts={balanceTileAccounts} articles={articles} />

        <SegmentTabs
          ariaLabel="Финансы"
          tabs={TABS}
          value={activeTab}
          onChange={setActiveTab}
          trailing={
            <div className="flex items-center gap-2">
              {activeTab === "rules" && (
                <Button
                  variant="outline"
                  className={tabActionButtonClass}
                  onClick={handleReapply}
                >
                  Разнести по правилам
                </Button>
              )}
              {activeTab === "cashflow" && (
                <Button
                  variant="outline"
                  className={tabActionButtonClass}
                  onClick={() => setTransferDialogOpen(true)}
                >
                  <ArrowLeftRight />
                  Перевод
                </Button>
              )}
              <Button className={tabActionButtonClass} onClick={handleAdd}>
                <Plus />
                Добавить
              </Button>
            </div>
          }
        />

        {activeTab === "cashflow" && (
          <FinanceCashflowTab
            rows={filteredCashFlows}
            articles={articles}
            counterparties={counterparties}
            deals={deals}
            autoRules={autoRules}
            onAssign={(id, patch) =>
              run(async () => {
                replaceCashFlow(await assignCashFlow(id, patch));
              })
            }
            onDelete={(id) =>
              run(async () => {
                const removed = await deleteCashFlow(id);
                const removedSet = new Set(removed);
                setCashFlows((prev) => prev.filter((r) => !removedSet.has(r.id)));
                toast.success(removed.length > 1 ? "Перевод удалён" : "Операция удалена");
              })
            }
            onAutoRuleCreated={(values) =>
              run(async () => {
                const rule = await createAutoRule(values);
                setAutoRules((prev) => [rule, ...prev]);
                toast.success("Автоправило сохранено");
              })
            }
            onGoToRule={(ruleId) => {
              setActiveTab("rules");
              setHighlightRuleId(ruleId);
            }}
          />
        )}
        {activeTab === "reference" && (
          <FinanceReferenceTab
            activeSubTab={referenceTab}
            onSubTabChange={setReferenceTab}
            articles={articles}
            onArticleEdit={(article) => {
              setEditingArticle(article);
              setArticleDialogOpen(true);
            }}
            onArticleDelete={(article) =>
              run(async () => {
                await deleteArticle(article.id);
                setArticles((prev) => prev.filter((a) => a.id !== article.id));
                toast.success("Статья удалена");
              })
            }
            categories={categories}
            onRegisterCategoryCreate={registerCategoryCreate}
            onCategoryCreate={(values) =>
              run(async () => {
                const category = await createArticleCategory(values.name, values.isOverhead);
                setCategories((prev) =>
                  [...prev, category].sort((a, b) => a.name.localeCompare(b.name)),
                );
                toast.success("Категория добавлена");
              })
            }
            onCategoryUpdate={(id, values) =>
              run(async () => {
                const prevName = categories.find((c) => c.id === id)?.name;
                const category = await updateArticleCategory(id, values.name, values.isOverhead);
                setCategories((prev) => prev.map((c) => (c.id === id ? category : c)));
                // Статьи хранят имя категории строкой — синхронизируем при переименовании.
                if (prevName && prevName !== category.name) {
                  setArticles((prev) =>
                    prev.map((a) =>
                      a.categoryName === prevName
                        ? { ...a, categoryName: category.name, isOverhead: category.isOverhead }
                        : a,
                    ),
                  );
                }
                toast.success("Категория обновлена");
              })
            }
            onCategoryDelete={(id) =>
              run(async () => {
                await deleteArticleCategory(id);
                setCategories((prev) => prev.filter((c) => c.id !== id));
                toast.success("Категория удалена");
              })
            }
            counterparties={counterparties}
            onRegisterCounterpartyCreate={registerCounterpartyCreate}
            onCounterpartyCreate={(name, inn) =>
              run(async () => {
                const cp = await createCounterparty(name, inn);
                setCounterparties((prev) =>
                  [...prev, cp].sort((a, b) => a.name.localeCompare(b.name)),
                );
                toast.success("Контрагент добавлен");
              })
            }
            onCounterpartyUpdate={(id, name, inn) =>
              run(async () => {
                const cp = await updateCounterparty(id, name, inn);
                setCounterparties((prev) =>
                  prev
                    .map((c) => (c.id === id ? cp : c))
                    .sort((a, b) => a.name.localeCompare(b.name)),
                );
                toast.success("Контрагент обновлён");
              })
            }
            onCounterpartyDelete={(id) =>
              run(async () => {
                await deleteCounterparty(id);
                setCounterparties((prev) => prev.filter((c) => c.id !== id));
                toast.success("Контрагент удалён");
              })
            }
            accounts={accounts}
            onAccountsChange={setAccounts}
            onRegisterAccountCreate={registerAccountCreate}
          />
        )}
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
            onLoadDetail={(id) => getStatementDetail(id)}
            onDelete={(id) =>
              run(async () => {
                const res = await deleteStatement(id);
                const removedSet = new Set(res.removedIds);
                setStatements((prev) => prev.filter((s) => s.id !== id));
                setCashFlows((prev) => prev.filter((c) => !removedSet.has(c.id)));
                setAccounts(res.accounts);
                toast.success(`Выписка откачена (операций: ${res.removedIds.length})`);
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

      <TransferFormDialog
        open={transferDialogOpen}
        accounts={accounts}
        onOpenChange={setTransferDialogOpen}
        onSubmit={(values) =>
          run(async () => {
            const legs = await createTransfer(values);
            setCashFlows((prev) => [...legs, ...prev]);
            toast.success("Перевод добавлен");
          })
        }
      />

      <ArticleFormDialog
        open={articleDialogOpen}
        articles={articles}
        categories={categories}
        article={editingArticle}
        onOpenChange={setArticleDialogOpen}
        onSubmit={(values) =>
          run(async () => {
            if (editingArticle) {
              const article = await updateArticle(editingArticle.id, values);
              setArticles((prev) => prev.map((a) => (a.id === editingArticle.id ? article : a)));
              toast.success("Статья обновлена");
            } else {
              const article = await createArticle(values);
              setArticles((prev) => [...prev, article]);
              toast.success("Статья добавлена");
            }
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
        onSubmit={(items) =>
          run(async () => {
            let imported = 0;
            let unassigned = 0;
            let skipped = 0;

            for (const values of items) {
              if (!values.is1C) {
                const row = await createStatement(values);
                setStatements((prev) => [row, ...prev]);
                toast.success(`Выписка «${values.fileName}» загружена`);
                continue;
              }

              // Последовательно: каждый импорт может создать счёт, который
              // следующая выписка уже найдёт по номеру (переводы между своими).
              const res = await importStatement(
                values.content,
                values.fileName,
                values.bindAccountId,
              );
              setStatements((prev) => [res.statement, ...prev]);
              setCashFlows((prev) => [...res.newCashFlows, ...prev]);
              setAccounts(res.accounts);
              setCounterparties(res.counterparties);
              imported += res.importedCount;
              unassigned += res.unassignedCount;
              skipped += res.skippedCount;
              if (res.warning) toast.warning(`${values.fileName}: ${res.warning}`);
            }

            const total1C = items.filter((v) => v.is1C).length;
            if (total1C > 0) {
              toast.success(
                (total1C > 1 ? `Выписок: ${total1C}. ` : "") +
                  `Импортировано операций: ${imported}` +
                  (unassigned ? `, без статьи: ${unassigned}` : "") +
                  (skipped ? `, пропущено дублей: ${skipped}` : ""),
              );
            }
          })
        }
      />
    </>
  );
}
