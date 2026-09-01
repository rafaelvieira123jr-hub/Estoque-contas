# Estoque de Contas

Painel pessoal para cadastrar, consultar e retirar contas de jogos do estoque,
com um assistente por comando de texto (Groq) que só consegue agir através de
um conjunto fixo e validado de operações — nunca com acesso livre ao banco.

## 1. Arquitetura

```
Navegador (celular ou desktop)
        │  HTTPS + cookie de sessão assinado
        ▼
Cloudflare Worker  ── serve o frontend estático (public/)
        │             e a API em /api/*
        │
        ├── Groq API  (só traduz texto → JSON de ação; nunca toca no banco)
        │
        ▼
Cloudflare D1 (SQLite)  ── accounts, stock_history, ai_commands
```

Frontend e backend vivem no mesmo Worker (usando o binding `[assets]` do
Wrangler), então não existe um projeto Cloudflare Pages separado: um único
`wrangler deploy` publica tudo. Isso elimina CORS e reduz a superfície de
configuração.

Fluxo de um comando de IA:

```
Você digita: "me dê uma conta de Blox Fruits por até R$3"
        ↓
Worker manda o texto pra Groq com um prompt fixo
        ↓
Groq responde só com JSON: {"action":"get_random_account","game":"Blox Fruits","max_price":3}
        ↓
Worker VALIDA esse JSON contra uma whitelist de ações e tipos (src/groq.ts)
        ↓
Worker executa a ação com SQL parametrizado (src/actions.ts, src/db.ts)
        ↓
Resultado + registro no histórico
```

A Groq nunca recebe a chave do banco, nunca gera SQL, e qualquer campo fora do
formato esperado derruba o comando com erro — não é executado "na tentativa".

## 2. Estrutura de pastas

```
estoque-contas/
├── wrangler.toml          # config do Worker, D1 e assets estáticos
├── schema.sql             # schema do banco D1
├── package.json
├── tsconfig.json
├── .dev.vars.example      # modelo das variáveis locais (copiar p/ .dev.vars)
├── src/
│   ├── index.ts           # rotas da API (Hono) + fallback pros assets
│   ├── auth.ts            # login, logout, middleware de sessão
│   ├── crypto.ts          # assinatura de sessão + criptografia de senhas
│   ├── db.ts              # todo acesso ao D1 (CRUD, reserva atômica, histórico)
│   ├── groq.ts            # chamada à Groq + validação estrita do JSON retornado
│   ├── actions.ts         # executa as ações validadas contra o banco
│   └── types.ts
└── public/                # frontend estático servido pelo próprio Worker
    ├── login.html
    ├── index.html          # painel/dashboard
    ├── estoque.html        # lista + filtros
    ├── conta.html          # detalhe/edição de uma conta
    ├── cadastro.html       # formulário de cadastro
    ├── ia.html             # comandos por linguagem natural
    ├── css/style.css
    └── js/{api,nav}.js
```

## 3. Schema do banco (D1)

Veja `schema.sql`. Resumo:

- **accounts**: `id` (UUID), `game`, `username`, `password_enc` (senha
  criptografada com AES-GCM, nunca em texto puro), `price`, `status`
  (`DISPONIVEL` / `RESERVADA` / `VENDIDA` / `BRINDE`), `level`, `contents`,
  `notes`, `created_at`, `updated_at`, `sold_at`.
- **stock_history**: toda mudança relevante (criação, reserva, venda, marcação
  como brinde, edição, exclusão, visualização de senha) fica registrada aqui.
- **ai_commands**: log de cada comando de IA, o JSON que a Groq devolveu, e o
  resultado — útil para auditar o que o assistente fez.

## 4. Segurança

- **Senhas das contas**: criptografadas com AES-GCM antes de gravar no D1.
  Só são descriptografadas sob demanda (botão "Mostrar" na página da conta),
  e cada visualização fica registrada no histórico.
- **Chave da Groq**: fica só como secret do Worker. O frontend nunca a vê.
- **Acesso ao banco**: só o Worker fala com o D1. O navegador nunca acessa o
  banco diretamente.
- **Login**: senha única (hash SHA-256 comparado no servidor) gera um cookie
  de sessão HMAC-assinado, `httpOnly`, `Secure`, `SameSite=Strict`. Não há
  senha nem hash no código-fonte — tudo vem de secrets.
