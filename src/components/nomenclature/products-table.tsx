"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatLength, formatMoney } from "@/lib/format";
import { expandableArchivedSummaryRowClass } from "@/lib/table-archive";
import {
  ExpandableDetailRow,
  ExpandableMainHeader,
  ExpandableReportTable,
  NestedTable,
  NestedTableCell,
  expandableChevronClass,
  expandableExpandedAccentClass,
  expandableExpandedChevronClass,
  expandableExpandedDetailClass,
  expandableNestedWrapExpandedClass,
  expandableSummaryCellClass,
} from "@/components/reports/expandable-table";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  RAIL_TYPE_LABEL,
  SORT_SHORT,
  formatPrisadka,
} from "@/components/nomenclature/form-shared";
import type { Detail, NomenclatureItem, Product } from "@/types/domain";

const COL_SPAN = 6;

const PRODUCT_COL_WIDTHS = ["22%", "14%", "12%", "12%", "12%", "10%"] as const;

const PRODUCT_HEADERS = ["Название", "Артикул", "Сорт", "Детали", "Статус", ""] as const;

const DETAIL_HEADERS = ["Деталь", "Длина", "Тип", "Присадка", "Кол-во"] as const;

const FASTENER_HEADERS = ["Позиция", "Кол-во", "Цена за ед."] as const;

const EXTRA_HEADERS = ["Позиция", "Цена за ед."] as const;

function statusBadge(status: "ACTIVE" | "ARCHIVED") {
  const archived = status === "ARCHIVED";
  return (
    <Badge
      variant={status === "ACTIVE" ? "secondary" : "outline"}
      className={archived ? "opacity-80" : undefined}
    >
      {status === "ACTIVE" ? "Активен" : "Архив"}
    </Badge>
  );
}

function detailTotal(product: Product) {
  return product.details.reduce((sum, d) => sum + d.quantity, 0);
}

interface ProductsTableProps {
  rows: Product[];
  details: Detail[];
  items: NomenclatureItem[];
  empty: string;
  renderActions: (product: Product) => React.ReactNode;
}

