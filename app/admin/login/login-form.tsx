"use client";

import { useActionState } from "react";
import { loginAction } from "../actions";

type State = { error?: string };

export default function LoginForm() {
  const [state, formAction, pending] = useActionState<State, FormData>(
    loginAction,
    {},
  );
  return (
    <form action={formAction} className="space-y-3">
      <input
        type="password"
        name="password"
        required
        autoFocus
        placeholder="Password"
        className="w-full px-3 py-2 text-sm rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900"
      />
      <button
        type="submit"
        disabled={pending}
        className="w-full px-3 py-2 text-sm rounded-md bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {state.error ? (
        <p className="text-sm text-red-600">{state.error}</p>
      ) : null}
    </form>
  );
}
