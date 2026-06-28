"use client";

import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FinanceArticle, FinanceAutoRule } from "@/mocks/finance-fixtures";
import { AutoRuleEditor } from "@/components/finance/auto-rule-editor";
import { Button } from "@/components/ui/button";

interface AutoRuleInlineRowProps {
  rule: FinanceAutoRule;
  articles: FinanceArticle[];
  highlighted?: boolean;
  onChange: (patch: Partial<FinanceAutoRule>) => void;
  onDelete: () => void;
}

export function AutoRuleInlineRow({
  rule,
  articles,
  highlighted,
  onChange,
  onDelete,
}: AutoRuleInlineRowProps) {
  return (
    <div
      className={cn(
        "hover:bg-muted/25 flex items-start gap-3 px-5 py-4",
        highlighted && "bg-brand/5 ring-brand/30 ring-2 ring-inset",
      )}
    >
      <AutoRuleEditor
        value={rule}
        articles={articles}
        onChange={onChange}
        className="min-w-0 flex-1"
      />

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 mt-0.5 size-8 shrink-0 cursor-pointer rounded-lg"
        aria-label="Удалить правило"
        onClick={onDelete}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
