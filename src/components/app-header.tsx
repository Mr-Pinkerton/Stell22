import { Bell, LogOut } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatHeaderDate } from "@/lib/format";

export function AppHeader() {
  return (
    <header className="surface-card sticky top-0 z-10 mx-4 mt-4 flex h-14 items-center gap-3 px-4 md:mx-6">
      <SidebarTrigger className="rounded-full [&_svg]:stroke-[1.75]" />

      <div className="text-muted-foreground flex-1 text-sm font-medium">{formatHeaderDate()}</div>

      <span className="text-sm font-semibold">Администратор</span>

      <Button
        variant="ghost"
        size="icon"
        className="bg-muted! text-muted-foreground hover:text-foreground hover:shadow-soft relative size-10 rounded-full p-0 transition-all hover:scale-105 hover:bg-muted! [&_svg]:stroke-[1.75]"
        aria-label="Уведомления"
      >
        <Bell />
        <Badge className="bg-brand absolute -top-1 -right-1 h-4 min-w-4 justify-center rounded-full border-0 px-1 text-[10px] text-white">
          3
        </Badge>
      </Button>

      <Button variant="ghost" size="sm" className="rounded-xl [&_svg]:stroke-[1.75]" aria-label="Выйти">
        <LogOut />
        Выйти
      </Button>
    </header>
  );
}
