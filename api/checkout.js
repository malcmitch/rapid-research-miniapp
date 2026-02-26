/**
 * Vercel Serverless Function: POST /api/checkout
 *
 * Receives cart items from the Telegram Mini App, creates a Stripe Checkout
 * session, and returns the payment URL. On completion, the Stripe webhook
 * (handled by /api/webhook) fires the Telegram group notification.
 *
 * Required environment variables (set in Vercel dashboard):
 *   STRIPE_SECRET_KEY
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_GROUP_CHAT_ID
 */

import Stripe from "stripe";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(204).set(CORS_HEADERS).end();
  }

  // Set CORS headers on all responses
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ error: "Stripe not configured" });
  }

  const stripe = new Stripe(stripeKey);

  try {
    const { items, customerName, customerEmail, shippingAddress, promoCode } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required" });
    }

    // Build Stripe line items
    const lineItems = items.map((item) => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: `${item.name} (${item.conc})`,
          description: "Research use only — <99% purity",
          metadata: { productId: String(item.id) },
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.qty,
    }));

    // Determine origin for redirect URLs
    const origin =
      req.headers.origin ||
      req.headers.referer?.replace(/\/$/, "") ||
      "https://rapid-research-miniapp.vercel.app";

    // Format shipping address for metadata
    const shipAddr = shippingAddress || {};
    const shippingLine = [
      shipAddr.address,
      shipAddr.city,
      shipAddr.state,
      shipAddr.zip,
      shipAddr.country || "US",
    ]
      .filter(Boolean)
      .join(", ");

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: `${origin}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}?payment=cancelled`,
      customer_email: customerEmail || shipAddr.email || undefined,
      allow_promotion_codes: true,
      metadata: {
        customer_name: customerName || shipAddr.name || "Guest",
        customer_email: customerEmail || shipAddr.email || "",
        shipping_address: shippingLine,
        items_summary: items
          .map((i) => `${i.name} (${i.conc}) x${i.qty}`)
          .join(", ")
          .slice(0, 500),
        total_usd: items
          .reduce((s, i) => s + i.price * i.qty, 0)
          .toFixed(2),
        promo_code: promoCode || "none",
        source: "telegram_mini_app",
      },
    });

    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[Checkout] Error:", err);
    return res.status(500).json({ error: err.message || "Checkout failed" });
  }
}
