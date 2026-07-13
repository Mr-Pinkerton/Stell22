"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import type {
  Detail as PrismaDetail,
  NomenclatureItem as PrismaItem,
} from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import type {
  Detail,
  Material,
  NomenclatureItem,
  NomenclatureType,
  Product,
  RailType,
  Sort,
} from "@/types/domain";

const PATH = "/nomenclature";

function toNum(value: Prisma.Decimal | number | null): number | null {
  if (value == null) return null;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

// ============================ СЕРИАЛИЗАЦИЯ =================================

function serializeDetail(d: PrismaDetail): Detail {
  return {
    id: d.id,
    name: d.name,
    materialId: d.materialId,
    detailNumber: d.detailNumber,
    lengthM: toNum(d.lengthM) ?? 0,
    detailType: d.detailType,
    sort: d.sort,
    prisadkaTorcevaya: d.prisadkaTorcevaya,
    prisadkaPloskost: d.prisadkaPloskost,
    status: d.status,
  };
}

function serializeItem(n: PrismaItem): NomenclatureItem {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    unitPrice: toNum(n.unitPrice) ?? 0,
    status: n.status,
    minStock: n.minStock,
  };
}

type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { details: true; fasteners: true; extras: true };
}>;

function serializeProduct(p: ProductWithRelations): Product {
  return {
    id: p.id,
    name: p.name,
    materialId: p.materialId,
    skuOzon: p.skuOzon,
    skuWb: p.skuWb,
    sort: p.sort,
    packagingId: p.packagingId,
    status: p.status,
    details: p.details.map((d) => ({
      detailId: d.detailId,
      quantity: d.quantity,
    })),
    fastenerIds: p.fasteners.map((f) => ({ nomenclatureId: f.nomenclatureId, quantity: f.quantity })),
    extraIds: p.extras.map((e) => e.nomenclatureId),
  };
}

const productInclude = { details: true, fasteners: true, extras: true } as const;

// ============================ ЧТЕНИЕ =======================================

export interface NomenclatureData {
  details: Detail[];
  products: Product[];
  items: NomenclatureItem[];
  materials: Material[];
}

function serializeMaterial(m: { id: string; name: string; status: "ACTIVE" | "ARCHIVED"; sortOrder: number }): Material {
  return { id: m.id, name: m.name, status: m.status, sortOrder: m.sortOrder };
}

export async function getNomenclatureData(): Promise<NomenclatureData> {
  const [details, products, items, materials] = await Promise.all([
    prisma.detail.findMany({ orderBy: { name: "asc" } }),
    prisma.product.findMany({ include: productInclude, orderBy: { name: "asc" } }),
    prisma.nomenclatureItem.findMany({ orderBy: { name: "asc" } }),
    prisma.material.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
  ]);
  return {
    details: details.map(serializeDetail),
    products: products.map(serializeProduct),
    items: items.map(serializeItem),
    materials: materials.map(serializeMaterial),
  };
}

// ============================ ДЕТАЛИ =======================================

export interface DetailFormValues {
  name: string;
  materialId: string;
  detailNumber: number | null;
  lengthM: number | null;
  detailType: RailType;
  sort: Sort;
  prisadkaTorcevaya: boolean;
  prisadkaPloskost: boolean;
}

function detailData(v: DetailFormValues) {
  return {
    name: v.name.trim(),
    materialId: v.materialId,
    detailNumber: v.detailNumber ?? 0,
    lengthM: v.lengthM ?? 0,
    detailType: v.detailType,
    sort: v.sort,
    prisadkaTorcevaya: v.prisadkaTorcevaya,
    prisadkaPloskost: v.prisadkaPloskost,
  };
}

/**
 * Валидирует номер детали. Номер — свободная человекочитаемая метка (бейдж/
 * поиск/экспорт); он НЕ уникален и не участвует в сопоставлении (весь поток идёт
 * по detailId). Поэтому проверяем только, что номер указан — любой детали можно
 * присвоить любой номер, в т.ч. совпадающий с другой.
 */
function assertDetailNumberValid(values: DetailFormValues): void {
  if (!values.detailNumber || values.detailNumber <= 0) throw new Error("Укажите номер детали");
}

