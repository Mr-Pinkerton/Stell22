"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Monitor, Home } from "lucide-react";
import { navItems } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="text-muted-foreground flex h-12 items-center justify-center rounded-md border border-dashed text-xs">
          Логотип
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={item.title}
                      render={<Link href={item.href} />}
                    >
                      <Icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <Button
          variant="secondary"
          className="w-full justify-start"
          nativeButton={false}
          render={<Link href="/terminal" />}
        >
          <Monitor />В терминал
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start"
          nativeButton={false}
          render={<Link href="/dashboard" />}
        >
          <Home />
          На главную
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
