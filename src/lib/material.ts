import type { Material } from "@/types/domain";

/** Сечение материала как "40×20" (мм). null-поля → "" (не задано). */
export function sectionLabel(
  m: Pick<Material, "sectionWidthMm" | "sectionHeightMm">,
): string {
  const w = m.sectionWidthMm;
  const h = m.sectionHeightMm;
  if (w == null || h == null) return "";
  return `${w}×${h}`;
}

/**
 * Отображаемое имя материала: порода + сечение ("Хвоя 40×20"). Сечение — часть
 * идентичности материала, поэтому в списках/выборах показываем его всегда, иначе
 * одинаковые названия разных сечений неразличимы. Без сечения — только название.
 */
export function materialLabel(
  m: Pick<Material, "name" | "sectionWidthMm" | "sectionHeightMm">,
): string {
  const sec = sectionLabel(m);
  return sec ? `${m.name} ${sec}` : m.name;
}
