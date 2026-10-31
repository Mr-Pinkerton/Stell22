import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { requireAdmin } from "@/server/session";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requireAdmin();

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <AppHeader userName={user.name} />
        <main className="min-w-0 flex-1 space-y-6 p-4 md:p-8">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
