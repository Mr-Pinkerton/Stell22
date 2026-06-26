import { toast as sonner } from "sonner";

const opts = { toasterId: "terminal" } as const;

/** Тосты терминала — под хедером (см. TerminalToaster). */
export const toast = {
  success: (message: string) => sonner.success(message, opts),
  error: (message: string) => sonner.error(message, opts),
  info: (message: string) => sonner.info(message, opts),
};
