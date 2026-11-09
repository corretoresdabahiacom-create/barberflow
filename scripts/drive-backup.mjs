#!/usr/bin/env node
// Envia um arquivo (já criptografado) para uma pasta do Google Drive e aplica retenção.
// Escopo OAuth mínimo: drive.file (o app só enxerga arquivos que ele mesmo criou).
// Variáveis: GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN, GDRIVE_FOLDER_ID, BACKUP_RETENTION_DAYS (padrão 30).
// STATUS: lógica pura testada (scripts/drive-backup.test.mjs). O upload real NÃO foi executado: exige credenciais do Google.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export function buildMultipart(boundary, metadata, bytes, mime = "application/octet-stream") {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  return Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--`)]);
}

/** Seleciona o que apagar: somente arquivos com o prefixo do app e mais antigos que a retenção; nunca os `keepLatest` mais novos. */
export function selectExpired(files, { prefix, retentionDays, nowMs, keepLatest = 3 }) {
  const mine = files.filter((f) => f.name.startsWith(prefix)).sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime));
  return mine.slice(keepLatest).filter((f) => nowMs - Date.parse(f.createdTime) > retentionDays * 86400_000);
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variável ${name} ausente`);
  return v;
}

async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: need("GDRIVE_CLIENT_ID"), client_secret: need("GDRIVE_CLIENT_SECRET"), refresh_token: need("GDRIVE_REFRESH_TOKEN"), grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Falha ao obter token do Google (${res.status})`);
  return (await res.json()).access_token;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("uso: drive-backup.mjs <arquivo>");
  const folder = need("GDRIVE_FOLDER_ID");
  const token = await accessToken();
  const bytes = await readFile(file);
  const name = basename(file);
  const boundary = `naregua${Date.now()}`;
  const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: buildMultipart(boundary, { name, parents: [folder] }, bytes),
  });
  if (!up.ok) throw new Error(`Upload falhou (${up.status})`);
  const meta = await up.json();
  if (Number(meta.size) !== bytes.length) throw new Error(`Tamanho divergente no Drive (${meta.size} != ${bytes.length})`);
  console.log(`Enviado: ${meta.name} (${meta.size} bytes)`);

  const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
  const list = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&pageSize=1000`, { headers: { authorization: `Bearer ${token}` } });
  if (!list.ok) throw new Error(`Listagem falhou (${list.status})`);
  const expired = selectExpired((await list.json()).files, { prefix: "naregua-d1-", retentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 30), nowMs: Date.now() });
  for (const f of expired) {
    const del = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    console.log(`Retenção: ${f.name} ${del.ok ? "removido" : `falha ${del.status}`}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`ERRO: ${e.message}`); process.exit(1); });
}
