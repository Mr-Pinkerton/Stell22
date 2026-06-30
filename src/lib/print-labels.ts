export interface PackageLabel {
  code: string;
  title: string;
  subtitle: string;
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
        <div class="code">${escapeHtml(l.code)}</div>
        <div class="bars">${escapeHtml(l.code)}</div>
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
        display: flex; flex-direction: column; justify-content: space-between;
        page-break-after: always; border: 1px dashed #bbb;
      }
      .title { font-size: 10pt; font-weight: 600; text-align: center; }
      .code { font-size: 16pt; font-weight: 700; text-align: center; letter-spacing: 1px; }
      .bars {
        font-family: "Libre Barcode 39", "Courier New", monospace;
        font-size: 9pt; text-align: center; letter-spacing: 2px; color: #111;
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
