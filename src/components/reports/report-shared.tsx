import { cn } from "@/lib/utils";

export function SegmentTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="bg-muted inline-flex flex-wrap gap-1 rounded-2xl p-1"
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map(({ key, label }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              "h-10 cursor-pointer rounded-xl px-4 text-sm font-semibold transition-colors",
              active
                ? "bg-card text-foreground shadow-soft"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const WASTE_THRESHOLD = 30;

/** Цвет процента отхода: зеленеет до порога, краснеет выше. */
export function wastePercentClass(pct: number, threshold = WASTE_THRESHOLD): string {
  if (pct <= threshold) {
    if (pct <= threshold * 0.5) return "text-emerald-700";
    return "text-emerald-600";
  }
  if (pct <= threshold + 15) return "text-amber-600";
  if (pct <= threshold + 30) return "text-orange-600";
  return "text-red-600 font-semibold";
}
