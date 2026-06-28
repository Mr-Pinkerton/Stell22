"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  apiKeyRows,
  SETTINGS_API_PASSWORD,
  type ApiKeyRow,
} from "@/mocks/settings-fixtures";
import { maskApiKey, verifySettingsApiPassword } from "@/lib/settings";
import { formatIsoDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/data-table";

const fieldClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 rounded-xl border px-4";

interface SettingsApiTabProps {
  rows?: ApiKeyRow[];
}

export function SettingsApiTab({ rows = apiKeyRows }: SettingsApiTabProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());

  const tryUnlock = () => {
    if (verifySettingsApiPassword(password, SETTINGS_API_PASSWORD)) {
      setUnlocked(true);
      setPassword("");
      toast.success("Доступ к ключам открыт");
      return;
    }
    toast.error("Неверный пароль");
  };

  const lock = () => {
    setUnlocked(false);
    setVisibleIds(new Set());
    toast.message("Ключи скрыты");
  };

  const toggleVisible = (id: string) => {
    setVisibleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!unlocked) {
    return (
      <Card className="surface-card ring-0 max-w-md">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center gap-3">
            <span className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-2xl">
              <Lock className="size-5" />
            </span>
            <div>
              <h2 className="font-semibold">API-ключи</h2>
              <p className="text-muted-foreground text-sm">Введите пароль администратора</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api-password">Пароль</Label>
            <Input
              id="api-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tryUnlock()}
              className={fieldClass}
              placeholder="••••••••"
            />
          </div>
          <Button type="button" className="h-10 w-full rounded-xl" onClick={tryUnlock}>
            Разблокировать
          </Button>
        </CardContent>
      </Card>
    );
  }

  const columns: Column<ApiKeyRow>[] = [
    {
      key: "service",
      header: "Сервис",
      render: (row) => (
        <div>
          <p className="font-medium">{row.service}</p>
          <p className="text-muted-foreground text-xs">{row.description}</p>
        </div>
      ),
    },
    {
      key: "key",
      header: "Ключ",
      render: (row) => (
        <div className="flex items-center justify-center gap-2">
          <code className="text-sm">
            {visibleIds.has(row.id) ? row.keyValue : maskApiKey(row.keyValue)}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0"
            onClick={() => toggleVisible(row.id)}
          >
            {visibleIds.has(row.id) ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
      ),
    },
    {
      key: "updated",
      header: "Обновлён",
      className: "w-32",
      render: (row) => (
        <span className="text-muted-foreground tabular-nums">
          {formatIsoDate(row.updatedAt.slice(0, 10))}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" variant="outline" className="h-10 rounded-xl px-4" onClick={lock}>
          Заблокировать
        </Button>
      </div>
      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <DataTable columns={columns} rows={rows} padded className="border-0" />
        </CardContent>
      </Card>
    </div>
  );
}
