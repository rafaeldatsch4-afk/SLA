# Viação Hoffmann — Sistema de Viagens (protótipo)

Site estático (`index.html`) + API serverless (`api/`) + Postgres (Neon) na Vercel.

> **Protótipo demonstrativo.** Nenhuma passagem real é emitida e nenhum pagamento é processado.
> Horários, preços e vagas são ilustrativos.

## Arquitetura
- `index.html` — front-end (HTML/CSS/JS puro, sem build). Fala com a API em `/api/*`.
- `api/index.js` — todas as rotas da API (um único handler com roteador interno).
- `lib/db.js` — conexão Postgres; cria o schema e os dados de exemplo sozinho na primeira requisição.
- `lib/crypto.js` — criptografia de campos pessoais (AES-256-GCM) e hash cego de e-mail.
- `lib/auth.js` — sessão por cookie assinado (HttpOnly, SameSite=Lax), hash de códigos, limite de tentativas de login.
- `lib/trips.js` — regras de viagens, poltronas e horários ilustrativos.
- `dev-server.js` — servidor local (estáticos + API). `tests/api-test.js` — testes da API.

## Variáveis de ambiente (Vercel → Settings → Environment Variables)
| Nome | Para quê |
|---|---|
| `DATABASE_URL` | String de conexão do Postgres (Neon). |
| `SESSION_SECRET` | Segredo (≥ 32 caracteres) que assina cookies e protege os códigos dos motoristas. |
| `ADMIN_PASSWORD` | Senha do administrador. Para trocar, edite a variável e faça redeploy. |
| `DATA_ENCRYPTION_KEY` | Chave (≥ 32 caracteres; use 64 hex) que criptografa telefone e e-mail dos candidatos. **Guarde uma cópia: sem ela esses dados não podem ser lidos.** |

## O que fica no banco
Reservas (com controle de poltronas no servidor — dois clientes não pegam a mesma poltrona), candidaturas e
códigos de motoristas (só o hash do código é guardado, e ele é exibido uma única vez ao aprovar), escalas,
solicitações de viagem, status da frota e das viagens.

## Segurança
- Telefone e e-mail dos candidatos a motorista são criptografados (AES-256-GCM) antes de ir ao banco; a checagem de e-mail duplicado usa um hash com chave (HMAC). Sem `DATA_ENCRYPTION_KEY` o servidor recusa novos cadastros em vez de gravar em texto puro. Nome e cidade ficam legíveis.
- Rotas de administrador/motorista exigem sessão válida; revogar um motorista derruba a sessão dele na hora.
- Login com limite de tentativas por IP (8 falhas em 15 min bloqueiam por 15 min).
- Toda escrita exige `Content-Type: application/json` (proteção CSRF) e valida os dados no servidor.
- Todo texto exibido passa por escape de HTML.
- "Minhas reservas" é por navegador (um identificador aleatório guardado no aparelho), pois não há conta de passageiro.

## Rodar localmente
```bash
npm install
DATABASE_URL=postgres://usuario@localhost:5432/vh SESSION_SECRET=um-segredo-bem-grande-1234567890 \
ADMIN_PASSWORD=minha-senha DATA_ENCRYPTION_KEY=$(openssl rand -hex 32) node dev-server.js 3000
# testes da API (servidor rodando):
BASE=http://localhost:3000 ADMIN_PASSWORD=minha-senha node tests/api-test.js
```
