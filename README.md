# 🤖 Production WhatsApp AI Assistant & Swiss Army Knife

A massively scalable, serverless WhatsApp AI bot built on **Hono**, designed to run on the Edge (Vercel/Cloudflare). This bot acts as a fully-featured personal assistant, combining Groq's lightning-fast models with Hugging Face's raw, uncensored inference capabilities and image generation.

It is heavily optimized for the free tiers of Vercel, Supabase, Groq, Hugging Face, and Upstash.

---

## 🌟 Core Features

- **⚡ Serverless Architecture**: Built on Hono. Zero polling. Utilizes `@upstash/workflow` to instantly queue incoming webhooks in the background, dodging Vercel's strict 10-second timeout limits on long AI generation tasks.
- **🧠 Hybrid AI Engines**:
  - **Groq (Llama-3)**: Acts as the lightning-fast default responder. Uses advanced **Function Calling** to intercept specific requests (like checking Sri Lankan train schedules via active web scraping).
  - **Hugging Face Serverless (Stheno 8B)**: A heavily optimized, completely unrestricted natural language chat model. Includes a Redis-backed memory pipeline that remembers your last 10 messages (optimized via character truncation to strictly stay within the free-tier context window).
- **🎨 AI Image Generation & Editing**: 
  - Send the bot `/imagine <prompt>` to generate images via Hugging Face.
  - Send an image with the caption `/imagine make it cyberpunk` to instantly run an Image-to-Image pipeline via the Meta Graph API.
- **🛡️ Enterprise Grade Rate Limiting & Allowlisting**: All webhooks ping a Supabase Allowlist database and an Upstash Sliding Window rate limiter (e.g., max 50 daily messages per user). Unauthorized users are silently dropped (saving your serverless compute overhead).
- **📝 Dual-Ship Cloud Logging**: Logs are flushed synchronously to Axiom via structural JSON and mirrored to Supabase.
- **🛡️ Idempotent Processing**: Utilizes a strict atomic `SETNX` lock in Redis to drop duplicate payloads sent by WhatsApp's aggressive retry algorithms.

---

## 🏗️ Architecture / Workflow Pipeline

1. **Meta Webhook (`POST /webhook`)**: WhatsApp delivers a message. 
2. **Instant Queue**: The router intercepts it, checks for `QSTASH` bindings, offloads the JSON directly to the Upstash background queue, and returns `200 OK` to WhatsApp within 50ms.
3. **Background Processing (`POST /workflow`)**: QStash securely initiates the execution loop:
    - **Filter Stage**: Duplicates are dropped. Un-allowlisted numbers are dropped.
    - **Rate Limit Stage**: Checks quotas. Replies with a polite rejection if daily limits are breached.
4. **Router Stage**:
   - If **Admin**: Intercepts `/uncensored` toggles, `/imagine` prompts, or `/allow` commands.
   - If **Uncensored Mode is ON**: Routes text straight to Hugging Face with the 10-message conversational memory buffer attached.
   - If **Standard Mode**: Routes to Groq. Groq evaluates if the request requires a tool call (like checking Train availability). If so, Groq triggers the underlying scraper, parses the result, and synthesizes a human response.
5. **Delivery Stage**: Bot issues a REST hit back to the Facebook Graph API delivering the final text or AI Image. Axiom logs are synchronously flushed.

---

## 🚀 Getting Started

### 1. Prerequisites
- [Meta for Developers Account](https://developers.facebook.com/) (For WhatsApp Business API)
- [Vercel](https://vercel.com) (For Edge Deployment)
- [Upstash Account](https://upstash.com) (For Redis limits & QStash background messaging)
- [Supabase](https://supabase.com) (For database logs and the Allowlist)
- API Keys for **Groq** and **Hugging Face**.

### 2. Setup your Environment
Copy the example file and populate the keys.
```bash
cp .env.example .env
```
*(Refer to `.env.example` for exactly what keys are required).*

### 3. Deploy
This bot is designed to run on the Edge. Push your repository to GitHub and link it to Vercel, or run:
```bash
npm i -g vercel
vercel --prod
```
Make sure to copy all your local `.env` secrets into the **Vercel Project Settings > Environment Variables**.

### 4. Link the Webhook
1. Copy your absolute deployed Vercel URL.
2. Go to the Meta Developer Portal -> WhatsApp -> Configuration.
3. Edit the Webhook and set the URL to `https://your-bot-url.vercel.app/webhook`.
4. Enter the arbitrary `VERIFY_TOKEN` you made up in your `.env`.
5. Under Manage fields, subscribe to **messages**.

---

## 🛠️ Admin Commands
The `ADMIN_NUMBER` configured in your `.env` has exclusive access to these commands:
- `/allow <number>` – Whitelists a new phone number to use the bot. Number must include country code (e.g., `94711234567`).
- `/remove <number>` – Revokes access for a number.
- `/uncensored on` – Flips the entire text engine over to the Hugging Face unrestricted model (Stheno). Initializes conversational memory.
- `/uncensored off` – Returns to fast Groq mode and instantly securely shreds all conversational memory logs.
- `/imagine <prompt>` – Generates an AI Image.
- `[Image Attached] /imagine <prompt>` – Modifies the provided photo using an Image-To-Image AI approach.
