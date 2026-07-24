"use server";

import { revalidatePath } from "next/cache";
import type { Material as PrismaMaterial } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import type { Material } from "@/types/domain";

const PATH = "/nomenclature";

export interface MaterialFormValues {
  name: string;
  sectionWidthMm?: number | null;
  sectionHeightMm?: number | null;
  sortOrder?: number | null;
}

function serialize(m: PrismaMaterial): Material {
  return {
    id: m.id,
    name: m.name,
    sectionWidthMm: m.sectionWidthMm == null ? null : Number(m.sectionWidthMm),
    sectionHeightMm: m.sectionHeightMm == null ? null : Number(m.sectionHeightMm),
    status: m.status,
    sortOrder: m.sortOrder,
  };
}

/** Нормализует ввод сечения: положительные числа обязательны (часть идентичности). */
function requireSection(v: MaterialFormValues): { w: number; h: number } {
  const w = v.sectionWidthMm ?? 0;
  const h = v.sectionHeightMm ?? 0;
  if (!(w > 0) || !(h > 0)) throw new Error("Укажите сечение материала (ширина и высота, мм)");
  return { w, h };
}

export async function getMaterials(): Promise<Material[]> {
  const rows = await prisma.material.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(serialize);
}

export async function createMaterial(values: MaterialFormValues): Promise<Material> {
  const name = values.name.trim();
  if (!name) throw new Error("Название материала обязательно");
  const { w, h } = requireSection(values);

  // Уникальность — по паре (название, сечение): одна порода в разных сечениях ок.
  const clash = await prisma.material.findFirst({
    where: { name, sectionWidthMm: w, sectionHeightMm: h },
  });
  if (clash) throw new Error(`Материал «${name} ${w}×${h}» уже существует`);

  const created = await prisma.material.create({
    data: { name, sectionWidthMm: w, sectionHeightMm: h, sortOrder: values.sortOrder ?? 0 },
  });
  await writeChangeLog({ entity: "Material", entityId: created.id, newValues: serialize(created) });
  revalidatePath(PATH);
  return serialize(created);
}

export async function updateMaterial(id: string, values: MaterialFormValues): Promise<Material> {
  const name = values.name.trim();
  if (!name) throw new Error("Название материала обязательно");

  const before = await prisma.material.findUnique({ where: { id } });
  if (!before) throw new Error("Материал не найден");
  const { w, h } = requireSection(values);

  const clash = await prisma.material.findFirst({
    where: { name, sectionWidthMm: w, sectionHeightMm: h, id: { not: id } },
  });
  if (clash) throw new Error(`Материал «${name} ${w}×${h}» уже существует`);

  const updated = await prisma.material.update({
    where: { id },
    data: {
      name,
      sectionWidthMm: w,
      sectionHeightMm: h,
      sortOrder: values.sortOrder ?? before.sortOrder,
    },
  });
  await writeChangeLog({
    entity: "Material",
    entityId: id,
    oldValues: serialize(before),
    newValues: serialize(updated),
  });
  revalidatePath(PATH);
  return serialize(updated);
}

async function setStatus(id: string, status: "ACTIVE" | "ARCHIVED"): Promise<Material> {
  const before = await prisma.material.findUnique({ where: { id } });
  if (!before) throw new Error("Материал не найден");
  const updated = await prisma.material.update({ where: { id }, data: { status } });
  await writeChangeLog({
    entity: "Material",
    entityId: id,
    oldValues: { status: before.status },
    newValues: { status },
  });
  revalidatePath(PATH);
  return serialize(updated);
}

export async function archiveMaterial(id: string): Promise<Material> {
  return setStatus(id, "ARCHIVED");
}

export async function restoreMaterial(id: string): Promise<Material> {
  return setStatus(id, "ACTIVE");
}

export async function deleteMaterial(id: string): Promise<void> {
  const [batches, details, products, blanks] = await Promise.all([
    prisma.batch.count({ where: { materialId: id } }),
    prisma.detail.count({ where: { materialId: id } }),
    prisma.product.count({ where: { materialId: id } }),
    prisma.blankStock.count({ where: { materialId: id } }),
  ]);
  if (batches + details + products + blanks > 0) {
    throw new Error("Нельзя удалить: материал используется (партии/детали/изделия/заготовки). Используйте «В архив».");
  }
  const before = await prisma.material.findUnique({ where: { id } });
  if (!before) throw new Error("Материал не найден");

  await prisma.material.delete({ where: { id } });
  await writeChangeLog({
    entity: "Material",
    entityId: id,
    oldValues: { name: before.name, status: before.status },
  });
  revalidatePath(PATH);
}
