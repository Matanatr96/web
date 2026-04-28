"use server";

import { redirect } from "next/navigation";
import { logInStonks } from "@/lib/auth";

export async function stonksLoginAction(_state: unknown, fd: FormData) {
  const password = String(fd.get("password") ?? "");
  const ok = await logInStonks(password);
  if (!ok) {
    return { error: "Incorrect password." };
  }
  redirect("/stonks");
}
