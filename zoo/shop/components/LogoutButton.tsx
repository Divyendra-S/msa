"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch("/api/session", { method: "DELETE" });
    router.push("/");
    router.refresh();
  }
  return (
    <button className="link" onClick={logout}>
      Log out
    </button>
  );
}
