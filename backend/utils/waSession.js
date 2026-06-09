/**
 * Supabase-backed Baileys auth state.
 *
 * Stores all WhatsApp session keys in the `wa_sessions` table so the
 * session survives Railway redeploys without needing a persistent volume.
 *
 * Falls back to the standard file-system auth state when Supabase is not
 * configured (local dev without env vars, etc.).
 */
import {
  BufferJSON,
  initAuthCreds,
  proto,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import fs from "node:fs/promises";
import path from "node:path";
import { supabase } from "./supabase.js";
import { config } from "../config.js";
import { logger } from "./logger.js";

/* ─── helpers ──────────────────────────────────────────────────────────── */

async function dbRead(key) {
  const { data, error } = await supabase
    .from("wa_sessions")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) { logger.warn("wa_sessions read error", { key, error: error.message }); return null; }
  if (!data) return null;
  try { return JSON.parse(data.value, BufferJSON.reviver); } catch { return null; }
}

async function dbWrite(key, value) {
  const { error } = await supabase
    .from("wa_sessions")
    .upsert({ key, value: JSON.stringify(value, BufferJSON.replacer), updated_at: new Date().toISOString() },
             { onConflict: "key" });
  if (error) logger.warn("wa_sessions write error", { key, error: error.message });
}

async function dbDelete(key) {
  await supabase.from("wa_sessions").delete().eq("key", key);
}

/* ─── main export ──────────────────────────────────────────────────────── */

/**
 * Returns a Baileys auth state backed by Supabase if configured,
 * otherwise falls back to the standard multi-file (filesystem) auth state.
 */
export async function useAuthState(sessionDir) {
  // Fall back to filesystem when Supabase isn't configured
  if (!supabase) {
    logger.info("Supabase not configured — using filesystem auth state");
    return useMultiFileAuthState(sessionDir);
  }

  logger.info("Using Supabase-backed WhatsApp auth state");

  const creds = (await dbRead("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          await Promise.all(ids.map(async (id) => {
            let value = await dbRead(`${type}-${id}`);
            // Baileys requires this specific proto transform for app-state-sync keys
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            result[id] = value;
          }));
          return result;
        },

        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? dbWrite(key, value) : dbDelete(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },

    // Called by Baileys whenever credentials change
    saveCreds: () => dbWrite("creds", creds)
  };
}

/**
 * Check if a session already exists either in Supabase or local filesystem
 */
export async function hasSavedSession(sessionDir) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("wa_sessions")
        .select("key")
        .eq("key", "creds")
        .maybeSingle();
      if (error) return false;
      return !!data;
    } catch (err) {
      logger.warn("Failed to check saved session in Supabase", { error: err.message });
      return false;
    }
  } else {
    try {
      const credsPath = path.join(sessionDir, "creds.json");
      await fs.access(credsPath);
      return true;
    } catch {
      return false;
    }
  }
}
