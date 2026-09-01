export type Status = "DISPONIVEL" | "RESERVADA" | "VENDIDA" | "BRINDE";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PANEL_PASSWORD_HASH: string;
  SESSION_SECRET: string;
  CRYPTO_KEY: string;
  GROQ_API_KEY: string;
}

export interface AccountRow {
  id: string;
  game: string;
  username: string;
  password_enc: string;
  price: number;
  status: Status;
  level: string | null;
  contents: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  sold_at: string | null;
}

// Ação estruturada que a Groq deve retornar. O Worker nunca confia
// em nada além destes campos - tudo é validado antes de tocar no D1.
export interface AiAction {
  action:
    | "list_stock"
    | "count_accounts"
    | "get_random_account"
    | "get_multiple_accounts"
    | "update_status"
    | "total_stock_value";
  game?: string;
  status?: Status;
  max_price?: number;
  quantity?: number;
  account_id?: string;
  new_status?: Status;
}
