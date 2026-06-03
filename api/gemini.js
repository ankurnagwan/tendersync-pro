/**
 * api/gemini.js — Vercel Serverless Edge Function
 * =================================================
 * Zero-cost AI gateway. Proxies requests from the React dashboard
 * to the Google Gemini Pro API. Keeps the API key server-side.
 *
 * Deploy: add GOOGLE_GEMINI_API_KEY to Vercel environment variables.
 * Endpoint: POST /api/gemini  { prompt: string }
 * Response: { report: string }
 *
 * Rate limit: 60 req/min on free Gemini tier — sufficient for tender briefings.
 */

export const config = { runtime: 'edge' };

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

const ALLOWED_ORIGINS = [
  'https://gem-aggregator.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

export default async function handler(req) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  const origin = req.headers.get('origin') || '';
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let prompt, captchaImage;
  try {
    const body = await req.json();
    prompt       = body?.prompt;
    captchaImage = body?.captchaImage; // base64 image for CAPTCHA solving

    // CAPTCHA mode — build vision prompt
    if (captchaImage && !prompt) {
      prompt = 'This is a CAPTCHA image from an Indian government portal. Read the alphanumeric characters shown. Reply with ONLY those characters — no spaces, no explanation, just the text.';
    }

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400, headers: corsHeaders });
    }
    if (prompt.length > 12000) {
      return new Response(JSON.stringify({ error: 'Prompt too long' }), { status: 400, headers: corsHeaders });
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: corsHeaders });
  }

  // ── API key guard ──────────────────────────────────────────────────────────
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'GOOGLE_GEMINI_API_KEY not configured in Vercel environment variables.' }),
      { status: 503, headers: corsHeaders }
    );
  }

  // ── Build Gemini request ───────────────────────────────────────────────────
  let contents;
  if (captchaImage) {
    // Vision request — image + text
    contents = [{
      parts: [
        { inline_data: { mime_type: 'image/png', data: captchaImage } },
        { text: prompt },
      ]
    }];
  } else {
    // Text-only request
    contents = [{ parts: [{ text: prompt }] }];
  }

  // ── Call Gemini ─────────────────────────────────────────────────────────────
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 25_000); // 25s edge timeout

    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature:     captchaImage ? 0.1 : 0.3,
          maxOutputTokens: captchaImage ? 32  : 2048,
          topP: 0.8, topK: 40,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!geminiResp.ok) {
      const errText = await geminiResp.text().catch(() => 'Unknown Gemini error');
      console.error('[gemini edge] API error:', geminiResp.status, errText);
      return new Response(
        JSON.stringify({ error: `Gemini API error ${geminiResp.status}: ${errText.slice(0, 200)}` }),
        { status: 502, headers: corsHeaders }
      );
    }

    const data = await geminiResp.json();

    // Extract text from Gemini response structure
    const report =
      data?.candidates?.[0]?.content?.parts?.[0]?.text
      || data?.candidates?.[0]?.output
      || '';

    if (!report) {
      return new Response(
        JSON.stringify({ error: 'Gemini returned empty response', raw: JSON.stringify(data).slice(0, 500) }),
        { status: 502, headers: corsHeaders }
      );
    }

    return new Response(JSON.stringify({ report }), { status: 200, headers: corsHeaders });

  } catch (err) {
    if (err.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Gemini request timed out (25s)' }), { status: 504, headers: corsHeaders });
    }
    console.error('[gemini edge] Unexpected error:', err);
    return new Response(JSON.stringify({ error: `Internal error: ${err.message}` }), { status: 500, headers: corsHeaders });
  }
}
