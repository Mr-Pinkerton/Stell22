# Интеграция с маркетплейсами (Ozon, Wildberries)

Справка по реальным API для разделов **«Продажи»** и **«Поставки»**. Источник —
официальная документация `dev.wildberries.ru` и анонсы Ozon Seller API
(конец 2025 — начало 2026). Реальные HTTP-вызовы подключаются при появлении
ключей; до тех пор `syncMarketplaces()` генерирует данные в том же формате, что
и API, и прогоняет их через те же мапперы (`src/lib/marketplace-map.ts`).

## Аутентификация
- **Ozon:** заголовки `Client-Id`, `Api-Key`; все методы — `POST` на
  `https://api-seller.ozon.ru`.
- **Wildberries:** заголовок `Authorization: <token>`; токены по категориям
  (Statistics, Analytics, Supplies, Finance). Хосты: `statistics-api.wildberries.ru`,
  `seller-analytics-api.wildberries.ru`, `supplies-api.wildberries.ru`.

---

## Wildberries

Данные обновляются ~раз в 30 минут. Пагинация — по `lastChangeDate` последней
строки предыдущего ответа (передаётся в `dateFrom`), пока не вернётся `[]`.

### Продажи — `GET /api/v1/supplier/sales`
1 строка = 1 продажа/возврат (1 товар). Ключевые поля:
```
date, lastChangeDate, warehouseName, regionName,
supplierArticle, nmId, barcode, category, subject, brand, techSize,
totalPrice, discountPercent, spp,
priceWithDisc, finishedPrice, forPay,
saleID (S… — продажа, R… — возврат), srid, gNumber
```
- `finishedPrice` — фактически уплачено покупателем (наша выручка).
- `forPay` — к перечислению продавцу (после комиссии).
- Возвраты приходят тем же методом (`saleID` начинается на `R`).
- `finishedPrice/priceWithDisc/forPay` могут быть 0 до 24 ч (заполняются
  асинхронно). Точные деньги — отчёт реализации
  `POST /api/finance/v1/sales-reports/detailed`.

### Заказы — `GET /api/v1/supplier/orders`
Те же поля + `isCancel`, `cancelDate`. Заказы ≠ выкупы.

### Остатки — `POST /api/analytics/v1/stocks-report/wb-warehouses`
(старый `GET /api/v1/supplier/stocks` отключён). Поля:
```
nmId, supplierArticle, barcode, warehouseName,
quantity, inWayToClient, inWayFromClient, quantityFull
```

### Поставки на склад WB (FBW) — `GET /api/v1/supplier/incomes`
```
incomeId, number, date, dateClose, lastChangeDate,
supplierArticle, nmId, barcode, techSize, quantity,
totalPrice, warehouseName, status
```
Статусы приёмки нормализуем в наш `ShipmentStatus`
(`PENDING`/`SHIPPED`/`ACCEPTED`): есть `dateClose` → `ACCEPTED`.

---

## Ozon

### Продажи (через отправления)
- FBO: `POST /v2/posting/fbo/list`, FBS: `POST /v3/posting/fbs/list`
  с `with: { analytics_data: true, financial_data: true }`.
- Поля отправления:
  ```
  posting_number, status, created_at, warehouse_id,
  products[{ sku, offer_id, name, quantity, price }],
  financial_data, analytics_data
  ```
- Агрегированная аналитика продаж — `POST /v1/analytics/data`
  (метрики по дням/SKU: `ordered_units`, `revenue`).
- Финансовый реестр (комиссии, выплаты) — `POST /v3/finance/transaction/list`.

### Остатки
- Аналитика: `POST /v1/analytics/stocks`
  (`sku, name, available_stock_count, warehouse_name, cluster_name`).
- Товарные: `POST /v1/product/info/stocks`
  (`offer_id, product_id, sku, stocks[{ warehouse_id, present, reserved }]`).

### Поставки на склад Ozon (FBO)
- `POST /v3/supply-order/list` → `POST /v3/supply-order/get` → состав (bundle).
  (v2 удалён в декабре 2025.)
- Поля заявки: `supply_order_id, status (created/confirmed/…),
  warehouse_id, planned_delivery_date, created_at`, состав — товары со `sku/quantity`.

---

## Маппинг на нашу модель данных

Внутренний ключ связи с себестоимостью — `Product.sku` ↔ `supplierArticle` (WB) /
`offer_id` (Ozon).

### `Sale` (продажи)
| Наше поле | WB | Ozon |
|---|---|---|
| `marketplace` | `"WB"` | `"OZON"` |
| `externalId` | `saleID` | `posting_number:offer_id` |
| `sku` | `supplierArticle` | `offer_id` |
| `quantity` | 1 (−1 для возврата) | `products[].quantity` |
| `revenue` | `finishedPrice` | `products[].price × quantity` |
| `isReturn` | `saleID` начинается с `R` | статус отмены/возврата |
| `date` | `date` | `created_at` |

Синхронизация — **upsert по `(marketplace, externalId)`** (идемпотентно, без
дублей и без «дописывания с момента»).

### `Supply` (поставки)
| Наше поле | WB (`incomes`) | Ozon (`supply-order`) |
|---|---|---|
| `externalId` | `incomeId` | `supply_order_id` |
| `number` | `number` | `supply_order_id` |
| `sku` | `supplierArticle` | `offer_id` |
| `quantity` | `quantity` | `quantity` из состава |
| `status` | из `dateClose`/`status` | нормализация из `status` |
| `createdAt` | `date` | `created_at` |
| `acceptedAt` | `dateClose` | дата приёмки |

Upsert по `(marketplace, externalId, sku)`.

### `MpStock` (остатки)
`quantity` — сколько лежит на складах маркетплейса. Снимок заменяется целиком
при каждой синхронизации.

### Списание со склада производства
Поставка = изделия физически ушли с нашего склада производства на МП. При
статусе **SHIPPED/ACCEPTED** синхронизация списывает `quantity` изделий из
`ProductStock` (по `sku → productId`). Списание идемпотентно (`Supply.deductedQty`
хранит уже списанное), нельзя в минус — при нехватке списываем до нуля и пишем
в аудит «потеря ГП».

---

## Подводные камни
- **Лимиты запросов:** WB — часто 1 запрос/мин на метод; Ozon — свои квоты.
- **Пагинация WB** — строго через `lastChangeDate`, не по offset.
- **Асинхронные деньги WB** — суммы уточняются до 24 ч.
- **Заказы ≠ выкупы** — для выручки берём продажи (`sales`), не заказы.
- **Валюты** — при оплате в другой валюте возможны округления.
- **Идемпотентность** — всегда upsert по внешнему id, не «append».
