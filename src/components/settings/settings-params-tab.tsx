"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  defaultAppSettings,
  minStockRows as mockMinStockRows,
  MIN_STOCK_KIND_LABEL,
  type AppSettings,
  type MinStockRow,
} from "@/mocks/settings-fixtures";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/data-table";

const fieldClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 rounded-xl border px-4";

interface SettingsParamsTabProps {
  settings?: AppSettings;
  onSettingsChange?: (settings: AppSettings) => void;
  minStock?: MinStockRow[];
  onMinStockChange?: (rows: MinStockRow[]) => void;
}

export function SettingsParamsTab({
  settings: settingsProp,
  onSettingsChange,
  minStock: minStockProp,
  onMinStockChange,
}: SettingsParamsTabProps) {
  const [internalSettings, setInternalSettings] = useState(defaultAppSettings);
  const [internalMinStock, setInternalMinStock] = useState(mockMinStockRows);

  const settings = settingsProp ?? internalSettings;
  const setSettings = onSettingsChange ?? setInternalSettings;
  const minStock = minStockProp ?? internalMinStock;
  const setMinStock = onMinStockChange ?? setInternalMinStock;

  const [wasteRaw, setWasteRaw] = useState(String(settings.wasteThresholdPct));
  const [labelW, setLabelW] = useState(String(settings.labelWidthMm));
  const [labelH, setLabelH] = useState(String(settings.labelHeightMm));

  useEffect(() => {
    setWasteRaw(String(settings.wasteThresholdPct));
    setLabelW(String(settings.labelWidthMm));
    setLabelH(String(settings.labelHeightMm));
  }, [settings.wasteThresholdPct, settings.labelWidthMm, settings.labelHeightMm]);

  const saveGeneral = () => {
    const waste = Number(wasteRaw);
    const width = Number(labelW);
    const height = Number(labelH);
    if (!Number.isFinite(waste) || waste <= 0) {
      toast.error("Укажите корректный порог отхода");
      return;
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      toast.error("Укажите корректный размер этикетки");
      return;
    }
    setSettings({
      wasteThresholdPct: waste,
      labelWidthMm: width,
      labelHeightMm: height,
    });
    toast.success("Параметры сохранены (прототип)");
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
            setMinStock(
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
            <div className="space-y-1.5">
              <Label htmlFor="label-w">Этикетка, ширина (мм)</Label>
              <Input
                id="label-w"
                type="number"
                min={1}
                value={labelW}
                onChange={(e) => setLabelW(e.target.value)}
                className={fieldClass}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="label-h">Этикетка, высота (мм)</Label>
              <Input
                id="label-h"
                type="number"
                min={1}
                value={labelH}
                onChange={(e) => setLabelH(e.target.value)}
                className={fieldClass}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="button" variant="brand" className="h-10 rounded-xl px-5" onClick={saveGeneral}>
              Сохранить
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="font-semibold">Минимальные остатки на складе</h2>
        <Card className="surface-card ring-0">
          <CardContent className="p-0">
            <DataTable columns={minStockColumns} rows={minStock} padded className="border-0" />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
