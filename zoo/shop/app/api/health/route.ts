import { queryOne } from "@/lib/db";

export async function GET() {
  await queryOne("SELECT 1");
  return Response.json({ ok: true });
}
