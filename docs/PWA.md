# PWA

- `manifest.webmanifest` (standalone, ícones 192/512 e maskable em PNG).
- `public/sw.js` (escrito à mão): pré-guarda só o casco estático (`/`, ícone, manifest), cache-first em `/assets/*` (arquivos com hash), navegação com fallback ao `/` offline. **Nunca intercepta `/api/*`** e nunca guarda dados de usuário.
- Instalação: banner próprio — Android/Chrome usa `beforeinstallprompt`; iOS mostra instrução "Compartilhar → Adicionar à Tela de Início". Dispensável e lembrado em `localStorage` (com try/catch).
- Offline: abre o app; agenda e login exigem rede (dado de agenda velho é pior que nenhum).
- **Não verificado:** instalação em dispositivo real e auditoria Lighthouse.
