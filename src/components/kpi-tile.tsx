import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface KpiTileProps {
  title: string;
  value: string;
  hint?: string;
  delta?: string;
  deltaPositive?: boolean;
  valueClassName?: string;
}

export function KpiTile({
  title,
  value,
  hint,
  delta,
  deltaPositive,
  valueClassName,
}: KpiTileProps) {
  return (
    <Card className="surface-card ring-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-semibold tracking-tight tabular-nums", valueClassName)}>
          {value}
        </div>
        {delta && (
          <p
            className={cn(
              "mt-1.5 text-xs font-medium tabular-nums",
              deltaPositive === true && "text-emerald-700",
              deltaPositive === false && "text-red-600",
              deltaPositive === undefined && "text-muted-foreground",
            )}
          >
            {delta}
          </p>
        )}
        {hint && !delta && (
          <p className="text-muted-foreground mt-1.5 text-xs font-medium">{hint}</p>
        )}
        {hint && delta && (
          <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>
        )}
      </CardContent>
    </Card>
  );
}