export async function createDetail(values: DetailFormValues): Promise<Detail> {
  if (!values.name.trim()) throw new Error("Название детали обязательно");
  if (!values.materialId) throw new Error("Укажите материал детали");
  if (!values.lengthM || values.lengthM <= 0) throw new Error("Укажите длину детали");
  assertDetailNumberValid(values);

  const created = await prisma.detail.create({ data: detailData(values) });
  await writeChangeLog({ entity: "Detail", entityId: created.id, newValues: serializeDetail(created) });
  revalidatePath(PATH);
  return serializeDetail(created);
}

export async function updateDetail(id: string, values: DetailFormValues): Promise<Detail> {
  if (!values.name.trim()) throw new Error("Название детали обязательно");
  if (!values.materialId) throw new Error("Укажите материал детали");
  if (!values.lengthM || values.lengthM <= 0) throw new Error("Укажите длину детали");
  assertDetailNumberValid(values);

  const before = await prisma.detail.findUnique({ where: { id } });
  if (!before) throw new Error("Деталь не найдена");

  const updated = await prisma.detail.update({ where: { id }, data: detailData(values) });
  await writeChangeLog({
    entity: "Detail",
    entityId: id,
    oldValues: serializeDetail(before),
    newValues: serializeDetail(updated),
  });
  revalidatePath(PATH);
  return serializeDetail(updated);
}

async function setDetailStatus(id: string, status: "ACTIVE" | "ARCHIVED"): Promise<Detail> {
  const before = await prisma.detail.findUnique({ where: { id } });
  if (!before) throw new Error("Деталь не найдена");
  const updated = await prisma.detail.update({ where: { id }, data: { status } });
  await writeChangeLog({
    entity: "Detail",
    entityId: id,
    oldValues: { status: before.status },
    newValues: { status },
  });
  revalidatePath(PATH);
  return serializeDetail(updated);
}

export async function archiveDetail(id: string): Promise<Detail> {
  return setDetailStatus(id, "ARCHIVED");
}

export async function restoreDetail(id: string): Promise<Detail> {
  return setDetailStatus(id, "ACTIVE");
}

export async function deleteDetail(id: string): Promise<void> {
  const usedInProduct = await prisma.productDetail.count({ where: { detailId: id } });
  if (usedInProduct > 0) {
    throw new Error("Нельзя удалить: деталь входит в изделие. Используйте «В архив».");
  }
  const before = await prisma.detail.findUnique({ where: { id } });
  if (!before) throw new Error("Деталь не найдена");

  await prisma.$transaction([
    prisma.detailStock.deleteMany({ where: { detailId: id } }),
    prisma.detail.delete({ where: { id } }),
  ]);
  await writeChangeLog({
    entity: "Detail",
    entityId: id,
    oldValues: { name: before.name, status: before.status },
  });
  revalidatePath(PATH);
}

// ====================== КРЕПЁЖ / УПАКОВКА / РАЗНОЕ =========================

export interface NomenclatureItemFormValues {
  name: string;
  unitPrice: number | null;
  type: NomenclatureType;
}

export async function createNomenclatureItem(
  values: NomenclatureItemFormValues,
): Promise<NomenclatureItem> {
  if (!values.name.trim()) throw new Error("Наименование обязательно");

  const created = await prisma.nomenclatureItem.create({
    data: { name: values.name.trim(), unitPrice: values.unitPrice ?? 0, type: values.type },
  });
  await writeChangeLog({
    entity: "NomenclatureItem",
    entityId: created.id,
    newValues: serializeItem(created),
  });
  revalidatePath(PATH);
  return serializeItem(created);
}

export async function updateNomenclatureItem(
  id: string,
  values: NomenclatureItemFormValues,
): Promise<NomenclatureItem> {
  if (!values.name.trim()) throw new Error("Наименование обязательно");

  const before = await prisma.nomenclatureItem.findUnique({ where: { id } });
  if (!before) throw new Error("Позиция не найдена");

  const updated = await prisma.nomenclatureItem.update({
    where: { id },
    data: { name: values.name.trim(), unitPrice: values.unitPrice ?? 0 },
  });
  await writeChangeLog({
    entity: "NomenclatureItem",
    entityId: id,
    oldValues: serializeItem(before),
    newValues: serializeItem(updated),
  });
  revalidatePath(PATH);
  return serializeItem(updated);
}

