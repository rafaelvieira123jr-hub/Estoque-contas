import { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Env } from "./types";
import { createSessionToken, sha256Hex, verifySessionToken } from "./crypto";

const COOKIE_NAME = "session";

export async function login(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ password?: string }>().catch(() => ({}));
  const password = body.password ?? "";

  const hash = await sha256Hex(password);
  if (hash !== c.env.PANEL_PASSWORD_HASH) {
    return c.json({ error: "Senha incorreta." }, 401);
  }

  const token = await createSessionToken(c.env.SESSION_SECRET);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return c.json({ ok: true });
}

export function logout(c: Context<{ Bindings: Env }>) {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
}

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const token = getCookie(c, COOKIE_NAME);
  const valid = await verifySessionToken(token, c.env.SESSION_SECRET);
  if (!valid) {
    return c.json({ error: "Não autenticado." }, 401);
  }
  await next();
}
