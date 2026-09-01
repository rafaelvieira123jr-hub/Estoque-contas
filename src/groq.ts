import { AiAction, Env } from "./types";

const SYSTEM_PROMPT = `Você traduz comandos em português sobre um estoque de contas de jogos para um único objeto JSON.
Responda APENAS com JSON válido, sem markdown, sem texto extra, sem explicações.

Formato exato:
{
  "action": "list_stock" | "count_accounts" | "get_random_account" | "get_multiple_accounts" | "update_status" | "total_stock_value",
  "game": string opcional,
  "status": "DISPONIVEL" | "RESERVADA" | "VENDIDA" | "BRINDE" opcional,
  "max_price": number opcional,
  "quantity": number opcional,
  "account_id": string opcional,
  "new_status": "DISPONIVEL" | "RESERVADA" | "VENDIDA" | "BRINDE" opcional
}

Regras:
- "me dê uma conta aleatória de X" -> action get_random_account, game=X, status=DISPONIVEL
- "me dê N contas de X" -> action get_multiple_accounts, game=X, quantity=N, status=DISPONIVEL
- "por até R$N" ou "por no máximo N" -> max_price = N
- "quantas contas de X tenho" -> action count_accounts, game=X
- "mostre meu estoque" / "quais contas estão Y" -> action list_stock (status=Y se mencionado)
- "quanto tenho em estoque" / "valor do estoque" -> action total_stock_value
- "marque a conta X como Y" -> action update_status, account_id=X (o texto exato entre aspas ou o identificador citado), new_status=Y
  onde Y mapeia: "brinde"->BRINDE, "vendida"/"vendido"->VENDIDA, "disponível"->DISPONIVEL, "reservada"->RESERVADA
- Se o comando não corresponder a nenhuma ação válida, responda: {"action": "list_stock"}
- Nunca invente um account_id que não esteja explicitamente no comando do usuário.
- Nomes de jogos: preserve como o usuário escreveu, apenas corrija capitalização óbvia.`;

export async function interpretCommand(env: Env, text: string): Promise<AiAction> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq API falhou (${response.status}): ${body}`);
  }

  const data = await response.json<{ choices: { message: { content: string } }[] }>();
  const raw = data.choices?.[0]?.message?.content ?? "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("A IA retornou um JSON inválido.");
  }

  return validateAiAction(parsed);
}

const VALID_ACTIONS = new Set([
  "list_stock",
  "count_accounts",
  "get_random_account",
  "get_multiple_accounts",
  "update_status",
  "total_stock_value",
]);

const VALID_STATUSES = new Set(["DISPONIVEL", "RESERVADA", "VENDIDA", "BRINDE"]);

// Esta é a barreira de segurança real: não importa o que a Groq mande,
// só sai daqui um objeto com exatamente os campos esperados e valores
// dentro dos tipos permitidos. O Worker nunca executa SQL a partir de
// texto livre gerado pela IA.
export function validateAiAction(input: unknown): AiAction {
  if (typeof input !== "object" || input === null) {
    throw new Error("Ação da IA inválida (não é objeto).");
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.action !== "string" || !VALID_ACTIONS.has(obj.action)) {
    throw new Error("Ação da IA não reconhecida.");
  }

  const result: AiAction = { action: obj.action as AiAction["action"] };

  if (obj.game !== undefined) {
    if (typeof obj.game !== "string" || obj.game.length > 100) throw new Error("Campo 'game' inválido.");
    result.game = obj.game;
  }
  if (obj.status !== undefined) {
    if (typeof obj.status !== "string" || !VALID_STATUSES.has(obj.status)) throw new Error("Campo 'status' inválido.");
    result.status = obj.status as AiAction["status"];
  }
  if (obj.new_status !== undefined) {
    if (typeof obj.new_status !== "string" || !VALID_STATUSES.has(obj.new_status)) throw new Error("Campo 'new_status' inválido.");
    result.new_status = obj.new_status as AiAction["new_status"];
  }
  if (obj.max_price !== undefined) {
    const n = Number(obj.max_price);
    if (!Number.isFinite(n) || n < 0) throw new Error("Campo 'max_price' inválido.");
    result.max_price = n;
  }
  if (obj.quantity !== undefined) {
    const n = Number(obj.quantity);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("Campo 'quantity' inválido.");
    result.quantity = n;
  }
  if (obj.account_id !== undefined) {
    if (typeof obj.account_id !== "string" || obj.account_id.length > 200) throw new Error("Campo 'account_id' inválido.");
    result.account_id = obj.account_id;
  }

  return result;
}
