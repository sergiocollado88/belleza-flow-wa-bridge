// Supabase Edge Function: whatsapp-webhook
// Called BY the wa-bridge server on Railway when:
// - Session status changes (QR code, connected, disconnected)
// - New incoming WhatsApp message
// Deploy with: supabase functions deploy whatsapp-webhook
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRIDGE_API_KEY = Deno.env.get("WA_BRIDGE_API_KEY")!;

serve(async (req) => {
  const secret = req.headers.get("x-webhook-secret");
  if (!secret || secret !== BRIDGE_API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await req.json();
    // Bridge sends: { event, tenant_id, data }
    const { event: type, tenant_id, data = {} } = payload;

    if (!type || !tenant_id) {
      return new Response(JSON.stringify({ error: "event and tenant_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Session status events ────────────────────────────────────────────────
    if (type === "qr_update" || type === "connected" || type === "disconnected") {
      const statusMap: Record<string, string> = {
        qr_update: "qr_pending",
        connected: "connected",
        disconnected: (data as any).reconnecting ? "reconnecting" : "disconnected",
      };

      await supabase.from("whatsapp_sessions").upsert(
        {
          tenant_id,
          status: statusMap[type] || type,
          qr_code: (data as any).qr || null,
          phone_number: (data as any).phone_number || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" }
      );
      console.log(`[${tenant_id}] Session event: ${type}`);
    }

    // ── Incoming WhatsApp message ─────────────────────────────────────────────
    // Bridge sends event = "message" (not "incoming_message")
    if (type === "message") {
      const {
        phone,
        body,
        sender_name,
        created_at,
        wa_message_id,
        channel,
      } = data as any;

      if (!phone || !body) {
        console.warn(`[${tenant_id}] Skipping message: missing phone or body`);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      let { data: conv } = await supabase
        .from("conversations")
        .select("id, unread_count")
        .eq("tenant_id", tenant_id)
        .eq("phone", phone)
        .eq("channel", channel || "whatsapp")
        .maybeSingle();

      if (!conv) {
        const { data: newConv } = await supabase
          .from("conversations")
          .insert({
            tenant_id,
            phone,
            channel: channel || "whatsapp",
            contact_name: sender_name || phone,
            status: "nuevo",
            unread_count: 1,
            last_message_at: created_at,
            last_message_preview: String(body).slice(0, 120),
          })
          .select("id, unread_count")
          .single();
        conv = newConv;
      } else {
        await supabase
          .from("conversations")
          .update({
            unread_count: (conv.unread_count || 0) + 1,
            last_message_at: created_at,
            last_message_preview: String(body).slice(0, 120),
          })
          .eq("id", conv.id);
      }

      if (conv?.id) {
        await supabase.from("messages").insert({
          conversation_id: conv.id,
          body: String(body),
          direction: "inbound",
          channel: channel || "whatsapp",
          created_at,
          status: "received",
          wa_message_id: wa_message_id || null,
        });
        console.log(`[${tenant_id}] Saved incoming from ${sender_name || phone}: ${String(body).slice(0, 40)}`);
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook error:", (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
