import { Hono } from "hono";
import { Env, Status } from "./types";
import { login, logout, requireAuth } from "./auth";
import {
  createAccount,
  deleteAccount,
  getAccountById,
  getHistory,
  getAiCommandHistory,
  listAccounts,
  countAccounts,
  totalStockValue,
  revealPassword,
  updateAccountFields,
  logAiCommand,
} from "./db";
import { interpretCommand } from "./groq";
import { executeAction } from "./actions";

const app = new Hono<{ Bindings: Env }>();

// ---- Auth (públicas) ----------------------------------------------------
app.post("/api/login", login);
app.post("/api/logout", logout);

// ---- Tudo abaixo exige sessão válida ------------------------------------
app.use("/api/*", requireAuth);

app.get("/api/me", (c) => c.json({ ok: true }));

// ---- Dashboard / estatísticas -------------------------------------------
app.get("/api/stats", async (c) => {
  const [total, disponiveis, vendidas, brindes, reservadas, valorTotal, valorDisponivel] = await Promise.all([
    countAccounts(c.env, {}),
    countAccounts(c.env, { status: "DISPONIVEL" }),
    countAccounts(c.env, { status: "VENDIDA" }),
    countAccounts(c.env, { status: "BRINDE" }),
    countAccounts(c.env, { status: "RESERVADA" }),
    totalStockValue(c.env, {}),
    totalStockValue(c.env, { status: "DISPONIVEL" }),
  ]);
  return c.json({ total, disponiveis, vendidas, brindes, reservadas, valorTotal, valorDisponivel });
});

// ---- Contas ---------------------------------------------------------------
app.get("/api/accounts", async (c) => {
  const { game, status, max_price, search } = c.req.query();
  const rows = await listAccounts(c.env, {
    game: game || undefined,
    status: (status as Status) || undefined,
    maxPrice: max_price ? Number(max_price) : undefined,
    search: search || undefined,
  });
  const safe = rows.map(({ password_enc, ...rest }) => rest);
  return c.json({ accounts: safe });
});

app.get("/api/accounts/:id", async (c) => {
  const row = await getAccountById(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "Conta não encontrada." }, 404);
  const { password_enc, ...safe } = row;
  return c.json({ account: safe });
});

app.get("/api/accounts/:id/password", async (c) => {
  const password = await revealPassword(c.env, c.req.param("id"));
  if (password === null) return c.json({ error: "Conta não encontrada." }, 404);
  return c.json({ password });
});

app.post("/api/accounts", async (c) => {
  const body = await c.req.json<{
    game?: string;
    username?: string;
    password?: string;
    price?: number;
    level?: string;
    contents?: string;
    notes?: string;
    status?: Status;
  }>();

  if (!body.game || !body.username || !body.password || typeof body.price !== "number") {
    return c.json({ error: "Campos obrigatórios: game, username, password, price." }, 400);
  }

  const account = await createAccount(c.env, {
    game: body.game,
    username: body.username,
    password: body.password,
    price: body.price,
    level: body.level,
    contents: body.contents,
    notes: body.notes,
    status: body.status,
  });
  const { password_enc, ...safe } = account;
  return c.json({ account: safe }, 201);
});

app.patch("/api/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>();
  const updated = await updateAccountFields(c.env, id, body as never);
  if (!updated) return c.json({ error: "Conta não encontrada." }, 404);
  const { password_enc, ...safe } = updated;
  return c.json({ account: safe });
});

app.delete("/api/accounts/:id", async (c) => {
  const ok = await deleteAccount(c.env, c.req.param("id"));
  if (!ok) return c.json({ error: "Conta não encontrada." }, 404);
  return c.json({ ok: true });
});

// ---- Histórico -------------------------------------------------------------
app.get("/api/history", async (c) => {
  const history = await getHistory(c.env);
  return c.json({ history });
});

// ---- IA (comandos em linguagem natural) -------------------------------------
app.post("/api/ai/command", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  if (!text || !text.trim()) return c.json({ error: "Comando vazio." }, 400);

  try {
    const parsedAction = await interpretCommand(c.env, text);
    const result = await executeAction(c.env, parsedAction);
    await logAiCommand(c.env, text, parsedAction, result.summary, true);
    return c.json({ action: parsedAction, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido.";
    await logAiCommand(c.env, text, null, message, false);
    return c.json({ error: message }, 400);
  }
});

app.get("/api/ai/history", async (c) => {
  const history = await getAiCommandHistory(c.env);
  return c.json({ history });
});

// ---- Estático (frontend) + fallback ------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
