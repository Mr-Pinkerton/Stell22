import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/format";
import { isAccountConfirmed } from "@/lib/account-balance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface AccountBalanceTileAccount {
  id: string;
  name: string;
  balance: number;
  isPrimary?: boolean;
  confirmed?: boolean;
}

interface AccountBalanceTileProps {
  accounts: AccountBalanceTileAccount[];
  title?: string;
}

/**
 * Плитка «Остаток на счетах». Остаток основных счетов показывается крупно,
 * остальные подтверждённые счета — мелким списком. Если основных нет —
 * показываем суммарный остаток (как раньше). Неподтверждённые (карантин
 * авто-импорта) счета не участвуют.
 */
export function AccountBalanceTile({ accounts, title = "Остаток на счетах" }: AccountBalanceTileProps) {
  const confirmed = accounts.filter((a) => isAccountConfirmed(a.confirmed));
  const primaries = confirmed.filter((a) => a.isPrimary);
  const others = confirmed.filter((a) => !a.isPrimary);
  const total = confirmed.reduce((sum, a) => sum + a.balance, 0);

  return (
    <Card className="surface-card ring-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {primaries.length === 0 ? (
          <>
            <div className="text-2xl font-semibold tracking-tight tabular-nums">
              {formatMoney(total)}
            </div>
            <p className="text-muted-foreground mt-1.5 text-xs font-medium">на текущую дату</p>
          </>
        ) : (
          <div className="space-y-2">
            <div className="space-y-1.5">
              {primaries.map((a) => (
                <div key={a.id}>
                  <div
                    className={cn(
                      "font-semibold tracking-tight tabular-nums",
                      primaries.length > 1 ? "text-xl" : "text-2xl",
                    )}
                  >
                    {formatMoney(a.balance)}
                  </div>
                  <p className="text-muted-foreground truncate text-xs font-medium">{a.name}</p>
                </div>
              ))}
            </div>
            {others.length > 0 && (
              <ul className="border-border/60 space-y-1 border-t pt-2">
                {others.map((a) => (
                  <li
                    key={a.id}
                    className="text-muted-foreground flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate">{a.name}</span>
                    <span className="tabular-nums">{formatMoney(a.balance)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
