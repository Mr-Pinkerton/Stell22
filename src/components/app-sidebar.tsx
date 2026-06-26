"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Monitor } from "lucide-react";
import { navItems } from "@/lib/navigation";
import { cn } from "@/lib/utils";
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

const collapsedSectionClass = "group-data-[collapsible=icon]:px-2";

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar variant="floating" collapsible="icon">
      <SidebarHeader className={cn("px-3 pt-2", collapsedSectionClass)}>
        <div className="flex h-12 items-center gap-3 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="bg-brand flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-soft group-data-[collapsible=icon]:size-9">
            S
          </div>
          <span className="text-foreground truncate text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Stell22
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent className={cn("px-2", collapsedSectionClass)}>
        <SidebarGroup className="group-data-[collapsible=icon]:p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5 group-data-[collapsible=icon]:items-center">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem
                    key={item.href}
                    className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:justify-center"
                  >
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={item.title}
                      className={cn(
                        "h-11 rounded-2xl px-3 transition-all",
                        "group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0!",
                        "group-data-[collapsible=icon]:justify-center",
                        "data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground data-active:shadow-soft",
                        "data-active:hover:bg-sidebar-primary data-active:hover:text-sidebar-primary-foreground",
                      )}
                      render={<Link href={item.href} />}
                    >
                      <span
                        className={cn(
                          "icon-box [&_svg]:size-[18px] [&_svg]:stroke-[1.75]",
                          "group-data-[collapsible=icon]:hidden",
                          active
                            ? "bg-white/15 text-sidebar-primary-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        <Icon />
                      </span>
                      <Icon
                        className={cn(
                          "hidden size-[18px] shrink-0 stroke-[1.75] group-data-[collapsible=icon]:block",
                          active
                            ? "text-sidebar-primary-foreground"
                            : "text-muted-foreground",
                        )}
                      />
                      <span className="font-medium group-data-[collapsible=icon]:hidden">{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className={cn("gap-2 px-3 pb-3", collapsedSectionClass, "group-data-[collapsible=icon]:items-center")}>
        <Button
          variant="secondary"
          className="h-11 w-full justify-start rounded-2xl px-3 shadow-none group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 [&_svg]:stroke-[1.75]"
          nativeButton={false}
          render={<Link href="/terminal" />}
        >
          <span className="icon-box text-muted-foreground group-data-[collapsible=icon]:hidden">
            <Monitor />
          </span>
          <Monitor className="hidden size-[18px] shrink-0 group-data-[collapsible=icon]:block" />
          <span className="group-data-[collapsible=icon]:hidden">В терминал</span>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
