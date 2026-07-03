// Приём банковских выписок из почтового ящика (IMAP).
//
// Банк присылает архив/файл 1CClientBankExchange на выделенный ящик
// (например tochka@stell22.ru). Скрипт по cron раз в час забирает непрочитанные
// письма, достаёт вложения (.txt / .zip), распаковывает и импортирует через
// ту же логику, что и ручная загрузка (`importStatement`) — с дедупликацией,
// якорем остатка и карантином новых счетов.
//
// Модуль НЕ помечен "use server": часть экспортов синхронные (чтение конфига,
// разбор вложений), и он запускается из CLI-скрипта вне Next-контекста.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { unzipSync } from "fflate";
import { writeSystemLog } from "@/server/system-log";
import { decodeStatementBytes, is1CStatement } from "@/lib/bank-statement-1c";
import { importStatement } from "@/server/finance";

const LOG_SOURCE = "Выписки (почта)";

export interface MailIntakeConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  /** Белый список отправителей (lowercase). Пусто = принимать от кого угодно. */
  allowedSenders: string[];
  /** Помечать письмо прочитанным после обработки (иначе разберём его снова). */
  markSeen: boolean;
  mailbox: string;
}

export interface MailIntakeResult {
  ok: boolean;
  /** Конфиг не задан (нет обязательных MAIL_*) — приём отключён, это не ошибка. */
  disabled: boolean;
  messagesProcessed: number;
  messagesSkipped: number;
  statementsImported: number;
  operationsImported: number;
  attachmentsSkipped: number;
  errors: string[];
}

/**
 * Конфиг приёма из переменных окружения. Возвращает null, если не заданы
 * обязательные значения (host/user/password) — тогда приём просто отключён.
 */
export function readMailConfig(): MailIntakeConfig | null {
  const host = process.env.MAIL_IMAP_HOST?.trim();
  const user = process.env.MAIL_IMAP_USER?.trim();
  const password = process.env.MAIL_IMAP_PASSWORD;
  if (!host || !user || !password) return null;

  return {
    host,
    port: Number(process.env.MAIL_IMAP_PORT ?? 993),
    user,
    password,
    secure: (process.env.MAIL_IMAP_SECURE ?? "true").toLowerCase() !== "false",
    allowedSenders: (process.env.MAIL_ALLOWED_SENDERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    markSeen: (process.env.MAIL_MARK_SEEN ?? "true").toLowerCase() !== "false",
    mailbox: process.env.MAIL_IMAP_MAILBOX?.trim() || "INBOX",
  };
}

/**
 * `importStatement` вызывает `revalidatePath` после успешного commit, а вне
 * Next request-контекста (CLI/cron) это бросает "static generation store
 * missing". Данные к этому моменту уже записаны — глушим только эту ошибку.
 */
async function ignoringRevalidate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("static generation store missing")) return undefined as T;
    throw err;
  }
}

interface ExtractedStatement {
  fileName: string;
  content: string;
}

/**
 * Достать 1С-выписки из вложения. .zip распаковывается, каждая запись
 * проверяется на формат; одиночный файл — как есть. Не-1С записи считаются
 * пропущенными.
 */
export function extractStatements(
  fileName: string,
  bytes: Uint8Array,
): { statements: ExtractedStatement[]; skipped: number } {
  const statements: ExtractedStatement[] = [];
  let skipped = 0;
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".zip")) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      return { statements, skipped: 1 };
    }
    for (const [name, entryBytes] of Object.entries(entries)) {
      if (name.endsWith("/") || entryBytes.length === 0) continue; // папки
      const text = decodeStatementBytes(entryBytes);
      if (is1CStatement(text)) {
        statements.push({ fileName: name.split("/").pop() ?? name, content: text });
      } else {
        skipped += 1;
      }
    }
    return { statements, skipped };
  }

  const text = decodeStatementBytes(bytes);
  if (is1CStatement(text)) statements.push({ fileName, content: text });
  else skipped += 1;
  return { statements, skipped };
}

/** Подключиться к IMAP, разобрать непрочитанные письма и импортировать выписки. */
export async function runMailIntake(config: MailIntakeConfig): Promise<MailIntakeResult> {
  const result: MailIntakeResult = {
    ok: true,
    disabled: false,
    messagesProcessed: 0,
    messagesSkipped: 0,
    statementsImported: 0,
    operationsImported: 0,
    attachmentsSkipped: 0,
    errors: [],
  };

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return result;

      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) {
            result.messagesSkipped += 1;
            continue;
          }

          const mail = await simpleParser(msg.source);
          const from = mail.from?.value?.[0]?.address?.toLowerCase() ?? "";

          if (config.allowedSenders.length > 0 && !config.allowedSenders.includes(from)) {
            // Отправитель не в белом списке — не наше письмо. Помечаем
            // прочитанным (если разрешено), чтобы не разбирать его каждый час.
            result.messagesSkipped += 1;
            if (config.markSeen) {
              await client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });
            }
            continue;
          }

          const attachments = mail.attachments ?? [];
          for (const att of attachments) {
            const name = att.filename ?? "attachment";
            const bytes = new Uint8Array(att.content);
            const { statements, skipped } = extractStatements(name, bytes);
            result.attachmentsSkipped += skipped;
            for (const st of statements) {
              const res = await ignoringRevalidate(() => importStatement(st.content, st.fileName));
              result.statementsImported += 1;
              if (res) result.operationsImported += res.importedCount;
            }
          }

          result.messagesProcessed += 1;
          if (config.markSeen) {
            await client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });
          }
        } catch (err) {
          result.ok = false;
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`UID ${uid}: ${msg}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return result;
}

/** Прочитать конфиг, выполнить приём и записать итог в системный журнал. */
export async function runMailIntakeAndLog(): Promise<MailIntakeResult> {
  const config = readMailConfig();
  if (!config) {
    return {
      ok: true,
      disabled: true,
      messagesProcessed: 0,
      messagesSkipped: 0,
      statementsImported: 0,
      operationsImported: 0,
      attachmentsSkipped: 0,
      errors: [],
    };
  }

  let result: MailIntakeResult;
  try {
    result = await runMailIntake(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      ok: false,
      disabled: false,
      messagesProcessed: 0,
      messagesSkipped: 0,
      statementsImported: 0,
      operationsImported: 0,
      attachmentsSkipped: 0,
      errors: [msg],
    };
  }

  // Тишину не логируем: нет писем и ошибок — не засоряем журнал каждый час.
  const silent =
    result.ok && result.messagesProcessed === 0 && result.messagesSkipped === 0 && result.errors.length === 0;
  if (!silent) {
    await writeSystemLog({
      level: result.ok ? "INFO" : "ERROR",
      source: LOG_SOURCE,
      message: result.ok
        ? `Почта: писем ${result.messagesProcessed}, выписок ${result.statementsImported}, операций ${result.operationsImported}`
        : `Почта: ошибка приёма (${result.errors.length})`,
      details: result as unknown as Record<string, unknown>,
    });
  }

  return result;
}
