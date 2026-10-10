# SLA — Viação Hoffmann · Sistema de Viagens (protótipo)

Site estático (`index.html` + `logo.png`), sem build. Para rodar localmente basta abrir o `index.html`
ou servir a pasta (`python3 -m http.server`). Deploy: Vercel (projeto estático, sem configuração extra).

> **Protótipo demonstrativo.** Nenhuma passagem real é emitida e nenhum pagamento é processado.
> Todos os dados (reservas, motoristas, escalas, senha do administrador) ficam no `localStorage` do navegador.
> Para uso real são necessários servidor, banco de dados compartilhado e autenticação segura.

## Áreas
- **Início** – busca por origem/destino/data (municípios via API do IBGE), escolha de poltronas (até o nº de passageiros) e pré-reserva com QR.
- **Reservas** – reservas deste navegador (persistem ao recarregar).
- **Administração** – exige login do proprietário; frota, programação, gestão de motoristas e escalas.
- **Área da equipe** – candidatura de motoristas; painel do proprietário (aprova/recusa, gera código individual) e do motorista (aceita escalas, solicita viagens abertas, checklist).

## Acesso do administrador
Não há senha no código. No primeiro acesso a Administração/Área da equipe pede para **criar a senha** (mín. 6 caracteres),
guardada apenas como hash SHA-256 com sal no navegador. Para redefinir, limpe os dados do site.
Códigos de motoristas são exibidos uma única vez na aprovação e guardados só como hash.
