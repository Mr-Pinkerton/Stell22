import {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Package,
  FileBarChart,
  Wallet,
  Factory,
  TrendingUp,
  Warehouse,
  Target,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface SectionFilters {
  search?: boolean;
  date?: boolean;
  /** Кнопка «За всё время» рядом с фильтром даты (Финансы). */
  dateAllTime?: boolean;
  weeks?: boolean;
  archive?: boolean;
}

export interface NavItem {
  slug: string;
  title: string;
  href: string;
  icon: LucideIcon;
  canExport: boolean;
  addLabel?: string;
  filters?: SectionFilters;
  /** Дашборд имеет свой каркас (переключатель периода вместо фильтров). */
  custom?: boolean;
}

export const navItems: NavItem[] = [
  {
    slug: "dashboard",
    title: "Дашборд",
    href: "/dashboard",
    icon: LayoutDashboard,
    canExport: false,
    custom: true,
  },
  {
    slug: "purchases",
    title: "Закупки",
    href: "/purchases",
    icon: ShoppingCart,
    canExport: true,
    addLabel: "Добавить партию",
    filters: { search: true, archive: true },
  },
  {
    slug: "employees",
    title: "Сотрудники",
    href: "/employees",
    icon: Users,
    canExport: true,
    addLabel: "Добавить сотрудника",
    filters: { search: true, archive: true },
  },
  {
    slug: "nomenclature",
    title: "Номенклатура",
    href: "/nomenclature",
    icon: Package,
    canExport: true,
    addLabel: "Добавить",
    filters: { search: true },
  },
  {
    slug: "reports",
    title: "Отчёты",
    href: "/reports",
    icon: FileBarChart,
    canExport: true,
    filters: { date: true, archive: true },
  },
  {
    slug: "finance",
    title: "Финансы",
    href: "/finance",
    icon: Wallet,
    canExport: true,
    addLabel: "Добавить",
    filters: { date: true, dateAllTime: true },
  },
  {
    slug: "production",
    title: "Производство",
    href: "/production",
    icon: Factory,
    canExport: true,
    addLabel: "Добавить",
    filters: { date: true },
  },
  {
    slug: "sales",
    title: "Продажи",
    href: "/sales",
    icon: TrendingUp,
    canExport: false,
    filters: { date: true },
  },
  {
    slug: "warehouse",
    title: "Склад",
    href: "/warehouse",
    icon: Warehouse,
    canExport: true,
    addLabel: "Добавить",
  },
  {
    slug: "goals",
    title: "Цели",
    href: "/goals",
    icon: Target,
    canExport: false,
    addLabel: "Создать цель",
    filters: { date: true },
  },
  {
    slug: "settings",
    title: "Настройки",
    href: "/settings",
    icon: Settings,
    canExport: false,
  },
];

export function getNavItem(slug: string): NavItem | undefined {
  return navItems.find((i) => i.slug === slug);
}
