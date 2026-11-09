import { useEffect, useRef } from "react";

declare global {
  interface Window { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void; reset: (id?: string) => void } }
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile"));
    document.head.appendChild(s);
  });
  return loading;
}

export function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | undefined;
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !ref.current || !window.turnstile) return;
      id = window.turnstile.render(ref.current, {
        sitekey: siteKey, theme: "dark", language: "pt-br",
        callback: (t: string) => onToken(t), "expired-callback": () => onToken(null), "error-callback": () => onToken(null),
      });
    }).catch(() => onToken(null));
    return () => { cancelled = true; if (id && window.turnstile) window.turnstile.remove(id); };
  }, [siteKey, onToken]);
  return <div ref={ref} className="min-h-[65px]" />;
}
