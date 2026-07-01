"use client";

import { useActionState } from "react";
import { AlertCircle } from "lucide-react";
import { signIn, type SignInState } from "@/server/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SignInState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, initialState);

  return (
    <form action={action} className="space-y-5">
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          placeholder="admin@stell22.local"
          className="bg-card h-11"
          required
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="password">Пароль</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          className="bg-card h-11"
          required
        />
      </div>

      {state.error && (
        <p className="text-destructive flex items-center gap-2 text-sm">
          <AlertCircle className="size-4 shrink-0" />
          {state.error}
        </p>
      )}

      <Button
        type="submit"
        variant="brand"
        disabled={pending}
        className="h-11 w-full rounded-xl text-base font-semibold"
      >
        {pending ? "Вход…" : "Войти"}
      </Button>
    </form>
  );
}
