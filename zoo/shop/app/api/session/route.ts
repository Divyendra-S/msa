import { login, logout } from "@/lib/auth";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!body.email || !body.password) {
    return Response.json({ error: "Email and password are required" }, { status: 400 });
  }
  const user = await login(body.email, body.password);
  if (!user) return Response.json({ error: "Wrong email or password" }, { status: 401 });
  return Response.json({ user });
}

export async function DELETE() {
  await logout();
  return Response.json({ ok: true });
}
