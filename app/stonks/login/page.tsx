import { redirect } from "next/navigation";
import { hasStonksAccess } from "@/lib/auth";
import StonksLoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function StonksLoginPage() {
  if (await hasStonksAccess()) {
    redirect("/stonks");
  }
  return (
    <div className="max-w-sm mx-auto mt-12">
      <h1 className="text-2xl font-bold tracking-tight mb-4">Stonks login</h1>
      <p className="text-sm text-stone-500 mb-4">
        This page is private. Enter the password to view.
      </p>
      <StonksLoginForm />
    </div>
  );
}
