"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { financeAutoRules, financeArticles, type FinanceArticle, type FinanceAutoRule } from "@/mocks/finance-fixtures";
import { scrollTableYClass } from "@/lib/scroll-classes";
import { AutoRuleInlineRow } from "@/components/finance/auto-rule-inline-row";
import { Card, CardContent } from "@/components/ui/card";

interface FinanceAutoRulesTabProps {
  rules?: FinanceAutoRule[];
  articles?: FinanceArticle[];
  highlightRuleId?: string | null;
  onHighlightDone?: () => void;
  onRuleUpdate?: (id: string, patch: Partial<FinanceAutoRule>) => void;
  onRuleDelete?: (id: string) => void;
}

export function FinanceAutoRulesTab({
  rules = financeAutoRules,
  articles = financeArticles,
  highlightRuleId,
  onHighlightDone,
  onRuleUpdate,
  onRuleDelete,
}: FinanceAutoRulesTabProps) {
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!highlightRuleId) return;
    const el = rowRefs.current.get(highlightRuleId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const timer = window.setTimeout(() => onHighlightDone?.(), 2400);
    return () => window.clearTimeout(timer);
  }, [highlightRuleId, onHighlightDone, rules.length]);

  return (
    <Card className="surface-card ring-0">
      <CardContent className="p-0">
        <div className={scrollTableYClass}>
          {rules.length === 0 ? (
            <p className="text-muted-foreground px-5 py-10 text-center text-sm">
              Автоправил нет — нажмите «Добавить»
            </p>
          ) : (
            <div className="divide-border divide-y">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  ref={(node) => {
                    if (node) rowRefs.current.set(rule.id, node);
                    else rowRefs.current.delete(rule.id);
                  }}
                >
                  <AutoRuleInlineRow
                    rule={rule}
                    articles={articles}
                    highlighted={highlightRuleId === rule.id}
                    onChange={(patch) => onRuleUpdate?.(rule.id, patch)}
                    onDelete={() => {
                      onRuleDelete?.(rule.id);
                      toast.success("Автоправило удалено (прототип)");
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
