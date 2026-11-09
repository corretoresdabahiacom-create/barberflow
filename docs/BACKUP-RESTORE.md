# Backup e restauração

## O que existe
Workflow `.github/workflows/backup.yml` (diário 06:17 UTC + manual): `wrangler d1 export` → criptografia AES-256-CBC/PBKDF2 (200 mil iterações) → upload ao Google Drive via `scripts/drive-backup.mjs` → retenção (30 dias; preserva sempre os 3 mais recentes; só apaga arquivos `naregua-d1-*`).

**Estado de verificação:** a lógica de retenção e do upload multipart tem testes (`node --test scripts/`). **O fluxo completo nunca foi executado** (faltam credenciais). Antes de confiar nele, faça um backup manual e **um teste de restauração**.

## Configurar (uma vez)
1. Google Cloud Console → projeto → ativar Drive API → credencial OAuth (aplicativo Desktop) com escopo `https://www.googleapis.com/auth/drive.file`.
2. Obter um **refresh token** (OAuth Playground com seu próprio client, ou fluxo local) com esse escopo. Crie uma pasta no Drive e copie o ID.
3. Secrets do GitHub: `CLOUDFLARE_API_TOKEN` (permissão D1 Edit), `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_PASSPHRASE` (guarde também fora do GitHub!), `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`, `GDRIVE_FOLDER_ID`.
4. Em app OAuth em modo "Testing" o refresh token expira em 7 dias — publique o app (uso próprio) ou o backup para de funcionar silenciosamente. O workflow falha explicitamente quando o token é recusado.

## Restaurar
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in naregua-d1-XXXX.sql.enc -out dump.sql   # pede a senha
npx wrangler d1 create naregua-restore
npx wrangler d1 execute naregua-restore --remote --file=dump.sql
```
Valide contagens (`SELECT COUNT(*)` de `appointments`, `payments`) e só então aponte o `database_id` do Worker para o banco restaurado. Perder a `BACKUP_PASSPHRASE` = perder os backups.

## Time Travel do D1
O D1 também oferece restauração pontual nativa (janela depende do plano); é complementar, não substitui o backup externo.
