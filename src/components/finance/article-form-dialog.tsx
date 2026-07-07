"use client";

import { useMemo, useState } from "react";
import { capitalizeFirst, cn } from "@/lib/utils";
import { useJustOpened } from "@/hooks/use-just-opened";
import type { FinanceArticle, FinanceCategory } from "@/mocks/finance-fixtures";
import {
  Field,
  FinanceFormDialog,
  fieldClass,
  selectTriggerClass,
  formSelectContentProps,
} from "@/components/finance/finance-form-shared";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ArticleFormValues {
  name: string;
  flowType: "INCOME" | "EXPENSE";
  categoryName: string;
  parentId: string | null;
  description: string;
}

interface ArticleFormDialogProps {
  open: boolean;
  articles: FinanceArticle[];
  categories?: FinanceCategory[];
  /** Если задана — режим редактирования. */
  article?: FinanceArticle | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: ArticleFormValues) => void;
}

export function ArticleFormDialog({
  open,
  articles,
  categories,
  article,
  onOpenChange,
  onSubmit,
}: ArticleFormDialogProps) {
  const isEdit = Boolean(article);

  const categoryNames = useMemo(() => {
    const names = (categories ?? []).map((c) => c.name);
    // При редактировании гарантируем, что текущая категория статьи есть в списке.
    if (article && !names.includes(article.categoryName)) return [article.categoryName, ...names];
    return names;
  }, [categories, article]);

  const noCategories = categoryNames.length === 0;
  const defaultCategory = categoryNames[0] ?? "";

  const [name, setName] = useState("");
  const [flowType, setFlowType] = useState<"INCOME" | "EXPENSE">("EXPENSE");
  const [categoryName, setCategoryName] = useState<string>(defaultCategory);
  const [parentId, setParentId] = useState("");
  const [description, setDescription] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  if (useJustOpened(open)) {
    setName(article?.name ?? "");
    setFlowType(article?.flowType ?? "EXPENSE");
    setCategoryName(article?.categoryName ?? defaultCategory);
    setParentId(article?.parentId ?? "");
    setDescription(article?.description ?? "");
    setShowErrors(false);
  }

  // Родителем может быть корневая статья того же типа, кроме самой себя.
  const rootArticles = useMemo(
    () => articles.filter((a) => a.flowType === flowType && !a.parentId && a.id !== article?.id),
    [articles, flowType, article],
  );

  const isOverhead = categoryName === "Производственные (накладные)";
  const canSubmit = name.trim().length > 0 && categoryName.length > 0 && !noCategories;

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit?.({
      name: trimmed,
      flowType,
      categoryName,
      parentId: parentId || null,
      description: description.trim(),
    });
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title={isEdit ? "Редактировать статью" : "Добавить статью"}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel={isEdit ? "Сохранить" : "Добавить"}
      canSubmit={canSubmit}
      onInvalid={() => setShowErrors(true)}
    >
      <Field
        id="art-name"
        label="Название"
        required
        invalid={showErrors && !name.trim()}
      >
        <Input
          id="art-name"
          value={name}
          onChange={(e) => setName(capitalizeFirst(e.target.value))}
          className={cn(fieldClass)}
          autoCapitalize="sentences"
          placeholder="Название статьи"
        />
      </Field>

      <Field id="art-flow" label="Тип" required>
        <Select
          value={flowType}
          onValueChange={(v) => {
            if (v === "INCOME" || v === "EXPENSE") {
              setFlowType(v);
              setParentId("");
            }
          }}
        >
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue>
              {flowType === "INCOME" ? "Поступление" : "Списание"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent {...formSelectContentProps}>
            <SelectItem value="EXPENSE" className="cursor-pointer rounded-lg">
              Списание
            </SelectItem>
            <SelectItem value="INCOME" className="cursor-pointer rounded-lg">
              Поступление
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field
        id="art-category"
        label="Категория"
        required
        invalid={showErrors && !noCategories && !categoryName}
      >
        {noCategories ? (
          <p className="text-muted-foreground rounded-xl bg-tag-blue-bg/40 px-3 py-2 text-xs leading-relaxed">
            Сначала создайте категорию во вкладке «Категории».
          </p>
        ) : (
          <Select value={categoryName} onValueChange={(v) => setCategoryName(v ?? "")}>
            <SelectTrigger className={selectTriggerClass}>
              <SelectValue>{categoryName}</SelectValue>
            </SelectTrigger>
            <SelectContent {...formSelectContentProps}>
              {categoryNames.map((c) => (
                <SelectItem key={c} value={c} className="cursor-pointer rounded-lg">
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <Field id="art-parent" label="Корневая статья">
        <p className="text-muted-foreground -mt-1 text-xs leading-relaxed">
          Если выбрана — новая статья станет субстатьёй
        </p>
        <Select value={parentId} onValueChange={(v) => setParentId(v ?? "")}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue placeholder="Корневая статья">
              {parentId
                ? rootArticles.find((a) => a.id === parentId)?.name
                : "Корневая статья"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent {...formSelectContentProps}>
            <SelectItem value="" className="cursor-pointer rounded-lg">
              Корневая статья
            </SelectItem>
            {rootArticles.map((a) => (
              <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg">
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id="art-description" label="Описание">
        <Input
          id="art-description"
          value={description}
          onChange={(e) => setDescription(capitalizeFirst(e.target.value))}
          className={cn(fieldClass)}
          autoCapitalize="sentences"
          placeholder="Необязательно"
        />
      </Field>

      {isOverhead && (
        <p className="text-muted-foreground rounded-xl bg-tag-blue-bg/40 px-3 py-2 text-xs leading-relaxed">
          Статьи этой категории участвуют в распределении накладных.
        </p>
      )}
    </FinanceFormDialog>
  );
}

export function articleValuesToRow(values: ArticleFormValues): FinanceArticle {
  return {
    id: `art-${Date.now()}`,
    name: values.name,
    flowType: values.flowType,
    categoryName: values.categoryName,
    isOverhead: values.categoryName === "Производственные (накладные)",
    parentId: values.parentId,
    description: values.description || undefined,
  };
}
