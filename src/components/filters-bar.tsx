"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { SectionFilters } from "@/lib/navigation";

export function FiltersBar({ search, date, weeks, archive }: SectionFilters) {
  const hasAny = search || date || weeks || archive;
  if (!hasAny) return null;

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
      {search && (
        <div className="grid gap-1.5">
          <Label htmlFor="f-search">Поиск</Label>
          <Input id="f-search" placeholder="Название / имя" className="w-56" />
        </div>
      )}
      {date && (
        <div className="grid gap-1.5">
          <Label htmlFor="f-date">Дата</Label>
          <Input id="f-date" type="month" className="w-44" />
        </div>
      )}
      {weeks && (
        <div className="grid gap-1.5">
          <Label htmlFor="f-week">Неделя</Label>
          <Input id="f-week" placeholder="Неделя месяца" className="w-40" />
        </div>
      )}
      {archive && (
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Checkbox id="f-archive" />
          Показать архив
        </label>
      )}
      <div className="ml-auto flex gap-2">
        <Button variant="ghost">Сбросить</Button>
        <Button>Показать</Button>
      </div>
    </div>
  );
}
