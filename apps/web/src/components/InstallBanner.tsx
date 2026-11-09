import { useEffect, useState } from "react";
import { APP_NAME } from "../config/app";
import { Button } from "./ui";

interface BIPEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
const KEY = "naregua.install.dismissed";
const safeGet = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const safeSet = () => { try { localStorage.setItem(KEY, "1"); } catch { /* ignora */ } };

export function InstallBanner() {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [hidden, setHidden] = useState(safeGet() === "1");
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setEvt(e as BIPEvent); };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);

  if (standalone || hidden || (!evt && !ios)) return null;
  const close = () => { safeSet(); setHidden(true); };
  return (
    <div role="region" aria-label="Instalar aplicativo" className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-2xl border border-line bg-panel p-3 shadow-xl">
      <p className="text-sm">{evt ? `Instale o ${APP_NAME} no seu celular para abrir mais rápido.` : `No iPhone: toque em Compartilhar e depois em “Adicionar à Tela de Início” para instalar o ${APP_NAME}.`}</p>
      <div className="mt-2 flex gap-2">
        {evt && <Button onClick={async () => { await evt.prompt(); await evt.userChoice; setEvt(null); }}>Instalar</Button>}
        <Button variant="ghost" onClick={close}>Agora não</Button>
      </div>
    </div>
  );
}
