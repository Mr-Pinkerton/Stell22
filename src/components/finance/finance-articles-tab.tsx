"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { FinanceArticle } from "@/mocks/finance-fixtures";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COL_WIDTHS = ["28%", "24%", "12%", "36%"] as const;

const cellPad = "px-4 first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";

const headClass = "bg-card text-base font-semibold h-11 align-middle";

const headLeftClass = cn(headClass, "text-left");

const headCenterClass = cn(headClass, "text-center");

function ArticleSection({
  title,
  flowType,
  articles,
}: {
  title: string;
  flowType: FinanceArticle["flowType"];
  articles: FinanceArticle[];
}) {
  const roots = useMemo(
    () => articles.filter((a) => a.flowType === flowType && !a.parentId),
    [articles, flowType],
  );
  const children = useMemo(
    () => articles.filter((a) => a.flowType === flowType && a.parentId),
    [articles, flowType],
  );

  const rows = useMemo(() => {
    const ordered: FinanceArticle[] = [];
    for (const root of roots) {
      ordered.push(root);
      for (const child of children.filter((c) => c.parentId === root.id)) {
        ordered.push(child);
      }
    }
    return ordered;
  }, [roots, children]);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              {COL_WIDTHS.map((width, i) => (
                <col key={i} style={{ width }} />
              ))}
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={cn(cellPad, headLeftClass)}>Название</TableHead>
                <TableHead className={cn(cellPad, headCenterClass)}>Категория</TableHead>
                <TableHead className={cn(cellPad, headCenterClass)}>Субстатья</TableHead>
                <TableHead className={cn(cellPad, headCenterClass)}>Описание</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={COL_WIDTHS.length}
                    className={cn(cellPad, "text-muted-foreground h-24 text-center")}
                  >
                    Статей нет
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, index) => (
                  <TableRow
                    key={row.id}
                    className={cn(
                      !row.parentId && index % 2 === 1 && "bg-muted/40",
                      row.parentId && "bg-muted/35 text-muted-foreground hover:!bg-muted/45",
                    )}
                  >
                    <TableCell className={cn(cellPad, "align-middle")}>
                      <span className={cn("font-medium", row.parentId && "pl-5")}>
                        {row.name}
                      </span>
                    </TableCell>
                    <TableCell className={cn(cellPad, "align-middle text-center")}>
                      <div className="flex flex-col items-center justify-center gap-1">
                        <span className="line-clamp-2 whitespace-normal">{row.categoryName}</span>
                        {row.isOverhead && (
                          <Badge variant="secondary" className="w-fit text-xs">
                            Накладные
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell
                      className={cn(cellPad, "align-middle text-center tabular-nums")}
                    >
                      {row.parentId ? "Да" : "—"}
                    </TableCell>
                    <TableCell className={cn(cellPad, "align-middle text-center")}>
                      <p className="text-muted-foreground mx-auto line-clamp-2 w-full whitespace-normal">
                        {row.description ?? "—"}
                      </p>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </table>
        </CardContent>
      </Card>
    </section>
  );
}

interface FinanceArticlesTabProps {
  articles: FinanceArticle[];
}

export function FinanceArticlesTab({ articles }: FinanceArticlesTabProps) {
  return (
    <div className="space-y-8">
      <ArticleSection title="Поступления" flowType="INCOME" articles={articles} />
      <ArticleSection title="Списания" flowType="EXPENSE" articles={articles} />
    </div>
  );
}
