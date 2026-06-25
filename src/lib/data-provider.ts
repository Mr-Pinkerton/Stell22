// Единый «провайдер» данных — шов между моками (Часть A) и реальным
// бэкендом (Часть B). UI обращается только сюда, не зная об источнике.
// При переходе на БД заменяется реализация, интерфейс остаётся прежним.

import type { Batch, Detail, Employee, NomenclatureItem, Product, RailLot } from "@/types/domain";
import * as fixtures from "@/mocks/fixtures";

export interface DataProvider {
  getEmployees(): Promise<Employee[]>;
  getBatches(): Promise<Batch[]>;
  getRailLots(batchId?: string): Promise<RailLot[]>;
  getNomenclature(): Promise<NomenclatureItem[]>;
  getDetails(): Promise<Detail[]>;
  getProducts(): Promise<Product[]>;
}

const mockProvider: DataProvider = {
  async getEmployees() {
    return fixtures.employees;
  },
  async getBatches() {
    return fixtures.batches;
  },
  async getRailLots(batchId) {
    return batchId ? fixtures.railLots.filter((l) => l.batchId === batchId) : fixtures.railLots;
  },
  async getNomenclature() {
    return fixtures.nomenclatureItems;
  },
  async getDetails() {
    return fixtures.details;
  },
  async getProducts() {
    return fixtures.products;
  },
};

// На старте всегда моки. В Части B здесь появится выбор реальной реализации.
export const dataProvider: DataProvider = mockProvider;