- **Concorrência**: reservar uma conta usa
  `UPDATE accounts SET status='RESERVADA' WHERE id=? AND status='DISPONIVEL'`.
  Se duas requisições disputarem a mesma conta, só uma altera uma linha
  (`changes = 1`); a outra recebe `changes = 0` e tenta a próxima candidata.
  Isso dispensa locks manuais — o próprio D1 garante a atomicidade do UPDATE.

## 5. Pré-requisitos

- Node.js 18+
- Conta Cloudflare (plano gratuito é suficiente para <100 contas)
- Conta na Groq (https://console.groq.com) com uma API key
- `npm install -g wrangler` (ou use `npx wrangler`)

## 6. Configuração inicial

```bash
cd estoque-contas
npm install
wrangler login
```

### 6.1 Criar o banco D1

```bash
npm run db:create
```

Isso imprime um `database_id`. Copie e cole em `wrangler.toml`, substituindo
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Aplique o schema:

```bash
npm run db:migrate:local    # para testar localmente
npm run db:migrate:remote   # para o banco de produção
```

### 6.2 Gerar os secrets

**Hash da senha do painel** (troque `minhasenha` pela sua senha real):

```bash
node -e "crypto.subtle.digest('SHA-256', new TextEncoder().encode('minhasenha')).then(b => console.log(Buffer.from(b).toString('hex')))"
```

**Chave de criptografia das senhas de conta** (32 bytes em base64):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Segredo de sessão** (qualquer string longa e aleatória):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Chave da Groq**: copie do painel da Groq (https://console.groq.com/keys).

Configure tudo como secrets do Worker (nunca em arquivos versionados):

```bash
npm run secret:set-password   # cole o hash sha256 gerado acima
npm run secret:set-crypto     # cole a chave base64 de 32 bytes
npm run secret:set-session    # cole a string aleatória
npm run secret:set-groq       # cole sua chave da Groq
```

## 7. Testar localmente

Crie `.dev.vars` a partir do exemplo e preencha com os mesmos valores gerados
acima (localmente o Wrangler lê `.dev.vars` em vez dos secrets remotos):

```bash
cp .dev.vars.example .dev.vars
# edite .dev.vars com os valores reais
npm run db:migrate:local
npm run dev
```

Acesse `http://localhost:8787`, faça login com a senha escolhida, e teste o
cadastro de uma conta e um comando na página de IA.

## 8. Publicar (Cloudflare)

```bash
npm run deploy
```

O Wrangler publica o Worker (frontend + API) e ele já sai acessível em
`https://estoque-contas.<seu-subdominio>.workers.dev`. Para um domínio
próprio, adicione uma rota customizada no painel da Cloudflare
(Workers & Pages → seu Worker → Settings → Domains & Routes).

## 9. GitHub

```bash
git init
git add .
git commit -m "Estoque de contas: setup inicial"
gh repo create estoque-contas --private --source=. --push
```

Use um **repositório privado** — mesmo com as senhas criptografadas no banco,
não há motivo para tornar o projeto público. O `.gitignore` já impede que
`.dev.vars` e `.wrangler/` sejam commitados.

Opcional: no painel da Cloudflare, em Workers & Pages, você pode conectar
este repositório do GitHub para que cada `git push` na branch `main` dispare
um deploy automático (sem precisar rodar `wrangler deploy` manualmente nem
configurar GitHub Actions).

## 10. Uso no dia a dia

- **Painel**: totais, valor em estoque, últimas movimentações.
- **Estoque**: busca, filtro por status e preço, toque numa conta para ver
  detalhes, revelar a senha ou mudar o status.
- **Cadastrar**: formulário para adicionar uma conta nova.
- **IA**: digite comandos como:
  - "me dê uma conta aleatória de Meme Sea"
  - "me dê 3 contas de Grow a Garden"
  - "quantas contas de Meme Sea tenho?"
  - "marque a conta X como brinde" (use o ID exato, ou um trecho único do
    jogo/login — se houver mais de uma conta parecida, o sistema pede pra
    você especificar qual)
  - "quanto tenho em estoque?"
  - "quais contas estão vendidas?"

## 11. Limites conhecidos / próximos passos possíveis

- Login é de senha única (uso pessoal). Se algum dia mais de uma pessoa for
  usar o painel, vale trocar por Cloudflare Access na frente do domínio.
- O modelo da Groq (`llama-3.3-70b-versatile`) pode ser trocado em
  `src/groq.ts` caso a Groq descontinue esse nome — confira a lista atual em
  https://console.groq.com/docs/models.
- Não há paginação na listagem (limite de 200 contas por consulta), o que é
  de sobra para o volume descrito (<100 contas).
