import { LogOut } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { NotificationsPanel } from "@/components/notifications-panel";
import { formatHeaderDate } from "@/lib/format";

export function AppHeader() {
  return (
    <header className="surface-card sticky top-0 z-10 mx-4 mt-4 flex h-14 items-center gap-3 px-4 md:mx-6">
      <SidebarTrigger className="rounded-full [&_svg]:stroke-[1.75]" />

      <div className="text-muted-foreground flex-1 text-base font-medium">{formatHeaderDate()}</div>

      <span className="text-sm font-semibold">Администратор</span>

      <NotificationsPanel />

      <Button
        variant="outline"
        className="border-[#D0D5DD] bg-card hover:border-[#98A2B3] hover:bg-muted h-10 cursor-pointer rounded-xl border px-4 [&_svg]:stroke-[1.75]"
        aria-label="Выйти"
      >
        <LogOut />
        Выйти
      </Button>
    </header>
  );
}
