import { Link } from "react-router-dom";
import { LEGAL_VERSION, PRIVACY, TERMS, type Section } from "../content/legal";
import { Notice } from "../components/ui";
import { Shell } from "./PublicBooking";

function Doc({ title, sections }: { title: string; sections: Section[] }) {
  return (
    <Shell title={title}>
      <Notice kind="warn">Rascunho em revisão (versão {LEGAL_VERSION}). Não constitui aconselhamento jurídico.</Notice>
      {sections.map((s) => (
        <section key={s.title} className="space-y-2">
          <h2 className="font-semibold">{s.title}</h2>
          {s.body.map((p, i) => <p key={i} className="text-sm leading-relaxed text-mute">{p}</p>)}
        </section>
      ))}
      <Link to="/" className="text-sm text-amber underline">Voltar</Link>
    </Shell>
  );
}
export const Terms = () => <Doc title="Termos de Uso" sections={TERMS} />;
export const Privacy = () => <Doc title="Política de Privacidade" sections={PRIVACY} />;
