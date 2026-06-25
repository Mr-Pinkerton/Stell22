import { Bell, LogOut } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { formatHeaderDate } from "@/lib/format";

export function AppHeader() {
  return (
    <header className="bg-background sticky top-0 z-10 flex h-14 items-center gap-3 border-b px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-6" />

      <div className="text-muted-foreground flex-1 text-sm">{formatHeaderDate()}</div>

      <span className="text-sm font-medium">Администратор</span>

      <Button variant="ghost" size="icon" className="relative" aria-label="Уведомления">
        <Bell />
        <Badge className="absolute -top-1 -right-1 h-4 min-w-4 justify-center px-1 text-[10px]">
          3
        </Badge>
      </Button>

      <Button variant="ghost" size="sm" aria-label="Выйти">
        <LogOut />
        Выйти
      </Button>
    </header>
  );
}
