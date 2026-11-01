import { LogOut } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { NotificationsPanel } from "@/components/notifications-panel";
import { getNotifications } from "@/server/notifications";
import { signOut } from "@/server/auth";
import { formatHeaderDate } from "@/lib/format";

export async function AppHeader({ userName }: { userName: string }) {
  const notifications = await getNotifications();

  return (
    <header className="surface-card bg-card sticky top-0 z-10 mx-4 mt-4 flex h-14 min-w-0 items-center gap-2 px-3 sm:gap-3 sm:px-4 md:mx-6">
      <SidebarTrigger className="shrink-0 rounded-full [&_svg]:stroke-[1.75]" />

      <div className="text-muted-foreground min-w-0 flex-1 truncate text-base font-medium">
        {formatHeaderDate()}
      </div>

      <span className="hidden min-w-0 truncate text-sm font-semibold sm:inline sm:max-w-[12rem]">
        {userName}
      </span>

      <NotificationsPanel initialNotifications={notifications} />

      <form action={signOut} className="shrink-0">
        <Button
          type="submit"
          variant="outline"
          className="border-[#D0D5DD] bg-card hover:border-[#98A2B3] hover:bg-muted h-10 cursor-pointer rounded-xl border px-4 [&_svg]:stroke-[1.75]"
          aria-label="Выйти"
        >
          <LogOut />
          Выйти
        </Button>
      </form>
    </header>
  );
}
