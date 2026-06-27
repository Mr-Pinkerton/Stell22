export type NotificationTone = "error" | "success" | "info";

export interface AdminNotification {
  id: string;
  title: string;
  message: string;
  tone: NotificationTone;
  /** ISO-строка времени. */
  occurredAt: string;
}

export const adminNotifications: AdminNotification[] = [
  {
    id: "n-1",
    title: "Партия «Волочек 2419»",
    message: "Отклонение сортов закупка/факт больше 10%",
    tone: "error",
    occurredAt: "2026-06-27T14:20:00+03:00",
  },
  {
    id: "n-2",
    title: "Склад — крепёж",
    message: "Остаток винта М6 ниже минимального порога",
    tone: "error",
    occurredAt: "2026-06-27T11:05:00+03:00",
  },
  {
    id: "n-3",
    title: "Зарплата за июнь",
    message: "Расчёт готов к проверке — 4 сотрудника",
    tone: "info",
    occurredAt: "2026-06-26T18:40:00+03:00",
  },
  {
    id: "n-4",
    title: "Партия закрыта",
    message: "«Сосна 3020» — себестоимость заморожена",
    tone: "success",
    occurredAt: "2026-06-26T09:15:00+03:00",
  },
  {
    id: "n-5",
    title: "Финансы",
    message: "3 операции в выписке не разнесены по статьям",
    tone: "info",
    occurredAt: "2026-06-25T16:30:00+03:00",
  },
];