export function ProductsTable({
  rows,
  details,
  items,
  empty,
  renderActions,
}: ProductsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const detailById = useMemo(() => new Map(details.map((d) => [d.id, d])), [details]);
  const itemById = useMemo(() => new Map(items.map((n) => [n.id, n])), [items]);

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground px-6 py-12 text-center">{empty}</p>
    );
  }

  return (
    <ExpandableReportTable
      widths={PRODUCT_COL_WIDTHS}
      header={<ExpandableMainHeader labels={PRODUCT_HEADERS} centerFrom={1} />}
    >
      {rows.map((row, index) => {
        const expanded = expandedId === row.id;
        const archived = row.status === "ARCHIVED";
        return (
          <Fragment key={row.id}>
            <TableRow
              className={cn(
                "group cursor-pointer align-top",
                expandableArchivedSummaryRowClass({ archived, expanded, striped: index % 2 === 1 }),
              )}
              onClick={() => setExpandedId(expanded ? null : row.id)}
            >
              <TableCell
                className={cn(
                  expandableSummaryCellClass,
                  expanded && expandableExpandedAccentClass,
                )}
              >
                <div className="flex items-center gap-2">
                  {expanded ? (
                    <ChevronDown
                      className={cn(expandableChevronClass, expandableExpandedChevronClass)}
                    />
                  ) : (
                    <ChevronRight className={expandableChevronClass} />
                  )}
                  <span className="font-medium">{row.name}</span>
                </div>
              </TableCell>
              <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
                <div className="flex flex-col items-center leading-tight">
                  <span>
                    <span className="text-muted-foreground text-[0.65rem]">OZ</span> {row.skuOzon || "—"}
                  </span>
                  <span>
                    <span className="text-muted-foreground text-[0.65rem]">WB</span> {row.skuWb || "—"}
                  </span>
                </div>
              </TableCell>
              <TableCell className={cn(expandableSummaryCellClass, "text-center")}>
                {SORT_SHORT[row.sort]}
              </TableCell>
              <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
                {detailTotal(row)} шт
              </TableCell>
              <TableCell className={cn(expandableSummaryCellClass, "text-center")}>
                {statusBadge(row.status)}
              </TableCell>
              <TableCell
                className={cn(expandableSummaryCellClass, "text-center")}
                onClick={(e) => e.stopPropagation()}
              >
                {renderActions(row)}
              </TableCell>
            </TableRow>

            {expanded && (
              <ExpandableDetailRow colSpan={COL_SPAN} className={expandableExpandedDetailClass}>
                <div className={cn(expandableNestedWrapExpandedClass, "space-y-5")}>
                  <p className="text-sm">
                    <span className="text-muted-foreground">Цена продажи: </span>
                    <span className="font-medium tabular-nums">{formatMoney(row.salePrice)}</span>
                  </p>

                  <ProductSection title="Детали в изделии">
                    <NestedTable
                      headers={[...DETAIL_HEADERS]}
                      empty="Детали не добавлены"
                      isEmpty={row.details.length === 0}
                    >
                      {row.details.map((line) => {
                        const detail = detailById.get(line.detailId);
                        return (
                          <TableRow key={`${row.id}-${line.detailId}`}>
                            <NestedTableCell className="font-medium">
                              {detail?.name ?? "—"}
                            </NestedTableCell>
                            <NestedTableCell className="text-center tabular-nums">
                              {detail ? formatLength(detail.lengthM) : "—"}
                            </NestedTableCell>
                            <NestedTableCell className="text-center">
                              {detail ? RAIL_TYPE_LABEL[detail.detailType] : "—"}
                            </NestedTableCell>
                            <NestedTableCell className="text-center text-sm">
                              {detail ? formatPrisadka(detail) : "—"}
                            </NestedTableCell>
                            <NestedTableCell className="text-center tabular-nums">
                              {line.quantity} шт
                            </NestedTableCell>
                          </TableRow>
                        );
                      })}
                    </NestedTable>
                  </ProductSection>

                  <ProductSection title="Крепёж">
                    <NestedTable
                      headers={[...FASTENER_HEADERS]}
                      empty="Крепёж не указан"
                      isEmpty={row.fastenerIds.length === 0}
                    >
                      {row.fastenerIds.map((line) => {
                        const item = itemById.get(line.nomenclatureId);
                        return (
                          <TableRow key={`${row.id}-f-${line.nomenclatureId}`}>
                            <NestedTableCell className="font-medium">
                              {item?.name ?? "—"}
                            </NestedTableCell>
                            <NestedTableCell className="text-center tabular-nums">
                              {line.quantity} шт
                            </NestedTableCell>
                            <NestedTableCell className="text-center tabular-nums">
                              {item ? formatMoney(item.unitPrice) : "—"}
                            </NestedTableCell>
                          </TableRow>
                        );
                      })}
                    </NestedTable>
                  </ProductSection>

                  <ProductSection title="Упаковка">
                    {row.packagingId ? (
                      <p className="text-sm">
                        <span className="font-medium">
                          {itemById.get(row.packagingId)?.name ?? "—"}
                        </span>
                        {itemById.get(row.packagingId) && (
                          <span className="text-muted-foreground ml-2 tabular-nums">
                            {formatMoney(itemById.get(row.packagingId)!.unitPrice)}
                          </span>
                        )}
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-sm">Упаковка не указана</p>
                    )}
                  </ProductSection>

                  <ProductSection title="Разное">
                    <NestedTable
                      headers={[...EXTRA_HEADERS]}
                      empty="Дополнительные позиции не выбраны"
                      isEmpty={row.extraIds.length === 0}
                    >
                      {row.extraIds.map((id) => {
                        const item = itemById.get(id);
                        return (
                          <TableRow key={`${row.id}-e-${id}`}>
                            <NestedTableCell className="font-medium">
                              {item?.name ?? "—"}
                            </NestedTableCell>
                            <NestedTableCell className="text-center tabular-nums">
                              {item ? formatMoney(item.unitPrice) : "—"}
                            </NestedTableCell>
                          </TableRow>
                        );
                      })}
                    </NestedTable>
                  </ProductSection>
                </div>
              </ExpandableDetailRow>
            )}
          </Fragment>
        );
      })}
    </ExpandableReportTable>
  );
}

function ProductSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}
