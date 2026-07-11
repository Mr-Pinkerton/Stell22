"use server";

import { revalidatePath } from "next/cache";
import type { Material as PrismaMaterial } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import type { Material } from "@/types/domain";

const PATH = "/nomenclature";

export interface MaterialFormValues {
  name: string;
  sortOrder?: number | null;
}

function serialize(m: PrismaMaterial): Material {
  return { id: m.id, name: m.name, status: m.status, sortOrder: m.sortOrder };
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

  const clash = await prisma.material.findUnique({ where: { name } });
  if (clash) throw new Error(`Материал «${name}» уже существует`);

  const created = await prisma.material.create({
    data: { name, sortOrder: values.sortOrder ?? 0 },
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

  const clash = await prisma.material.findFirst({ where: { name, id: { not: id } } });
  if (clash) throw new Error(`Материал «${name}» уже существует`);

  const updated = await prisma.material.update({
    where: { id },
    data: { name, sortOrder: values.sortOrder ?? before.sortOrder },
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
