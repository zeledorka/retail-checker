// lib/supabase/auth.ts — server only
import 'server-only';
import { db } from './admin';
export async function getUser(req: Request) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  return error ? null : data.user;
}
export const isAdmin = (req: Request) =>
  !!process.env.ADMIN_SECRET && req.headers.get('x-admin-secret') === process.env.ADMIN_SECRET;