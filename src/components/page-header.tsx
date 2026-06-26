import { Download, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PageHeaderProps {
  title: string;
  canExport?: boolean;
  addLabel?: string;
}

const actionButtonClass =
  "h-10 cursor-pointer rounded-xl px-5 [&_svg]:stroke-[1.75]";

const outlineActionClass =
  "border-[#D0D5DD] bg-card hover:border-[#98A2B3] hover:bg-muted border";

export function PageHeader({ title, canExport, addLabel }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="flex gap-2">
        {canExport && (
          <Button variant="outline" className={`${actionButtonClass} ${outlineActionClass}`}>
            <Download />
            Экспорт
          </Button>
        )}
        {addLabel && (
          <Button className={actionButtonClass}>
            <Plus />
            {addLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
