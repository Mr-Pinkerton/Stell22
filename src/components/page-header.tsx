import { Download, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PageHeaderProps {
  title: string;
  canExport?: boolean;
  addLabel?: string;
}

export function PageHeader({ title, canExport, addLabel }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="flex gap-2">
        {canExport && (
          <Button variant="outline">
            <Download />
            Экспорт
          </Button>
        )}
        {addLabel && (
          <Button>
            <Plus />
            {addLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
