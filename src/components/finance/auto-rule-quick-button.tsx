"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface AutoRuleQuickButtonProps {
  /** Есть ли автоправило, которое сработало бы для этой строки. */
  hasRule: boolean;
  onClick: () => void;
}

/**
 * Маленькая кнопка «А» у строки ДДС: два состояния — автоправило есть
 * (клик открывает его на вкладке «Автоправила») или его нет (клик открывает
 * форму создания правила, предзаполненную данными строки).
 */
export function AutoRuleQuickButton({ hasRule, onClick }: AutoRuleQuickButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "size-8 cursor-pointer rounded-lg text-xs font-bold",
              hasRule
                ? "bg-violet-500/10 text-violet-700 hover:bg-violet-500/20"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
            aria-label={hasRule ? "Автоправило есть" : "Автоправила нет"}
            onClick={onClick}
          >
            А
          </Button>
        }
      />
      <TooltipContent>
        {hasRule ? "Автоправило есть — открыть" : "Автоправила нет — создать"}
      </TooltipContent>
    </Tooltip>
  );
}
