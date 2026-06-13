/**
 * /api/gemini
 * =========================================================================
 * TenderSync Pro Serverless Intelligence Engine
 * Secure Edge-compatible Node.js gateway routing for Google Gemini Pro API.
 * Designed & Engineered by Ankur Nagwan
 */

export const config = {
  runtime: 'edge', // Using Edge runtime for ultra-low latency streaming response
};

export default async function handler(req) {
  // 1. Enforce strict CORS and Method handling
  if (req.method === 'OPTIONS') {
    return new Response('OK', {
      status: 200,
      headers: getCorsHeaders(),
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  try {
    // 2. Extract and sanitize payload parameters
    const { tender, prompt: customPrompt } = await req.json();

    if (!tender || !tender.title) {
      return new Response(JSON.stringify({ error: 'Malformed payload: Missing tender context criteria.' }), {
        status: 400,
        headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // 3. Extract Secure Environment Secret Key (Updated to match Vercel lock)
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[TenderSync Backend Fault] GOOGLE_GEMINI_API_KEY is missing from environment ecosystem variables.');
      return new Response(JSON.stringify({ error: 'Backend Core Key Error: Intelligence services temporarily offline.' }), {
        status: 500,
        headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // 4. Construct high-fidelity executive prompt if not pre-compiled by frontend
    const promptPayload = customPrompt || `
You are a senior government procurement analyst. Analyze this tender and generate a structured Executive Briefing.

TENDER DATA:
Title: ${tender.title}
Organization: ${tender.organization}
Portal: ${tender.portal?.toUpperCase()}
ID: ${tender.bidId}
Due Date: ${tender.dueDate}
Estimated Budget: ${tender.budget}
Scraped At: ${tender.scrapedAt}

Provide the response in clean, high-density professional Markdown formatting with the following structural layout components:
### 📊 Executive Summary
### 🎯 Scope & Strategic Alignments
### ⚠️ Operational Risk Profile & Technical Safeguards
### 🛠️ Prerequisites & Documentation Checklists
### 📈 Recommendations & Next Action Items
    `.trim();

    // 5. Interface directly with Google Gemini Developer API (using modern gemini-1.5-pro/flash endpoint matrices)
    // Utilizing streamGenerateContent for native network chunk data streaming
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${apiKey}`;

    const apiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptPayload }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2, // Low temperature for deterministic, data-accurate output
          maxOutputTokens: 2048,
        }
      })
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error(`[Gemini Engine Error Response] Status: ${apiResponse.status} - Details: ${errText}`);
      return new Response(JSON.stringify({ error: 'Upstream gateway failure occurred processing model parsing parameters.' }), {
        status: apiResponse.status,
        headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // 6. Establish Server-Sent Events (SSE) Stream to pump model output token-by-token back to dashboard layout panels
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = apiResponse.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    // Fire asynchronous token parsing pool worker loop
    (async () => {
      try {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          
          // Gemini returns lines wrapped in JSON array formatting blocks for stream chunks
          // Parse stream fragments looking for text part payloads
          let matchIndex;
          while ((matchIndex = buffer.indexOf('\n')) >= 0) {
            let line = buffer.substring(0, matchIndex).trim();
            buffer = buffer.substring(matchIndex + 1);

            // Clean up leading commas or structural JSON streaming wrappers
            if (line.startsWith(',')) line = line.substring(1).trim();
            if (line.startsWith('[') || line.endsWith(']')) continue;

            try {
              if (line.length > 0) {
                const parsed = JSON.parse(line);
                const textChunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                if (textChunk) {
                  // Direct payload event write stream pushing data instantly down to Dashboard UI console hook
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ text: textChunk })}\n\n`));
                }
              }
            } catch (jsonErr) {
              // Silently bypass intermittent streaming framing issues on character boundary fragments
            }
          }
        }
        
        // Finalize secure data sequence channel transfer blocks
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (streamWriteErr) {
        console.error('[Stream Loop Exception Anchor Trap]:', streamWriteErr);
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        ...getCorsHeaders(),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });

  } catch (globalFault) {
    console.error('[Critical Global API Engine Framework Core Failure]:', globalFault);
    return new Response(JSON.stringify({ error: 'Internal Analytics System Pipeline Server Error.' }), {
      status: 500,
      headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Universal Access Control Header Definition Layouts
 */
function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}