import { Download, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PageHeaderProps {
  title: string;
  canExport?: boolean;
  exporting?: boolean;
  addLabel?: string;
  onAdd?: () => void;
  onExport?: () => void;
}

const actionButtonClass =
  "h-10 cursor-pointer rounded-xl px-5 [&_svg]:stroke-[1.75]";

const outlineActionClass =
  "border-[#D0D5DD] bg-card hover:border-[#98A2B3] hover:bg-muted border";

export function PageHeader({
  title,
  canExport,
  exporting,
  addLabel,
  onAdd,
  onExport,
}: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="flex max-w-full flex-wrap gap-2">
        {canExport && (
          <Button
            variant="outline"
            className={`${actionButtonClass} ${outlineActionClass}`}
            onClick={onExport}
            disabled={exporting}
          >
            {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            Экспорт
          </Button>
        )}
        {addLabel && (
          <Button className={actionButtonClass} onClick={onAdd}>
            <Plus />
            {addLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
