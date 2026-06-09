import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { config } from "../config.js";
import { logger } from "./logger.js";

const isConfigured = !!(config.supabase.url && config.supabase.serviceRoleKey);

if (!isConfigured) {
  logger.warn("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set — trusted number sync disabled, falling back to .env");
}

// Only create the client when both values are present.
// If either is missing the app still boots; all Supabase helpers become no-ops.
export const supabase = isConfigured
  ? createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        realtime: { transport: ws }
      }
    )
  : null;

/**
 * Fetch all trusted_number rows for the given businessId.
 * Returns null if Supabase is not configured or the query fails.
 */
export async function fetchTrustedNumbersFromSupabase(businessId) {
  if (!isConfigured || !supabase || !businessId) return null;
  const { data, error } = await supabase
    .from("trusted_numbers")
    .select("phone, label, active, last_message_at, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });

  if (error) {
    logger.error("Supabase fetchTrustedNumbers failed", { error: error.message });
    return null;
  }
  return data || [];
}

/**
 * Check a single phone number directly in Supabase (live query).
 * Used as a safety-net fallback when the in-memory cache misses.
 */
export async function checkTrustedNumberInSupabase(businessId, phone) {
  if (!isConfigured || !supabase || !businessId) return false;
  const { data, error } = await supabase
    .from("trusted_numbers")
    .select("phone, active")
    .eq("business_id", businessId)
    .eq("phone", phone)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    logger.error("Supabase checkTrustedNumber failed", { error: error.message, phone });
    return false;
  }
  return !!data;
}

/**
 * Upsert a trusted number row scoped to the given businessId.
 */
export async function upsertTrustedNumberInSupabase(businessId, { phone, label = "Staff", active = true }) {
  if (!isConfigured || !supabase || !businessId) return;
  const { error } = await supabase
    .from("trusted_numbers")
    .upsert({ business_id: businessId, phone, label, active }, { onConflict: "business_id,phone" });

  if (error) {
    logger.error("Supabase upsertTrustedNumber failed", { error: error.message, phone });
  }
}

/**
 * Delete a trusted number row scoped to the given businessId.
 */
export async function deleteTrustedNumberFromSupabase(businessId, phone) {
  if (!isConfigured || !supabase || !businessId) return;
  const { error } = await supabase
    .from("trusted_numbers")
    .delete()
    .eq("business_id", businessId)
    .eq("phone", phone);

  if (error) {
    logger.error("Supabase deleteTrustedNumber failed", { error: error.message, phone });
  }
}

/**
 * Update a single field on a trusted number row, scoped to the given businessId.
 */
export async function patchTrustedNumberInSupabase(businessId, phone, patch) {
  if (!isConfigured || !supabase || !businessId) return;
  const { error } = await supabase
    .from("trusted_numbers")
    .update(patch)
    .eq("business_id", businessId)
    .eq("phone", phone);

  if (error) {
    logger.error("Supabase patchTrustedNumber failed", { error: error.message, phone, patch });
  }
}
