"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ExpenseChartSlice } from "@/mocks/finance-fixtures";

const SLICE_COLORS = [
  "#e84e36",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#0ea5e9",
  "#8b5cf6",
  "#f43f5e",
];

const SIZE = 144;
const CX = SIZE / 2;
const CY = SIZE / 2;
const OUTER_R = SIZE / 2 - 2;
const INNER_R = OUTER_R * 0.52;

function toRad(deg: number) {
  return ((deg - 90) * Math.PI) / 180;
}

function donutSlicePath(
  startAngle: number,
  endAngle: number,
  outerR = OUTER_R,
  innerR = INNER_R,
) {
  const sweep = endAngle - startAngle;
  if (sweep >= 359.99) {
    return [
      `M ${CX} ${CY - outerR}`,
      `A ${outerR} ${outerR} 0 1 1 ${CX - 0.01} ${CY - outerR}`,
      `L ${CX - 0.01} ${CY - innerR}`,
      `A ${innerR} ${innerR} 0 1 0 ${CX} ${CY - innerR}`,
      "Z",
    ].join(" ");
  }

  const largeArc = sweep > 180 ? 1 : 0;
  const x1 = CX + outerR * Math.cos(toRad(startAngle));
  const y1 = CY + outerR * Math.sin(toRad(startAngle));
  const x2 = CX + outerR * Math.cos(toRad(endAngle));
  const y2 = CY + outerR * Math.sin(toRad(endAngle));
  const x3 = CX + innerR * Math.cos(toRad(endAngle));
  const y3 = CY + innerR * Math.sin(toRad(endAngle));
  const x4 = CX + innerR * Math.cos(toRad(startAngle));
  const y4 = CY + innerR * Math.sin(toRad(startAngle));

  return [
    `M ${x1} ${y1}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4}`,
    "Z",
  ].join(" ");
}

interface ChartSegment extends ExpenseChartSlice {
  color: string;
  startAngle: number;
  endAngle: number;
}

function buildSegments(slices: ExpenseChartSlice[]): ChartSegment[] {
  const total = slices.reduce((sum, slice) => sum + slice.amount, 0) || 1;
  let angle = 0;

  return slices.map((slice, i) => {
    const sweep = (slice.amount / total) * 360;
    const startAngle = angle;
    const endAngle = angle + sweep;
    angle = endAngle;
    return {
      ...slice,
      color: SLICE_COLORS[i % SLICE_COLORS.length],
      startAngle,
      endAngle,
    };
  });
}

interface FinanceExpenseChartProps {
  slices: ExpenseChartSlice[];
}

export function FinanceExpenseChart({ slices }: FinanceExpenseChartProps) {
  const segments = useMemo(() => buildSegments(slices), [slices]);

  if (slices.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">Нет расходов за выбранный период</p>
    );
  }

  return (
    <div className="flex justify-center">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label="Круговая диаграмма расходов по статьям. Наведите на сегмент для деталей."
        className="overflow-visible"
      >
        {segments.map((segment) => (
          <Tooltip key={segment.category}>
            <TooltipTrigger
              render={
                <path
                  d={donutSlicePath(segment.startAngle, segment.endAngle)}
                  fill={segment.color}
                  className="cursor-pointer transition-opacity hover:opacity-85"
                />
              }
            />
            <TooltipContent side="top" className="max-w-xs text-center">
              <p className="font-medium">{segment.category}</p>
              <p className="text-muted-foreground tabular-nums text-xs">
                {formatMoney(segment.amount)} · {segment.pct}%
              </p>
            </TooltipContent>
          </Tooltip>
        ))}
      </svg>
    </div>
  );
}
