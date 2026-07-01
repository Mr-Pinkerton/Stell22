// Описание полей API-ключей маркетплейсов/банка для раздела «Настройки → API».
// Значения хранятся в key-value модели Setting под префиксом SETTING_PREFIX.
// Реальные HTTP-клиенты читают ключи через loadStoredApiCredentials() в
// src/server/settings.ts. См. docs/marketplace-api.md.

export interface ApiCredentialField {
  /** Стабильный ключ, напр. "ozon.clientId". */
  key: string;
  label: string;
  placeholder: string;
  /** Тип поля влияет только на подсказку/маскировку. */
  secret: boolean;
}

export interface ApiCredentialGroup {
  service: string;
  description: string;
  fields: ApiCredentialField[];
}

export const SETTING_PREFIX = "apiCred:";

export const API_CREDENTIAL_GROUPS: ApiCredentialGroup[] = [
  {
    service: "Ozon Seller API",
    description: "Продажи, поставки, остатки. Заголовки Client-Id и Api-Key.",
    fields: [
      { key: "ozon.clientId", label: "Client-Id", placeholder: "123456", secret: false },
      { key: "ozon.apiKey", label: "Api-Key", placeholder: "0a1b2c3d-…", secret: true },
    ],
  },
  {
    service: "Wildberries API",
    description: "Продажи, поставки (incomes), остатки. Токен категории Statistics/Analytics.",
    fields: [
      { key: "wb.token", label: "Токен", placeholder: "eyJhbGciOi…", secret: true },
    ],
  },
  {
    service: "Банк (выписки)",
    description: "Загрузка выписок в ДДС.",
    fields: [{ key: "bank.token", label: "Токен", placeholder: "bank_…", secret: true }],
  },
];

/** Все ключи полей (для валидации при сохранении). */
export const API_CREDENTIAL_KEYS: string[] = API_CREDENTIAL_GROUPS.flatMap((g) =>
  g.fields.map((f) => f.key),
);

export type ApiCredentialValues = Record<string, string>;
