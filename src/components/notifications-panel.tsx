"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertCircle, Bell, CheckCircle2, Info } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationRow,
  type NotificationTone,
} from "@/server/notifications";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const toneStyles: Record<
  NotificationTone,
  { row: string; icon: string; Icon: typeof Info }
> = {
  ERROR: {
    row: "border-destructive/25 bg-destructive/5 hover:bg-destructive/10",
    icon: "bg-destructive/15 text-destructive",
    Icon: AlertCircle,
  },
  SUCCESS: {
    row: "border-[#abefc6] bg-[#ecfdf3] hover:bg-[#d1fadf]",
    icon: "bg-[#d1fadf] text-[#027a48]",
    Icon: CheckCircle2,
  },
  INFO: {
    row: "border-tag-blue-bg bg-tag-blue-bg/40 hover:bg-tag-blue-bg/70",
    icon: "bg-tag-blue-bg text-tag-blue",
    Icon: Info,
  },
};

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  return `${days} дн назад`;
}

function NotificationItem({
  item,
  onClick,
}: {
  item: NotificationRow;
  onClick: () => void;
}) {
  const { row, icon, Icon } = toneStyles[item.tone];
  const unread = !item.isRead;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer gap-3 rounded-xl border p-3 text-left transition-colors",
        row,
        unread && "ring-foreground/5 ring-1",
      )}
    >
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", icon)}>
        <Icon className="size-4 stroke-[1.75]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className={cn("text-sm leading-snug", unread ? "font-semibold" : "font-medium")}>
            {item.title}
          </span>
          {unread && <span className="bg-brand mt-1.5 size-2 shrink-0 rounded-full" />}
        </span>
        <span className="text-muted-foreground mt-0.5 block text-sm leading-snug">{item.message}</span>
        <span className="text-muted-foreground/80 mt-1.5 block text-xs">
          {formatRelativeTime(item.createdAt)}
        </span>
      </span>
    </button>
  );
}

export function NotificationsPanel({
  initialNotifications,
}: {
  initialNotifications: NotificationRow[];
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(initialNotifications);
  const [, startTransition] = useTransition();

  const unreadCount = useMemo(() => rows.filter((n) => !n.isRead).length, [rows]);

  const markRead = (id: string) => {
    setRows((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    startTransition(async () => {
      try {
        await markNotificationRead(id);
      } catch {
        toast.error("Не удалось отметить уведомление прочитанным");
      }
    });
  };

  const markAllRead = () => {
    setRows((prev) => prev.map((n) => ({ ...n, isRead: true })));
    startTransition(async () => {
      try {
        await markAllNotificationsRead();
      } catch {
        toast.error("Не удалось отметить уведомления прочитанными");
      }
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="icon-action-btn icon-action-btn--compact icon-action-btn--anchor relative inline-flex size-10 cursor-pointer items-center justify-center rounded-full p-0 [&_svg]:size-4 [&_svg]:stroke-[1.75]"
        aria-label="Уведомления"
      >
        <Bell />
        {unreadCount > 0 && (
          <Badge className="bg-brand absolute -top-1 -right-1 h-4 min-w-4 justify-center rounded-full border-0 px-1 text-[10px] text-white">
            {unreadCount}
          </Badge>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="shadow-balanced w-[min(24rem,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl p-0 ring-0"
      >
        <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <p className="text-base font-semibold">Уведомления</p>
            {unreadCount > 0 && (
              <p className="text-muted-foreground text-xs">Непрочитанных: {unreadCount}</p>
            )}
          </div>
          {unreadCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground h-8 cursor-pointer rounded-lg px-2 text-xs"
              onClick={markAllRead}
            >
              Прочитать все
            </Button>
          )}
        </div>

        <div className="scrollbar-thin-y max-h-[min(24rem,60vh)] overflow-y-auto p-3">
          {rows.length === 0 ? (
            <div className="text-muted-foreground flex h-32 items-center justify-center text-sm">
              Уведомлений нет
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((item) => (
                <NotificationItem key={item.id} item={item} onClick={() => markRead(item.id)} />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
