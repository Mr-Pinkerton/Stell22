import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { Card, CardContent } from "@/components/ui/card";

export function SectionScaffold({ slug }: { slug: string }) {
  const item = getNavItem(slug);
  if (!item) return null;

  return (
    <>
      <PageHeader title={item.title} canExport={item.canExport} addLabel={item.addLabel} />
      <FiltersBar {...(item.filters ?? {})} />
      <Card className="surface-card ring-0">
        <CardContent className="text-muted-foreground flex h-48 items-center justify-center text-sm">
          Раздел «{item.title}» — каркас готов, наполнение на следующих этапах
        </CardContent>
      </Card>
    </>
  );
}