async function setItemStatus(id: string, status: "ACTIVE" | "ARCHIVED"): Promise<NomenclatureItem> {
  const before = await prisma.nomenclatureItem.findUnique({ where: { id } });
  if (!before) throw new Error("Позиция не найдена");
  const updated = await prisma.nomenclatureItem.update({ where: { id }, data: { status } });
  await writeChangeLog({
    entity: "NomenclatureItem",
    entityId: id,
    oldValues: { status: before.status },
    newValues: { status },
  });
  revalidatePath(PATH);
  return serializeItem(updated);
}

export async function archiveNomenclatureItem(id: string): Promise<NomenclatureItem> {
  return setItemStatus(id, "ARCHIVED");
}

export async function restoreNomenclatureItem(id: string): Promise<NomenclatureItem> {
  return setItemStatus(id, "ACTIVE");
}

export async function deleteNomenclatureItem(id: string): Promise<void> {
  const [fast, extra, pack, purchases] = await Promise.all([
    prisma.productFastener.count({ where: { nomenclatureId: id } }),
    prisma.productExtra.count({ where: { nomenclatureId: id } }),
    prisma.product.count({ where: { packagingId: id } }),
    prisma.simplePurchase.count({ where: { nomenclatureId: id } }),
  ]);
  if (fast + extra + pack + purchases > 0) {
    throw new Error("Нельзя удалить: позиция используется. Используйте «В архив».");
  }
  const before = await prisma.nomenclatureItem.findUnique({ where: { id } });
  if (!before) throw new Error("Позиция не найдена");

  await prisma.nomenclatureItem.delete({ where: { id } });
  await writeChangeLog({
    entity: "NomenclatureItem",
    entityId: id,
    oldValues: { name: before.name, status: before.status },
  });
  revalidatePath(PATH);
}

// ============================ ИЗДЕЛИЯ ======================================

export interface ProductFormValues {
  name: string;
  materialId: string;
  skuOzon: string;
  skuWb: string;
  sort: Sort;
  packagingId: string | null;
  details: { detailId: string; quantity: number }[];
  fasteners: { nomenclatureId: string; quantity: number }[];
  extraIds: string[];
}

/**
 * Изделие однородно по материалу: все детали состава обязаны быть того же
 * материала, что и изделие. Нужно для себестоимости (блендированная ₽/м считается
 * по породе) и консистентности справочника — на упаковку не влияет (она берёт
 * детали по detailId).
 */
async function assertProductDetailsMaterial(v: ProductFormValues): Promise<void> {
  const detailIds = v.details.map((d) => d.detailId);
  if (detailIds.length === 0) return;
  const details = await prisma.detail.findMany({
    where: { id: { in: detailIds } },
    select: { materialId: true },
  });
  const wrong = details.some((d) => d.materialId !== v.materialId);
  if (wrong) throw new Error("Все детали изделия должны быть выбранного материала");
}

function validateProduct(v: ProductFormValues) {
  if (!v.name.trim()) throw new Error("Название изделия обязательно");
  if (!v.materialId) throw new Error("Укажите материал изделия");
  if (!v.skuOzon.trim()) throw new Error("Артикул Ozon обязателен");
  if (!v.skuWb.trim()) throw new Error("Артикул WB обязателен");
  // Одна деталь входит в изделие одной строкой (номер — часть самой детали).
  const seen = new Set<string>();
  for (const d of v.details) {
    if (seen.has(d.detailId)) throw new Error("Повторяющаяся деталь в составе изделия");
    seen.add(d.detailId);
  }
}

