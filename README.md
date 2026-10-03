# WhatsApp Multi-session Bridge

Node.js service for managing WhatsApp QR sessions and forwarding normalized events to downstream automation workflows.

## What it demonstrates

- Multi-tenant and multi-branch session isolation.
- Node.js / Express service design.
- WhatsApp integration with Baileys.
- Webhook delivery to external automation systems.
- Environment-variable based configuration.
- Media download/cache handling.
- Input validation and session-key normalization.
- Reconnect and operational safety logic.
- Separation between the messaging transport layer and business automation workflows.

## Stack

- Node.js
- Express
- @whiskeysockets/baileys
- Webhooks / HTTP APIs
- QRCode
- Pino logging

## Architecture

```text
WhatsApp
   |
   v
Baileys session
   |
   v
Node.js / Express bridge
   |
   +--> session + media handling
   |
   +--> authenticated webhook
             |
             v
      automation / backend
```

The bridge is intentionally kept separate from the business logic. Its responsibility is connection/session management and reliable event transport; downstream systems handle CRM, AI, scheduling or other business rules.

## Configuration

The service is configured with environment variables such as:

```text
BRIDGE_API_KEY
WA_WEBHOOK_URL
BRIDGE_WEBHOOK_KEY
BRIDGE_PUBLIC_URL
SESSIONS_DIR
```

Values and production secrets are never committed to the repository.

## Portfolio context

This repository is part of a broader set of automation projects involving n8n, Supabase/PostgreSQL, AI agents, CRM workflows and SaaS applications.
