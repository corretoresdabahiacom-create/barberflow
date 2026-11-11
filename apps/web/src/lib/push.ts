import { api } from "./api";

const b64ToBytes = (s: string): Uint8Array => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const toB64 = (buf: ArrayBuffer | null): string => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "");

export const pushSupported = (): boolean => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function pushState(): Promise<"unsupported" | "server_off" | "denied" | "off" | "on"> {
  if (!pushSupported()) return "unsupported";
  const cfg = await api<{ enabled: boolean }>("/me/push/config", { auth: true });
  if (!cfg.enabled) return "server_off";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

export async function enablePush(): Promise<void> {
  const cfg = await api<{ enabled: boolean; publicKey: string | null }>("/me/push/config", { auth: true });
  if (!cfg.enabled || !cfg.publicKey) throw new Error("Notificações push não estão ativas neste servidor.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Permissão de notificações não concedida.");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.publicKey) as BufferSource }));
  await api("/me/push/subscriptions", { method: "POST", auth: true, body: { endpoint: sub.endpoint, keys: { p256dh: toB64(sub.getKey("p256dh")), auth: toB64(sub.getKey("auth")) } } });
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api("/me/push/subscriptions", { method: "DELETE", auth: true, body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}
