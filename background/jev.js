// Raw fetch client for Jev's /v1/systemone endpoint. No SDK: the SDK targets
// Node 20+, and a plain fetch from the service worker avoids CORS/bundling
// risk since we already have host permission for api.typesafe.ai.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-1.13.0";

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bodyDetail(body) {
  if (!body) return "";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.slice(0, 500);
}

function mapErrorMessage(status, body) {
  if (status === 401) return "TypeSafe rejected the API key (401). Check the key in Settings.";
  if (status === 429) return "TypeSafe rate limit hit (429).";
  if (status === 529) return "TypeSafe is overloaded (529).";
  // 400/422 (and anything else) are request-shape/validation errors — the
  // body almost always says exactly which field is wrong, so it must be
  // surfaced rather than swallowed into a bare status code.
  const detail = bodyDetail(body);
  return `TypeSafe rejected the request (${status})${detail ? `: ${detail}` : "."}`;
}

export async function callJev({ apiKey, model = MODEL, state, questions }) {
  if (!apiKey) throw new JevError("No API key configured.", 401);

  const maxTries = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, state, questions })
      });
    } catch (networkErr) {
      lastErr = new JevError(`Network error reaching TypeSafe: ${networkErr.message}`, 0);
      await sleep(300 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      return res.json();
    }

    let body;
    try { body = await res.json(); } catch { try { body = await res.text(); } catch { body = null; } }

    const message = mapErrorMessage(res.status, body);
    lastErr = new JevError(message, res.status);

    if (res.status === 429 || res.status === 529) {
      if (attempt < maxTries - 1) {
        const backoff = 400 * 2 ** attempt + Math.random() * 200;
        await sleep(backoff);
        continue;
      }
    }
    throw lastErr;
  }
  throw lastErr;
}
