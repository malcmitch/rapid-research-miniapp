/**
 * Vercel Serverless Function: POST /api/telegram
 *
 * Handles incoming messages to @RapidLabsSupportBot via Telegram webhook.
 * Responds with AI-generated answers about Rapid Research Co products.
 *
 * Required environment variables:
 *   TELEGRAM_BOT_TOKEN
 *   OPENAI_API_KEY
 *
 * Setup: After deploying, register the webhook once:
 *   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *        -d "url=https://rapid-research-miniapp.vercel.app/api/telegram"
 */

const TELEGRAM_API = "https://api.telegram.org";

const PRODUCTS = [
  { name: "Semaglutide", dosages: ["5mg", "10mg", "15mg"], purity: "≥98%", category: "GLP-1", prices: [85, 125, 165] },
  { name: "Tirzepatide", dosages: ["5mg", "10mg", "15mg"], purity: "≥98%", category: "GLP-1", prices: [75, 115, 155] },
  { name: "Retatrutide", dosages: ["5mg", "10mg", "15mg"], purity: "≥97%", category: "GLP-1", prices: [90, 130, 170] },
  { name: "Copper (GHK-Cu)", dosages: ["50mg", "100mg"], purity: "≥99%", category: "Peptides", prices: [45, 75] },
  { name: "Mots-C", dosages: ["10mg"], purity: "≥98%", category: "Peptides", prices: [55] },
  { name: "Selank", dosages: ["10mg"], purity: "≥98%", category: "Peptides", prices: [55] },
  { name: "5-Amino-1MQ", dosages: ["10mg"], purity: "≥98%", category: "Peptides", prices: [75] },
  { name: "NAD+", dosages: ["500mg"], purity: "≥99%", category: "Other", prices: [150] },
  { name: "Bacteriostatic Water", dosages: ["10ml"], purity: "USP grade", category: "Other", prices: [38] },
];

const SYSTEM_PROMPT = `You are the customer support assistant for Rapid Research Co, a premium peptide research supply company. You communicate via Telegram, so keep responses concise and conversational.

PRODUCT CATALOG:
${PRODUCTS.map((p) =>
  `- ${p.name} (${p.category}): ${p.dosages.map((d, i) => `${d} = $${p.prices[i]}`).join(", ")} | Purity: ${p.purity}`
).join("\n")}

KEY POLICIES:
- All products are for LABORATORY AND RESEARCH PURPOSES ONLY
- Purity: ≥97–99%, HPLC verified with COA provided
- Same-day dispatch on orders placed before 2PM CST
- Free shipping on orders over $150, otherwise $9.95 flat rate
- Customers can place orders through the Telegram Mini App

YOUR ROLE:
- Answer questions about products, purity, pricing, availability, shipping
- Direct customers to the mini app to place orders: https://rapid-research-miniapp.vercel.app
- Be warm, helpful, and professional

IMPORTANT LIMITS:
- Never provide dosing instructions, administration advice, or medical guidance
- If asked about human use or medical advice, politely decline and remind them products are for research only
- Do not make up products or prices not listed above

Keep responses short and mobile-friendly. Use plain text (no markdown unless needed).`;

// Simple in-memory conversation store (resets on cold start — acceptable for serverless)
const conversations = new Map();
const CONVERSATION_TTL = 30 * 60 * 1000; // 30 minutes

function getConversation(chatId) {
  const entry = conversations.get(chatId);
  if (!entry) return [];
  if (Date.now() - entry.lastActivity > CONVERSATION_TTL) {
    conversations.delete(chatId);
    return [];
  }
  return entry.messages;
}

function updateConversation(chatId, messages) {
  conversations.set(chatId, { messages: messages.slice(-20), lastActivity: Date.now() });
}

async function sendTelegramMessage(token, chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return res.json();
}

async function sendTypingAction(token, chatId) {
  await fetch(`${TELEGRAM_API}/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

async function getAIResponse(messages, apiKey) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 400,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || "OpenAI request failed");
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response. Please try again.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!token) {
    return res.status(500).json({ error: "Telegram not configured" });
  }

  // Acknowledge Telegram immediately (must respond within 5s)
  res.status(200).json({ ok: true });

  try {
    const update = req.body;

    // Only handle regular text messages
    const message = update.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();
    const firstName = message.from?.first_name || "there";

    // Handle commands
    if (text === "/start") {
      await sendTelegramMessage(
        token,
        chatId,
        `👋 Hi ${firstName}! Welcome to Rapid Research Co.\n\nI'm your AI assistant. I can help you with:\n• Product information & pricing\n• Purity specs & COA details\n• Shipping & order questions\n\nYou can also browse and order directly through our mini app 🧪\n\nWhat can I help you with today?`
      );
      return;
    }

    if (text === "/products") {
      const glp1 = PRODUCTS.filter((p) => p.category === "GLP-1");
      const peptides = PRODUCTS.filter((p) => p.category === "Peptides");
      const other = PRODUCTS.filter((p) => p.category === "Other");

      const formatProduct = (p) =>
        `• ${p.name}: ${p.dosages.map((d, i) => `${d}/$${p.prices[i]}`).join(", ")}`;

      const productList = [
        "🧬 GLP-1 Peptides:",
        ...glp1.map(formatProduct),
        "",
        "🔬 Research Peptides:",
        ...peptides.map(formatProduct),
        "",
        "💊 Other:",
        ...other.map(formatProduct),
        "",
        "All products ≥97–99% purity with COA.",
        "Order via the mini app: https://rapid-research-miniapp.vercel.app",
      ].join("\n");

      await sendTelegramMessage(token, chatId, productList);
      return;
    }

    if (text === "/help") {
      await sendTelegramMessage(
        token,
        chatId,
        `ℹ️ Available commands:\n\n/start — Welcome message\n/products — Full product catalog with pricing\n/help — This help message\n\nOr just ask me anything about our products, shipping, or COA details!`
      );
      return;
    }

    // AI-powered response for all other messages
    if (!apiKey) {
      await sendTelegramMessage(
        token,
        chatId,
        "I'm sorry, the AI assistant is temporarily unavailable. Please visit our mini app or try again later."
      );
      return;
    }

    // Show typing indicator
    await sendTypingAction(token, chatId);

    // Get conversation history and add new message
    const history = getConversation(chatId);
    const updatedHistory = [...history, { role: "user", content: text }];

    // Get AI response
    const aiReply = await getAIResponse(updatedHistory, apiKey);

    // Save conversation with AI response
    updateConversation(chatId, [...updatedHistory, { role: "assistant", content: aiReply }]);

    // Send response to user
    await sendTelegramMessage(token, chatId, aiReply);
  } catch (err) {
    console.error("[Telegram Webhook] Error:", err);
    // Don't re-send error to user — Telegram already got 200 OK
  }
}
