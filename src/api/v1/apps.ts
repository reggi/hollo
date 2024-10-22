import { base64 } from "@hexagon/base64";
import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { type Variables, scopeRequired, tokenRequired } from "../../oauth";
import {
  type NewApplication,
  type Scope,
  applications,
  scopeEnum,
} from "../../schema";

const logger = getLogger(["hollo", "api", "v1", "apps"]);

const app = new Hono<{ Variables: Variables }>();

const applicationSchema = z.object({
  client_name: z.string().optional(),
  redirect_uris: z
    .string()
    .trim()
    .transform((v, ctx) => {
      const uris = v.split(/\s+/g);
      for (const uri of uris) {
        const parsed = z.string().url().safeParse(uri);
        if (parsed.error != null) {
          for (const error of parsed.error.errors) {
            ctx.addIssue(error);
          }
          return z.NEVER;
        }
      }
      return uris;
    })
    .optional(),
  scopes: z
    .string()
    .trim()
    .transform((v, ctx) => {
      const scopes: Scope[] = [];
      for (const scope of v.split(/\s+/g)) {
        if (!scopeEnum.enumValues.includes(scope as Scope)) {
          ctx.addIssue({
            code: z.ZodIssueCode.invalid_enum_value,
            options: scopeEnum.enumValues,
            received: scope,
          });
          return z.NEVER;
        }
        scopes.push(scope as Scope);
      }
      return scopes;
    })
    .optional(),
  website: z.string().url().optional(),
});

app.post("/", async (c) => {
  let form: z.infer<typeof applicationSchema>;
  const contentType = c.req.header("Content-Type");
  if (
    contentType === "application/json" ||
    contentType?.match(/^application\/json\s*;/)
  ) {
    const json = await c.req.json();
    const result = await applicationSchema.safeParseAsync(json);
    if (!result.success) {
      logger.debug("Invalid request: {error}", { error: result.error });
      return c.json({ error: "Invalid request", zod_error: result.error }, 400);
    }
    form = result.data;
  } else {
    const formData = await c.req.parseBody();
    const result = await applicationSchema.safeParseAsync(formData);
    if (!result.success) {
      logger.debug("Invalid request: {error}", { error: result.error });
      return c.json({ error: "Invalid request", zod_error: result.error }, 400);
    }
    form = result.data;
  }
  if (form == null) {
    return c.json({ error: "Invalid request" }, 400);
  }
  const clientId = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer,
  );
  const clientSecret = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
  );
  const apps = await db
    .insert(applications)
    .values({
      id: crypto.randomUUID(),
      name: form.client_name ?? "",
      redirectUris: form.redirect_uris ?? [],
      scopes: form.scopes ?? (["read"] satisfies Scope[]),
      website: form.website,
      clientId,
      clientSecret,
    } satisfies NewApplication)
    .returning();
  const app = apps[0];
  const result = {
    id: app.id,
    name: app.name,
    website: app.website,
    redirect_uri: app.redirectUris.join(" "),
    client_id: app.clientId,
    client_secret: app.clientSecret,
    vapid_key: "",
  };
  logger.debug("Created application: {app}", { app: result });
  return c.json(result);
});

app.get(
  "/verify_credentials",
  tokenRequired,
  scopeRequired(["read"]),
  async (c) => {
    const token = c.get("token");
    const app = token.application;
    return c.json({
      id: app.id,
      name: app.name,
      website: app.website,
    });
  },
);

export default app;
