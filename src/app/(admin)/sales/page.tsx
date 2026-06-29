import { SectionScaffold } from "@/components/section-scaffold";

// Раздел осознанно оставлен заглушкой до подключения API маркетплейсов
// (Ozon/WB): пока неизвестен реальный формат отдаваемых данных, финальная
// таблица и фильтры проектируются по факту ответа API (Этап 13 roadmap).
// Готовая таблица под спеку уже есть в reports/report-sales-tab.tsx.
export default function SalesPage() {
  return <SectionScaffold slug="sales" />;
}