export async function createProduct(values: ProductFormValues): Promise<Product> {
  validateProduct(values);
  await assertProductDetailsMaterial(values);

  const created = await prisma.product.create({
    data: {
      name: values.name.trim(),
      materialId: values.materialId,
      skuOzon: values.skuOzon.trim(),
      skuWb: values.skuWb.trim(),
      sort: values.sort,
      packagingId: values.packagingId || null,
      details: {
        create: values.details.map((d) => ({
          detailId: d.detailId,
          quantity: d.quantity,
        })),
      },
      fasteners: {
        create: values.fasteners.map((f) => ({
          nomenclatureId: f.nomenclatureId,
          quantity: f.quantity,
        })),
      },
      extras: { create: values.extraIds.map((nomenclatureId) => ({ nomenclatureId })) },
    },
    include: productInclude,
  });
  await writeChangeLog({
    entity: "Product",
    entityId: created.id,
    newValues: serializeProduct(created),
  });
  revalidatePath(PATH);
  return serializeProduct(created);
}

export async function updateProduct(id: string, values: ProductFormValues): Promise<Product> {
  validateProduct(values);
  await assertProductDetailsMaterial(values);

  const before = await prisma.product.findUnique({ where: { id }, include: productInclude });
  if (!before) throw new Error("Изделие не найдено");

  // Состав заменяем целиком: удаляем дочерние строки и создаём заново (атомарно).
  const updated = await prisma.$transaction(async (tx) => {
    await tx.productDetail.deleteMany({ where: { productId: id } });
    await tx.productFastener.deleteMany({ where: { productId: id } });
    await tx.productExtra.deleteMany({ where: { productId: id } });
    return tx.product.update({
      where: { id },
      data: {
        name: values.name.trim(),
        materialId: values.materialId,
        skuOzon: values.skuOzon.trim(),
        skuWb: values.skuWb.trim(),
        sort: values.sort,
        packagingId: values.packagingId || null,
        details: {
          create: values.details.map((d) => ({
            detailId: d.detailId,
            quantity: d.quantity,
          })),
        },
        fasteners: {
          create: values.fasteners.map((f) => ({
            nomenclatureId: f.nomenclatureId,
            quantity: f.quantity,
          })),
        },
        extras: { create: values.extraIds.map((nomenclatureId) => ({ nomenclatureId })) },
      },
      include: productInclude,
    });
  });

  await writeChangeLog({
    entity: "Product",
    entityId: id,
    oldValues: serializeProduct(before),
    newValues: serializeProduct(updated),
  });
  revalidatePath(PATH);
  return serializeProduct(updated);
}

async function setProductStatus(id: string, status: "ACTIVE" | "ARCHIVED"): Promise<Product> {
  const before = await prisma.product.findUnique({ where: { id } });
  if (!before) throw new Error("Изделие не найдено");
  const updated = await prisma.product.update({
    where: { id },
    data: { status },
    include: productInclude,
  });
  await writeChangeLog({
    entity: "Product",
    entityId: id,
    oldValues: { status: before.status },
    newValues: { status },
  });
  revalidatePath(PATH);
  return serializeProduct(updated);
}

export async function archiveProduct(id: string): Promise<Product> {
  return setProductStatus(id, "ARCHIVED");
}

export async function restoreProduct(id: string): Promise<Product> {
  return setProductStatus(id, "ACTIVE");
}

export async function deleteProduct(id: string): Promise<void> {
  const [goals, costs, stock] = await Promise.all([
    prisma.goal.count({ where: { productId: id } }),
    prisma.productCost.count({ where: { productId: id } }),
    prisma.productStock.count({ where: { productId: id } }),
  ]);
  if (goals + costs + stock > 0) {
    throw new Error("Нельзя удалить: изделие используется (цели/себестоимость/склад). Используйте «В архив».");
  }
  const before = await prisma.product.findUnique({ where: { id } });
  if (!before) throw new Error("Изделие не найдено");

  await prisma.$transaction([
    prisma.productDetail.deleteMany({ where: { productId: id } }),
    prisma.productFastener.deleteMany({ where: { productId: id } }),
    prisma.productExtra.deleteMany({ where: { productId: id } }),
    prisma.product.delete({ where: { id } }),
  ]);
  await writeChangeLog({
    entity: "Product",
    entityId: id,
    oldValues: { name: before.name, status: before.status },
  });
  revalidatePath(PATH);
}
