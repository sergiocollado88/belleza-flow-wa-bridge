// Supabase Edge Function: whatsapp-send-message
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BRIDGE_URL = Deno.env.get("WA_BRIDGE_URL")!;
const BRIDGE_API_KEY = Deno.env.get("WA_BRIDGE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  }
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const authHeader = req.headers.get("Authorization");
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader?.replace("Bearer ", "") || "");
    if (authError || !user) throw new Error("Unauthorized");
    const { tenant_id, conversation_id, phone, message } = await req.json();
    const { data: membership } = await supabase.from("user_tenants").select("id").eq("user_id", user.id).eq("tenant_id", tenant_id).maybeSingle();
    if (!membership) throw new Error("Forbidden");
    const res = await fetch(`${BRIDGE_URL}/session/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": BRIDGE_API_KEY },
      body: JSON.stringify({ tenant_id, phone, message }),
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Bridge send failed"); }
    const now = new Date().toISOString();
    await supabase.from("messages").insert({ conversation_id, body: message, direction: "outbound", channel: "whatsapp", created_at: now, status: "sent" });
    await supabase.from("conversations").update({ last_message_at: now, last_message_preview: message.slice(0, 120) }).eq("id", conversation_id);
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
});
