export interface PackageLabel {
  code: string;
  title: string;
  subtitle: string;
}

// Этикетка 58×40мм, отступы 3мм с каждой стороны (см. .label ниже) → под код
// доступно 58-2×3=52мм по ширине.
const LABEL_CODE_MAX_PT = 22;
const LABEL_CODE_MIN_PT = 9;
const MM_TO_PT = 2.83465;
// 10% запаса на неточность оценки ширины символов в конкретном браузере/шрифте.
const LABEL_CODE_SAFE_WIDTH_PT = (58 - 2 * 3) * MM_TO_PT * 0.9;
// Средняя ширина символа Arial Bold относительно кегля, с запасом под
// кириллицу «ПАК» (шире цифр/дефисов) и letter-spacing кода.
const CODE_CHAR_WIDTH_EM = 0.66;

/**
 * Размер шрифта кода этикетки (pt), подобранный под его длину, чтобы код
 * НЕ вылезал за край наклейки. Базовый код — «ПАК-24-569-01» (13 симв.), но
 * при коллизии кодов в партии добавляется суффикс («-2», «-3», …) и код
 * становится длиннее — на фиксированном 22pt он обрезался `overflow:hidden`.
 * Короткие коды остаются крупными (22pt), длинные — мельче, но не ниже
 * минимума читаемости.
 */
export function codeFontSizePt(code: string): number {
  const len = Math.max(1, code.length);
  const fit = LABEL_CODE_SAFE_WIDTH_PT / (len * CODE_CHAR_WIDTH_EM);
  return Math.max(LABEL_CODE_MIN_PT, Math.min(LABEL_CODE_MAX_PT, fit));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Печать этикеток пакетов через браузер (заглушка вместо драйвера принтера):
 * открывает окно с этикетками формата 58×40 мм и вызывает системный диалог
 * печати. Реальный термопринтер подключится здесь же на этапе оборудования.
 */
export function printPackageLabels(labels: PackageLabel[]): boolean {
  if (labels.length === 0) return false;
  const win = window.open("", "_blank", "width=480,height=640");
  if (!win) return false;

  const cards = labels
    .map(
      (l) => `
      <div class="label">
        <div class="title">${escapeHtml(l.title)}</div>
        <div class="code" style="font-size:${codeFontSizePt(l.code).toFixed(1)}pt">${escapeHtml(l.code)}</div>
        <div class="subtitle">${escapeHtml(l.subtitle)}</div>
      </div>`,
    )
    .join("");

  win.document.write(`<!doctype html>
  <html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>Этикетки пакетов</title>
    <style>
      @page { size: 58mm 40mm; margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Arial, sans-serif; }
      .label {
        width: 58mm; height: 40mm; padding: 3mm;
        display: flex; flex-direction: column; justify-content: center; gap: 2mm;
        border: 1px dashed #bbb; overflow: hidden;
      }
      /* Разрыв только МЕЖДУ этикетками — без лишней пустой страницы в конце. */
      .label:not(:last-child) { page-break-after: always; }
      .title, .code, .subtitle { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .title { font-size: 10pt; font-weight: 600; text-align: center; }
      .code {
        font-weight: 800; text-align: center; letter-spacing: 1px;
      }
      .subtitle { font-size: 9pt; text-align: center; color: #333; }
      @media print { .label { border: none; } }
    </style>
  </head>
  <body>${cards}</body>
  </html>`);
  win.document.close();
  win.focus();
  win.addEventListener("load", () => {
    win.print();
  });
  // Фолбэк, если событие load не сработало (документ уже готов).
  setTimeout(() => {
    try {
      win.print();
    } catch {
      /* окно могли закрыть */
    }
  }, 400);
  return true;
}
