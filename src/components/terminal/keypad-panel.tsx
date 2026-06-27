import { cn } from "@/lib/utils";

/** Общая ширина и боковые отступы панелей с нампадом. */
export const KEYPAD_PANEL = "mx-auto w-full max-w-[26rem] space-y-5 px-8";

interface KeypadDisplayProps {
  children: React.ReactNode;
  /** Подпись под полем (ошибка, подсказка) — absolute, без сдвига layout. */
  footerMessage?: string;
  showFooterMessage?: boolean;
  footerTone?: "error" | "muted";
}

/** Поле значения + опциональное сообщение под ним без прыжка модалки. */
export function KeypadDisplay({
  children,
  footerMessage,
  showFooterMessage = false,
  footerTone = "error",
}: KeypadDisplayProps) {
  return (
    <div className="relative">
      <div className="bg-muted/50 flex h-20 items-center justify-center rounded-2xl text-4xl font-semibold tabular-nums">
        {children}
      </div>
      {footerMessage != null && (
        <p
          className={cn(
            "pointer-events-none absolute inset-x-0 top-full z-10 px-1 pt-1 text-center text-sm leading-snug font-medium",
            showFooterMessage ? "opacity-100" : "opacity-0",
            footerTone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {footerMessage}
        </p>
      )}
    </div>
  );
}
