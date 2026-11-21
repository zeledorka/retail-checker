// Local player identity. In mock mode the player id lives here; in real mode the identity is the Supabase
// anonymous session (persisted by supabase-js) and we only keep the nickname for a fast restore.
const KEY = "aic:player:v1";
export type StoredPlayer = { playerId?: string; nickname?: string };

export function readPlayer(): StoredPlayer {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as StoredPlayer; } catch { return {}; }
}
export function writePlayer(p: StoredPlayer) {
  localStorage.setItem(KEY, JSON.stringify(p));
}
export function clearPlayer() {
  localStorage.removeItem(KEY);
}
/** Mock-mode player id. `create` mints one on first join. */
export function getPlayerId(create = false): string | null {
  const p = readPlayer();
  if (p.playerId) return p.playerId;
  if (!create) return null;
  const id = crypto.randomUUID();
  writePlayer({ ...p, playerId: id });
  return id;
}
