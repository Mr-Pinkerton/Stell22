import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/session";
import { LoginForm } from "@/components/auth/login-form";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  return (
    <main className="bg-muted/40 flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-brand shadow-soft flex size-12 items-center justify-center rounded-2xl text-lg font-bold text-white">
            S
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Stell22</h1>
            <p className="text-muted-foreground text-sm">Вход в панель управления</p>
          </div>
        </div>

        <Card className="surface-card ring-0">
          <CardContent className="p-6">
            <LoginForm />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
