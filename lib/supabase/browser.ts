// lib/supabase/browser.ts — for Dev 2; it's the only way the frontend calls backend
'use client';
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
async function token() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  const { data: d, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return d.session!.access_token;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}`, ...init.headers } });
  const body = await res.json();
  if (!res.ok) throw body.error;
  return body as T;
}