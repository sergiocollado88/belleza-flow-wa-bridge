// Supabase Edge Function: whatsapp-disconnect-session
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BRIDGE_URL = Deno.env.get("WA_BRIDGE_URL")!;
const BRIDGE_API_KEY = Deno.env.get("WA_BRIDGE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const authHeader = req.headers.get("Authorization");
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader?.replace("Bearer ", "") || "");
    if (authError || !user) throw new Error("Unauthorized");
    const { tenant_id } = await req.json();
    if (!tenant_id) throw new Error("tenant_id required");
    const { data: membership } = await supabase.from("user_tenants").select("id").eq("user_id", user.id).eq("tenant_id", tenant_id).maybeSingle();
    if (!membership) throw new Error("Forbidden");
    const bridgeRes = await fetch(`${BRIDGE_URL}/session/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": BRIDGE_API_KEY },
      body: JSON.stringify({ tenant_id }),
    });
    if (!bridgeRes.ok) throw new Error(`Bridge error: ${bridgeRes.status}`);
    await supabase.from("whatsapp_sessions").upsert(
      { tenant_id, status: "disconnected", qr_code: null, phone_number: null, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id" }
    );
    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
