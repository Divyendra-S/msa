import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { query, queryOne } from "./db";

export const SESSION_COOKIE = "sid";
const SESSION_DAYS = 7;

export interface User {
  id: number;
  email: string;
  name: string;
}

export async function getCurrentUser(): Promise<User | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  const user = await queryOne<User>(
    `SELECT u.id, u.email, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sid],
  );
  return user ?? null;
}

export async function login(email: string, password: string): Promise<User | null> {
  const row = await queryOne<User & { password_hash: string }>(
    "SELECT id, email, name, password_hash FROM users WHERE email = $1",
    [email.trim().toLowerCase()],
  );
  if (!row || !verifyPassword(password, row.password_hash)) return null;

  const sid = randomBytes(24).toString("hex");
  await query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [
    sid,
    row.id,
  ]);
  (await cookies()).set(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  return { id: row.id, email: row.email, name: row.name };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (sid) await query("DELETE FROM sessions WHERE id = $1", [sid]);
  jar.delete(SESSION_COOKIE);
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}
