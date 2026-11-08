// confirm-age: records the caller's age confirmation in auth app_metadata (server-side only).
// POST {} or {action:'confirm'}: set the flag. POST {action:'decline'}: delete the caller's rows and then the auth user.
// Project: ywcrzkvwamjchjjkfrve (shared by every Bobo Learns site).
// Secrets: none to add. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
// Deploy (owner go only): supabase functions deploy confirm-age --project-ref ywcrzkvwamjchjjkfrve
// Keep JWT verification ON (the default). Do not pass --no-verify-jwt.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve((req) =>
  handle(req, {
    getUser: async (jwt) => {
      const { data, error } = await admin.auth.getUser(jwt);
      return error || !data.user ? null : data.user;
    },
    deleteUserRows: async (table, userId) => {
      const { error } = await admin.from(table).delete().eq("user_id", userId);
      if (!error) return { error: null };
      // 42P01 = undefined_table; PGRST205 = table not in the schema cache. Anything else is a real failure.
      return { error: error.message, missingTable: error.code === "42P01" || error.code === "PGRST205" };
    },
    deleteAuthUser: async (userId) => {
      const { error } = await admin.auth.admin.deleteUser(userId);
      return { error: error ? error.message : null };
    },
    setAppMetadata: async (userId, metadata) => {
      const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: metadata });
      return { error: error ? error.message : null };
    },
  })
);
