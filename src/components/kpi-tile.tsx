import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface KpiTileProps {
  title: string;
  value: string;
  hint?: string;
}

export function KpiTile({ title, value, hint }: KpiTileProps) {
  return (
    <Card className="surface-card ring-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        {hint && <p className="text-muted-foreground mt-1.5 text-xs font-medium">{hint}</p>}
      </CardContent>
    </Card>
  );
}
