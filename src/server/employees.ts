"use server";

import { revalidatePath } from "next/cache";
import type { Employee as PrismaEmployee } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { requireAdmin } from "@/server/session";
import { pinErrorMessage, validateActivePin } from "@/lib/employee-pin";
import type { Employee } from "@/types/domain";

// Значения формы сотрудника (приходят из клиентского диалога).
export interface EmployeeFormValues {
  fullName: string;
  birthDate: string | null; // ISO yyyy-mm-dd
  pin: string;
  hourlyRate: number | null;
  rateTorcovkaSort1: number | null;
  rateTorcovkaSort2: number | null;
  // В UI одно поле «Присадка» — пишем в оба типа присадки.
  ratePrisadka: number | null;
  rateUpakovka: number | null;
}

const EMPLOYEES_PATH = "/employees";

function dec(value: PrismaEmployee[keyof PrismaEmployee] | null): number | null {
  if (value == null) return null;
  // Prisma.Decimal | number → number.
  return typeof value === "object" && "toNumber" in value
    ? (value as { toNumber: () => number }).toNumber()
    : Number(value);
}

/** Prisma Employee (Decimal) → доменный Employee (number) для UI. */
function serializeEmployee(e: PrismaEmployee): Employee {
  return {
    id: e.id,
    fullName: e.fullName,
    birthDate: e.birthDate ? e.birthDate.toISOString().slice(0, 10) : null,
    pin: e.pin,
    status: e.status,
    hourlyRate: dec(e.hourlyRate),
    rateTorcovkaSort1: dec(e.rateTorcovkaSort1),
    rateTorcovkaSort2: dec(e.rateTorcovkaSort2),
    ratePrisadkaTorcev: dec(e.ratePrisadkaTorcev),
    ratePrisadkaPloskt: dec(e.ratePrisadkaPloskt),
    rateUpakovka: dec(e.rateUpakovka),
  };
}

/**
 * Данные сотрудника для журнала изменений — БЕЗ PIN. PIN — единственный
 * идентификатор работника при входе в терминал, поэтому в аудите не хранится
 * ни старое, ни новое значение (фиксируем только факт смены — `pinChanged`).
 */
function auditEmployee(e: PrismaEmployee) {
  const s = serializeEmployee(e);
  return {
    id: s.id,
    fullName: s.fullName,
    birthDate: s.birthDate,
    status: s.status,
    hourlyRate: s.hourlyRate,
    rateTorcovkaSort1: s.rateTorcovkaSort1,
    rateTorcovkaSort2: s.rateTorcovkaSort2,
    ratePrisadkaTorcev: s.ratePrisadkaTorcev,
    ratePrisadkaPloskt: s.ratePrisadkaPloskt,
    rateUpakovka: s.rateUpakovka,
  };
}

/**
 * PIN сотрудника, который станет/останется ACTIVE: обязателен, ровно 4 цифры,
 * уникален среди активных. Источник истины — сервер (клиентская проверка
 * только для UX). `selfId` исключает самого сотрудника из проверки дублей.
 */
async function assertActivePin(pin: string, selfId?: string | null): Promise<void> {
  const activeEmployees = await prisma.employee.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, pin: true },
  });
  const error = validateActivePin({ pin, selfId, activeEmployees });
  if (error) throw new Error(pinErrorMessage(error));
}

export async function getEmployees(): Promise<Employee[]> {
  await requireAdmin();
  const rows = await prisma.employee.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(serializeEmployee);
}

function valuesToData(v: EmployeeFormValues) {
  return {
    fullName: v.fullName.trim(),
    birthDate: v.birthDate ? new Date(v.birthDate) : null,
    pin: v.pin.trim(),
    hourlyRate: v.hourlyRate,
    rateTorcovkaSort1: v.rateTorcovkaSort1,
    rateTorcovkaSort2: v.rateTorcovkaSort2,
    ratePrisadkaTorcev: v.ratePrisadka,
    ratePrisadkaPloskt: v.ratePrisadka,
    rateUpakovka: v.rateUpakovka,
  };
}

export async function createEmployee(values: EmployeeFormValues): Promise<Employee> {
  await requireAdmin();
  if (!values.fullName.trim()) throw new Error("ФИО обязательно");
  await assertActivePin(values.pin.trim()); // новый сотрудник всегда ACTIVE

  const created = await prisma.employee.create({
    data: { ...valuesToData(values), status: "ACTIVE" },
  });
  await writeChangeLog({
    entity: "Employee",
    entityId: created.id,
    newValues: auditEmployee(created),
  });
  revalidatePath(EMPLOYEES_PATH);
  return serializeEmployee(created);
}

export async function updateEmployee(
  id: string,
  values: EmployeeFormValues,
): Promise<Employee> {
  await requireAdmin();
  if (!values.fullName.trim()) throw new Error("ФИО обязательно");

  const before = await prisma.employee.findUnique({ where: { id } });
  if (!before) throw new Error("Сотрудник не найден");
  // Для архивного правила PIN не применяем — он не входит в терминал; проверка
  // будет при возврате в ACTIVE (restoreEmployee).
  if (before.status === "ACTIVE") await assertActivePin(values.pin.trim(), id);

  const updated = await prisma.employee.update({
    where: { id },
    data: valuesToData(values),
  });
  await writeChangeLog({
    entity: "Employee",
    entityId: id,
    oldValues: auditEmployee(before),
    newValues: { ...auditEmployee(updated), pinChanged: before.pin !== updated.pin },
  });
  revalidatePath(EMPLOYEES_PATH);
  return serializeEmployee(updated);
}

async function setStatus(id: string, status: "ACTIVE" | "ARCHIVED"): Promise<Employee> {
  const before = await prisma.employee.findUnique({ where: { id } });
  if (!before) throw new Error("Сотрудник не найден");

  const updated = await prisma.employee.update({ where: { id }, data: { status } });
  await writeChangeLog({
    entity: "Employee",
    entityId: id,
    oldValues: { status: before.status },
    newValues: { status },
  });
  revalidatePath(EMPLOYEES_PATH);
  return serializeEmployee(updated);
}

export async function archiveEmployee(id: string): Promise<Employee> {
  await requireAdmin();
  return setStatus(id, "ARCHIVED");
}

export async function restoreEmployee(id: string): Promise<Employee> {
  await requireAdmin();
  // Возврат в ACTIVE = сотрудник снова сможет войти в терминал по PIN, поэтому
  // формат и уникальность проверяем заново: пока он был в архиве, его PIN мог
  // достаться другому активному сотруднику.
  const before = await prisma.employee.findUnique({
    where: { id },
    select: { pin: true },
  });
  if (!before) throw new Error("Сотрудник не найден");
  await assertActivePin(before.pin.trim(), id);

  return setStatus(id, "ACTIVE");
}

export async function deleteEmployee(id: string): Promise<void> {
  await requireAdmin();
  const before = await prisma.employee.findUnique({
    where: { id },
    include: { _count: { select: { operations: true } } },
  });
  if (!before) throw new Error("Сотрудник не найден");
  if (before._count.operations > 0) {
    throw new Error("Нельзя удалить: есть производственные операции. Используйте «В архив».");
  }

  await prisma.employee.delete({ where: { id } });
  await writeChangeLog({
    entity: "Employee",
    entityId: id,
    oldValues: { fullName: before.fullName, status: before.status },
  });
  revalidatePath(EMPLOYEES_PATH);
}
