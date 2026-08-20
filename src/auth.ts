import { Router, Request, Response, NextFunction } from "express";
import { Issuer, Client, generators } from "openid-client";
import { pool } from "./db";
import { Person } from "./types";

declare module "express-session" {
  interface SessionData {
    personId?: string;
    oidcState?: string;
    oidcNonce?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      person?: Person;
    }
  }
}

const entraConfigured = () =>
  !!(process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET);

let oidcClient: Client | null = null;
async function getOidcClient(): Promise<Client> {
  if (oidcClient) return oidcClient;
  const issuer = await Issuer.discover(
    `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0`
  );
  oidcClient = new issuer.Client({
    client_id: process.env.ENTRA_CLIENT_ID!,
    client_secret: process.env.ENTRA_CLIENT_SECRET!,
    redirect_uris: [process.env.ENTRA_REDIRECT_URI!],
    response_types: ["code"],
  });
  return oidcClient;
}

/**
 * Auto-provisions a `people` row on first successful login. New hires show
 * up with no manager set -- same "needs a human to check it" gap the
 * prototype already flags on the People & Roles tab, just for one field
 * instead of the whole org chart.
 */
async function findOrCreatePerson(opts: { email: string; name: string; entraObjectId?: string }): Promise<Person> {
  const existing = await pool.query<Person>("select * from people where email = $1", [opts.email]);
  if (existing.rows.length) return existing.rows[0];
  const inserted = await pool.query<Person>(
    `insert into people (name, email, entra_object_id) values ($1, $2, $3) returning *`,
    [opts.name, opts.email, opts.entraObjectId ?? null]
  );
  return inserted.rows[0];
}

export const authRouter = Router();

authRouter.get("/login", async (req: Request, res: Response) => {
  if (!entraConfigured()) {
    res.status(400).json({
      error:
        "Entra ID is not configured. In dev mode, send requests with an " +
        "X-Dev-User-Email header matching a row in `people` instead of using /auth/login.",
    });
    return;
  }
  const client = await getOidcClient();
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.oidcState = state;
  req.session.oidcNonce = nonce;
  res.redirect(client.authorizationUrl({ scope: "openid profile email", state, nonce }));
});

authRouter.get("/callback", async (req: Request, res: Response) => {
  const client = await getOidcClient();
  const params = client.callbackParams(req);
  const tokenSet = await client.callback(process.env.ENTRA_REDIRECT_URI!, params, {
    state: req.session.oidcState,
    nonce: req.session.oidcNonce,
  });
  const claims = tokenSet.claims();
  const email = (claims.email as string) ?? (claims.preferred_username as string);
  if (!email) {
    res.status(400).send("Identity provider did not return an email claim.");
    return;
  }
  const person = await findOrCreatePerson({
    email,
    name: (claims.name as string) ?? email,
    entraObjectId: claims.oid as string | undefined,
  });
  req.session.personId = person.id;
  res.redirect("/");
});

authRouter.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => res.status(204).end());
});

/**
 * Resolves `req.person` from the session. Falls back to a dev-only header
 * so the API is runnable against a seeded database with no IdP wired up
 * yet -- refuses to do that outside NODE_ENV=development.
 */
export async function identify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.session.personId) {
      const { rows } = await pool.query<Person>("select * from people where id = $1", [req.session.personId]);
      if (rows.length) {
        req.person = rows[0];
        next();
        return;
      }
    }

    if (process.env.NODE_ENV === "development" && !entraConfigured()) {
      const devEmail = req.header("x-dev-user-email");
      if (devEmail) {
        const { rows } = await pool.query<Person>("select * from people where email = $1", [devEmail]);
        if (rows.length) {
          req.person = rows[0];
          req.session.personId = rows[0].id;
          next();
          return;
        }
        res.status(401).json({ error: `No person with email ${devEmail}` });
        return;
      }
    }

    res.status(401).json({ error: "Not signed in." });
  } catch (err) {
    next(err);
  }
}
