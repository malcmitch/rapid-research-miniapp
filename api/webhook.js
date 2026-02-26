/**
 * Vercel Serverless Function: POST /api/webhook
 *
 * Handles Stripe webhook events. On checkout.session.completed, sends a
 * formatted order notification to the configured Telegram group.
 *
 * Required environment variables:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_GROUP_CHAT_ID
 *
 * IMPORTANT: In Vercel dashboard, set this function to receive the raw body.
 * Add to vercel.json: { "functions": { "api/webhook.js": { "bodyParser": false } } }
 */

import Stripe from "stripe";
import { buffer } from "micro";

// Disable Vercel's default body parsing so Stripe can verify the signature
export const config = {
  api: {
    bodyParser: false,
  },
};

const TELEGRAM_API = "https://api.telegram.org";

async function sendTelegramMessage(token, chatId, text) {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[Webhook] Telegram send failed:", data);
    }
    return data.ok;
  } catch (err) {
    console.error("[Webhook] Telegram error:", err);
    return false;
  }
}

function escapeMarkdown(text) {
  return String(text || "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const groupChatId = process.env.TELEGRAM_GROUP_CHAT_ID;

  if (!stripeKey || !webhookSecret) {
    console.error("[Webhook] Stripe not configured");
    return res.status(500).json({ error: "Stripe not configured" });
  }

  const stripe = new Stripe(stripeKey);

  // Read raw body for signature verification
  let rawBody;
  try {
    rawBody = await buffer(req);
  } catch (err) {
    return res.status(400).json({ error: "Could not read body" });
  }

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("[Webhook] Signature verification failed:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Handle test events
  if (event.id.startsWith("evt_test_")) {
    return res.json({ verified: true });
  }

  console.log(`[Webhook] Event: ${event.type} (${event.id})`);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta = session.metadata || {};

    const customerName = escapeMarkdown(meta.customer_name || "Guest");
    const customerEmail = escapeMarkdown(meta.customer_email || session.customer_email || "N/A");
    const itemsSummary = meta.items_summary || "See Stripe dashboard";
    const total = meta.total_usd
      ? `$${meta.total_usd}`
      : session.amount_total
      ? `$${(session.amount_total / 100).toFixed(2)}`
      : "N/A";

    // Format item lines for Telegram
    const itemLines = itemsSummary
      .split(", ")
      .map((line) => `  • ${escapeMarkdown(line)}`)
      .join("\n");

    const message = [
      `🛒 *New Order Received\\!*`,
      ``,
      `👤 *Customer:* ${customerName}`,
      `📧 *Email:* ${customerEmail}`,
      ``,
      `📦 *Items:*`,
      itemLines,
      ``,
      `💰 *Total:* ${total}`,
      ``,
      `✅ *Payment confirmed via Stripe*`,
      `🆔 Session: \`${session.id.slice(-12)}\``,
    ].join("\n");

    if (botToken && groupChatId) {
      await sendTelegramMessage(botToken, groupChatId, message);
    } else {
      console.warn("[Webhook] Telegram not configured — skipping notification");
    }
  }

  return res.status(200).json({ received: true });
}
