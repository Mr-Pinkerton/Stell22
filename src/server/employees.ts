"use server";

import { revalidatePath } from "next/cache";
import type { Employee as PrismaEmployee } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
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

export async function getEmployees(): Promise<Employee[]> {
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
  if (!values.fullName.trim()) throw new Error("ФИО обязательно");

  const created = await prisma.employee.create({
    data: { ...valuesToData(values), status: "ACTIVE" },
  });
  await writeChangeLog({
    entity: "Employee",
    entityId: created.id,
    newValues: serializeEmployee(created),
  });
  revalidatePath(EMPLOYEES_PATH);
  return serializeEmployee(created);
}

export async function updateEmployee(
  id: string,
  values: EmployeeFormValues,
): Promise<Employee> {
  if (!values.fullName.trim()) throw new Error("ФИО обязательно");

  const before = await prisma.employee.findUnique({ where: { id } });
  if (!before) throw new Error("Сотрудник не найден");

  const updated = await prisma.employee.update({
    where: { id },
    data: valuesToData(values),
  });
  await writeChangeLog({
    entity: "Employee",
    entityId: id,
    oldValues: serializeEmployee(before),
    newValues: serializeEmployee(updated),
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
  return setStatus(id, "ARCHIVED");
}

export async function restoreEmployee(id: string): Promise<Employee> {
  return setStatus(id, "ACTIVE");
}

export async function deleteEmployee(id: string): Promise<void> {
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
