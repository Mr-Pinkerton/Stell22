"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  MIN_STOCK_KIND_LABEL,
  type AppSettings,
  type MinStockRow,
} from "@/mocks/settings-fixtures";
import { saveAppSettings, saveMinStock } from "@/server/settings";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/data-table";

const fieldClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 rounded-xl border px-4";

interface SettingsParamsTabProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  minStock: MinStockRow[];
  onMinStockChange: (rows: MinStockRow[]) => void;
}

export function SettingsParamsTab({
  settings,
  onSettingsChange,
  minStock,
  onMinStockChange,
}: SettingsParamsTabProps) {
  const [wasteRaw, setWasteRaw] = useState(String(settings.wasteThresholdPct));
  const [savingGeneral, startSaveGeneral] = useTransition();
  const [savingStock, startSaveStock] = useTransition();

  // Синхронизируем поле ввода при внешней смене настроек (без set-state-in-effect).
  const [prevWaste, setPrevWaste] = useState(settings.wasteThresholdPct);
  if (settings.wasteThresholdPct !== prevWaste) {
    setPrevWaste(settings.wasteThresholdPct);
    setWasteRaw(String(settings.wasteThresholdPct));
  }

  const saveGeneral = () => {
    const waste = Number(wasteRaw);
    if (!Number.isFinite(waste) || waste <= 0) {
      toast.error("Укажите корректный порог отхода");
      return;
    }
    startSaveGeneral(async () => {
      try {
        await saveAppSettings({ wasteThresholdPct: waste });
        onSettingsChange({ wasteThresholdPct: waste });
        toast.success("Параметры сохранены");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  };

  const saveStock = () => {
    startSaveStock(async () => {
      try {
        await saveMinStock(
          minStock.map((r) => ({ kind: r.kind, id: r.id, minStock: r.minStock })),
        );
        toast.success("Минимальные остатки сохранены");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  };

  const minStockColumns: Column<MinStockRow>[] = [
    {
      key: "kind",
      header: "Тип",
      className: "w-36",
      render: (row) => MIN_STOCK_KIND_LABEL[row.kind],
    },
    {
      key: "name",
      header: "Номенклатура",
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "minStock",
      header: "Мин. остаток",
      className: "w-36",
      render: (row) => (
        <Input
          type="number"
          min={0}
          value={row.minStock}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v) || v < 0) return;
            onMinStockChange(
              minStock.map((r) => (r.id === row.id ? { ...r, minStock: v } : r)),
            );
          }}
          className="border-border mx-auto h-9 w-24 rounded-lg text-center tabular-nums"
        />
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <Card className="surface-card ring-0">
        <CardContent className="space-y-5 p-6">
          <h2 className="font-semibold">Производство</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="waste-threshold">Порог отхода, %</Label>
              <Input
                id="waste-threshold"
                type="number"
                min={1}
                value={wasteRaw}
                onChange={(e) => setWasteRaw(e.target.value)}
                className={fieldClass}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="brand"
              className="h-10 rounded-xl px-5"
              onClick={saveGeneral}
              disabled={savingGeneral}
            >
              Сохранить
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Минимальные остатки на складе</h2>
          <Button
            type="button"
            variant="brand"
            className="h-10 rounded-xl px-5"
            onClick={saveStock}
            disabled={savingStock}
          >
            Сохранить
          </Button>
        </div>
        <Card className="surface-card ring-0">
          <CardContent className="p-0">
            <DataTable columns={minStockColumns} rows={minStock} padded className="border-0" />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
