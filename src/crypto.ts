// Todas as funções usam a Web Crypto API nativa do Worker (sem libs externas).

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

// ---- Sessão (cookie assinado, sem estado no servidor) -----------------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(secret: string, ttlSeconds = 60 * 60 * 24 * 14): Promise<string> {
  const expires = Date.now() + ttlSeconds * 1000;
  const payload = `${expires}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${toHex(sig)}`;
}

export async function verifySessionToken(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const [payload, sigHex] = token.split(".");
  if (!payload || !sigHex) return false;
  const expires = Number(payload);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;

  const key = await hmacKey(secret);
  const expectedSig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expectedHex = toHex(expectedSig);

  if (expectedHex.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ sigHex.charCodeAt(i);
  }
  return diff === 0;
}

// ---- Criptografia das senhas de conta (AES-GCM) ------------------------
// CRYPTO_KEY é uma string base64 de 32 bytes gerada uma vez e guardada
// como secret. Nunca é enviada ao frontend.

async function aesKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, base64Key: string): Promise<string> {
  const key = await aesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plain);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptSecret(encoded: string, base64Key: string): Promise<string> {
  const key = await aesKey(base64Key);
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plainBuf);
}
