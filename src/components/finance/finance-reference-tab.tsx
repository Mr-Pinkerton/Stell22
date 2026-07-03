"use client";

import type {
  FinanceAccount,
  FinanceArticle,
  FinanceCategory,
  FinanceCounterparty,
} from "@/mocks/finance-fixtures";
import { SegmentTabs } from "@/components/reports/report-shared";
import { FinanceArticlesTab } from "@/components/finance/finance-articles-tab";
import { FinanceCategoriesTab } from "@/components/finance/finance-categories-tab";
import { FinanceCounterpartiesTab } from "@/components/finance/finance-counterparties-tab";
import { SettingsAccountsTab } from "@/components/settings/settings-accounts-tab";
import type { CategoryFormValues } from "@/components/finance/category-form-dialog";

export type ReferenceTab = "articles" | "categories" | "counterparties" | "accounts";

export const REFERENCE_TABS: { key: ReferenceTab; label: string }[] = [
  { key: "articles", label: "Статьи" },
  { key: "categories", label: "Категории" },
  { key: "counterparties", label: "Контрагенты" },
  { key: "accounts", label: "Счета" },
];

interface FinanceReferenceTabProps {
  activeSubTab: ReferenceTab;
  onSubTabChange: (tab: ReferenceTab) => void;

  articles: FinanceArticle[];
  onArticleEdit: (article: FinanceArticle) => void;
  onArticleDelete: (article: FinanceArticle) => void;

  categories: FinanceCategory[];
  onRegisterCategoryCreate: (fn: () => void) => void;
  onCategoryCreate: (values: CategoryFormValues) => void;
  onCategoryUpdate: (id: string, values: CategoryFormValues) => void;
  onCategoryDelete: (id: string) => void;

  counterparties: FinanceCounterparty[];
  onRegisterCounterpartyCreate: (fn: () => void) => void;
  onCounterpartyCreate: (name: string, inn: string) => void;
  onCounterpartyUpdate: (id: string, name: string, inn: string) => void;
  onCounterpartyDelete: (id: string) => void;

  accounts: FinanceAccount[];
  onAccountsChange: (accounts: FinanceAccount[]) => void;
  onRegisterAccountCreate: (fn: () => void) => void;
}

export function FinanceReferenceTab({
  activeSubTab,
  onSubTabChange,
  articles,
  onArticleEdit,
  onArticleDelete,
  categories,
  onRegisterCategoryCreate,
  onCategoryCreate,
  onCategoryUpdate,
  onCategoryDelete,
  counterparties,
  onRegisterCounterpartyCreate,
  onCounterpartyCreate,
  onCounterpartyUpdate,
  onCounterpartyDelete,
  accounts,
  onAccountsChange,
  onRegisterAccountCreate,
}: FinanceReferenceTabProps) {
  return (
    <div className="space-y-4">
      <SegmentTabs
        ariaLabel="Справочник"
        tabs={REFERENCE_TABS}
        value={activeSubTab}
        onChange={onSubTabChange}
      />

      {activeSubTab === "articles" && (
        <FinanceArticlesTab
          articles={articles}
          onEdit={onArticleEdit}
          onDelete={onArticleDelete}
        />
      )}
      {activeSubTab === "categories" && (
        <FinanceCategoriesTab
          categories={categories}
          onRegisterCreate={onRegisterCategoryCreate}
          onCreate={onCategoryCreate}
          onUpdate={onCategoryUpdate}
          onDelete={onCategoryDelete}
        />
      )}
      {activeSubTab === "counterparties" && (
        <FinanceCounterpartiesTab
          counterparties={counterparties}
          onRegisterCreate={onRegisterCounterpartyCreate}
          onCreate={onCounterpartyCreate}
          onUpdate={onCounterpartyUpdate}
          onDelete={onCounterpartyDelete}
        />
      )}
      {activeSubTab === "accounts" && (
        <SettingsAccountsTab
          accounts={accounts}
          onAccountsChange={onAccountsChange}
          onRegisterCreate={onRegisterAccountCreate}
        />
      )}
    </div>
  );
}
