import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isAdmin()) {
    redirect("/admin");
  }
  return (
    <div className="max-w-sm mx-auto mt-12">
      <h1 className="text-2xl font-bold tracking-tight mb-4">Admin login</h1>
      <p className="text-sm text-stone-500 mb-4">
        Enter the admin password to add, edit, or delete restaurants.
      </p>
      <LoginForm />
    </div>
  );
}
