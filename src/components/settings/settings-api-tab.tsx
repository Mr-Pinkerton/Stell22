"use client";

import { useState, useTransition } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  API_CREDENTIAL_GROUPS,
  type ApiCredentialValues,
} from "@/lib/api-credentials";
import { saveApiCredentials, verifyApiCredentialsPassword } from "@/server/settings";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const fieldClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 rounded-xl border px-4";

interface SettingsApiTabProps {
  initialValues: ApiCredentialValues;
}

export function SettingsApiTab({ initialValues }: SettingsApiTabProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [values, setValues] = useState<ApiCredentialValues>(initialValues);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [saving, startSave] = useTransition();
  const [unlocking, startUnlock] = useTransition();

  const tryUnlock = () => {
    startUnlock(async () => {
      const result = await verifyApiCredentialsPassword(password);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setUnlocked(true);
      setPassword("");
      toast.success("Доступ к ключам открыт");
    });
  };

  const lock = () => {
    setUnlocked(false);
    setVisible(new Set());
    setValues(initialValues);
  };

  const toggleVisible = (key: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    startSave(async () => {
      try {
        await saveApiCredentials(values);
        toast.success("Ключи сохранены");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
      }
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
          <Button
            type="button"
            className="h-10 w-full rounded-xl"
            disabled={unlocking}
            onClick={tryUnlock}
          >
            {unlocking ? "Проверка…" : "Разблокировать"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" className="h-10 rounded-xl px-4" onClick={lock}>
          Заблокировать
        </Button>
        <Button
          type="button"
          variant="brand"
          className="h-10 rounded-xl px-5"
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? "Сохранение…" : "Сохранить"}
        </Button>
      </div>

      {API_CREDENTIAL_GROUPS.map((group) => (
        <Card key={group.service} className="surface-card ring-0">
          <CardContent className="space-y-4 p-6">
            <div>
              <h3 className="font-semibold">{group.service}</h3>
              <p className="text-muted-foreground text-sm">{group.description}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.fields.map((field) => {
                const shown = visible.has(field.key);
                return (
                  <div key={field.key} className="space-y-1.5">
                    <Label htmlFor={`cred-${field.key}`}>{field.label}</Label>
                    <div className="relative">
                      <Input
                        id={`cred-${field.key}`}
                        type={field.secret && !shown ? "password" : "text"}
                        autoComplete="off"
                        spellCheck={false}
                        value={values[field.key] ?? ""}
                        onChange={(e) => setValue(field.key, e.target.value)}
                        className={`${fieldClass} ${field.secret ? "pr-11" : ""} font-mono`}
                        placeholder={field.placeholder}
                      />
                      {field.secret && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="absolute top-1/2 right-1 size-8 -translate-y-1/2"
                          onClick={() => toggleVisible(field.key)}
                          aria-label={shown ? "Скрыть" : "Показать"}
                        >
                          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
