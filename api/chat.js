/**
 * Vercel Serverless Function: POST /api/chat
 *
 * Streams AI responses for the in-app chat widget. Uses OpenAI GPT-4o
 * with a system prompt tuned for Rapid Research Co peptide products.
 *
 * Required environment variables:
 *   OPENAI_API_KEY
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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

const SYSTEM_PROMPT = `You are the AI customer support assistant for Rapid Research Co, a premium peptide research supply company.

PRODUCT CATALOG:
${PRODUCTS.map((p) =>
  `- ${p.name} (${p.category}): ${p.dosages.map((d, i) => `${d} = $${p.prices[i]}`).join(", ")} | Purity: ${p.purity}`
).join("\n")}

KEY POLICIES:
- All products are for LABORATORY AND RESEARCH PURPOSES ONLY — not for human consumption
- Minimum purity: ≥97–99% on all peptides, independently HPLC verified with COA
- Same-day dispatch on orders placed before 2PM CST
- Free shipping on orders over $150, otherwise $9.95 flat rate
- Temperature-controlled packaging included on all orders

YOUR ROLE:
- Answer questions about products, purity, dosage concentrations, pricing, and availability
- Explain shipping policies and COA details
- Guide customers on how to add products to cart and checkout in the mini app
- Be warm, professional, and concise — this is a mobile chat interface

IMPORTANT LIMITS:
- Never provide dosing instructions, administration advice, or anything resembling medical guidance
- If asked about human use, dosing protocols, or medical advice, politely decline and remind them products are for research use only
- Do not make up products or prices not listed above

Keep responses concise and mobile-friendly. Use short paragraphs.`;

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(204).set(CORS_HEADERS).end();
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "AI not configured" });
  }

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Keep last 20 messages to avoid token overflow
    const recentMessages = messages.slice(-20);

    // Call OpenAI with streaming
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...recentMessages,
        ],
        stream: true,
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.json().catch(() => ({}));
      throw new Error(err.error?.message || "OpenAI request failed");
    }

    // Stream the response back to the client
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = openaiRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            res.write("data: [DONE]\n\n");
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              // Send in AI SDK compatible format: 0:"text"
              res.write(`0:${JSON.stringify(content)}\n`);
            }
          } catch (e) {
            // Skip malformed chunks
          }
        }
      }
    }

    res.end();
  } catch (err) {
    console.error("[Chat] Error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || "Chat failed" });
    }
    res.end();
  }
}
