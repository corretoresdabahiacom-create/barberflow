import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import type { AppDeps } from "./env";
import { withDeps, type AppEnv } from "./auth/middleware";
import { HttpError } from "./lib/http";
import { meRoutes } from "./routes/me";
import { orgRoutes } from "./routes/orgs";
import { publicRoutes } from "./routes/public";

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", withDeps(deps));

  // Cabeçalhos de segurança em toda resposta da API; dados privados nunca são cacheados.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });

  app.use(
    "/api/*",
    cors({
      origin: (origin, c) => {
        const allowed = String(c.env.ALLOWED_ORIGINS ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
        return allowed.includes(origin) ? origin : null;
      },
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );
  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: { code: "payload_too_large", message: "Corpo da requisição grande demais" } }, 413) }));

  app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_NAME, env: c.env.ENVIRONMENT }));
  app.route("/api/public", publicRoutes);
  app.route("/api/me", meRoutes);
  app.route("/api/orgs", orgRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Recurso não encontrado" } }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: "validation_error", message: "Dados inválidos" } }, 400);
    }
    // Nunca devolver detalhes internos ao cliente.
    console.error("unhandled_error", err instanceof Error ? err.message : String(err));
    return c.json({ error: { code: "internal_error", message: "Erro interno. Tente novamente." } }, 500);
  });

  return app;
}
