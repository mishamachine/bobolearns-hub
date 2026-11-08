// confirm-age: records the caller's age confirmation in auth app_metadata (server-side only).
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
    setAppMetadata: async (userId, metadata) => {
      const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: metadata });
      return { error: error ? error.message : null };
    },
  })
);
