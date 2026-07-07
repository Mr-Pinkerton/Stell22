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
    skuOzon: p.skuOzon,
    skuWb: p.skuWb,
    sort: p.sort,
    salePrice: toNum(p.salePrice) ?? 0,
    packagingId: p.packagingId,
    status: p.status,
    details: p.details.map((d) => ({ detailId: d.detailId, quantity: d.quantity })),
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
}

export async function getNomenclatureData(): Promise<NomenclatureData> {
  const [details, products, items] = await Promise.all([
    prisma.detail.findMany({ orderBy: { name: "asc" } }),
    prisma.product.findMany({ include: productInclude, orderBy: { name: "asc" } }),
    prisma.nomenclatureItem.findMany({ orderBy: { name: "asc" } }),
  ]);
  return {
    details: details.map(serializeDetail),
    products: products.map(serializeProduct),
    items: items.map(serializeItem),
  };
}

// ============================ ДЕТАЛИ =======================================

export interface DetailFormValues {
  name: string;
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
    detailNumber: v.detailNumber,
    lengthM: v.lengthM ?? 0,
    detailType: v.detailType,
    sort: v.sort,
    prisadkaTorcevaya: v.prisadkaTorcevaya,
    prisadkaPloskost: v.prisadkaPloskost,
  };
}

export async function createDetail(values: DetailFormValues): Promise<Detail> {
  if (!values.name.trim()) throw new Error("Название детали обязательно");
  if (!values.lengthM || values.lengthM <= 0) throw new Error("Укажите длину детали");

  const created = await prisma.detail.create({ data: detailData(values) });
  await writeChangeLog({ entity: "Detail", entityId: created.id, newValues: serializeDetail(created) });
  revalidatePath(PATH);
  return serializeDetail(created);
}

export async function updateDetail(id: string, values: DetailFormValues): Promise<Detail> {
  if (!values.name.trim()) throw new Error("Название детали обязательно");
  if (!values.lengthM || values.lengthM <= 0) throw new Error("Укажите длину детали");

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
  skuOzon: string;
  skuWb: string;
  sort: Sort;
  salePrice: number | null;
  packagingId: string | null;
  details: { detailId: string; quantity: number }[];
  fasteners: { nomenclatureId: string; quantity: number }[];
  extraIds: string[];
}

function validateProduct(v: ProductFormValues) {
  if (!v.name.trim()) throw new Error("Название изделия обязательно");
  if (!v.skuOzon.trim()) throw new Error("Артикул Ozon обязателен");
  if (!v.skuWb.trim()) throw new Error("Артикул WB обязателен");
}

export async function createProduct(values: ProductFormValues): Promise<Product> {
  validateProduct(values);

  const created = await prisma.product.create({
    data: {
      name: values.name.trim(),
      skuOzon: values.skuOzon.trim(),
      skuWb: values.skuWb.trim(),
      sort: values.sort,
      salePrice: values.salePrice ?? 0,
      packagingId: values.packagingId || null,
      details: { create: values.details.map((d) => ({ detailId: d.detailId, quantity: d.quantity })) },
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
        skuOzon: values.skuOzon.trim(),
        skuWb: values.skuWb.trim(),
        sort: values.sort,
        salePrice: values.salePrice ?? 0,
        packagingId: values.packagingId || null,
        details: { create: values.details.map((d) => ({ detailId: d.detailId, quantity: d.quantity })) },
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
