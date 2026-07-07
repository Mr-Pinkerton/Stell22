import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import type { Detail, Sort } from "@/types/domain";

export const fieldClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 rounded-xl border px-4";

export const narrowFieldClass = cn(fieldClass, "w-full sm:max-w-none");

export const selectTriggerClass = cn(
  fieldClass,
  "w-full cursor-pointer data-[size=default]:h-10",
);

export const selectContentClass = "rounded-xl shadow-balanced ring-0 p-1.5";

export const formSelectContentProps = {
  className: selectContentClass,
  side: "bottom" as const,
  sideOffset: 8,
  alignItemWithTrigger: false,
};

export const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

export const tableActionDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

/** Оранжевая кнопка «Добавить …» внутри форм (как в форме партии). */
export const formAddButtonClass = "h-10 cursor-pointer rounded-xl";

export const SORT_LABEL: Record<Sort, string> = {
  SORT1: "Сорт 1",
  SORT2: "Сорт 2",
};

export const SORT_SHORT: Record<Sort, string> = {
  SORT1: "1 сорт",
  SORT2: "2 сорт",
};

export const RAIL_TYPE_LABEL = {
  POLKA: "Полка",
  KANAVKA: "Канавка",
} as const;

export function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Оранжевая подсветка незаполненного обязательного поля — показывается после
 * клика по неактивной кнопке создания. Ловит input/textarea и триггер селекта.
 */
export const fieldInvalidClass = cn(
  "[&_input]:border-amber-400 [&_input]:bg-amber-50",
  "[&_textarea]:border-amber-400 [&_textarea]:bg-amber-50",
  "[&_[data-slot=select-trigger]]:border-amber-400 [&_[data-slot=select-trigger]]:bg-amber-50",
);

export function Field({
  id,
  label,
  required,
  invalid,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  /** Подсветить поле оранжевым (не заполнено при попытке отправки). */
  invalid?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", invalid && fieldInvalidClass, className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
    </div>
  );
}

export function formatPrisadka(detail: Detail): string {
  const parts: string[] = [];
  if (detail.prisadkaTorcevaya) parts.push("Торцевая");
  if (detail.prisadkaPloskost) parts.push("По плоскости");
  return parts.length ? parts.join(", ") : "—";
}
