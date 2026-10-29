import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import RECIPES from "../../data/recipes.json" with { type: "json" };

// Two Plates API: sign-in by shared kitchen passcode, per-person state in Netlify Blobs.
// Each person only ever writes their own blob ("person/will", "person/ella"), so the two of you
// can't overwrite each other's ratings.

const PEOPLE = ["will", "ella"] as const;
type Person = (typeof PEOPLE)[number];
const COOKIE = "tp";
const MAX_AGE = 60 * 60 * 24 * 180; // stay signed in for 180 days

const store = () => getStore({ name: "two-plates", consistency: "strong" });

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

function secret(): string {
  const s = Netlify.env.get("SESSION_SECRET");
  if (!s || s.length < 32) throw new Error("SESSION_SECRET is not set");
  return s;
}
const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url");
const sameText = (a: string, b: string) => {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
};

function sessionCookie(who: Person) {
  const exp = Date.now() + MAX_AGE * 1000;
  const v = `${who}.${exp}`;
  return `${COOKIE}=${v}.${sign(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function whoFrom(req: Request): Person | null {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)tp=([^;]+)/);
  if (!m) return null;
  const [who, exp, sig] = m[1].split(".");
  if (!PEOPLE.includes(who as Person) || !exp || !sig) return null;
  if (Number(exp) < Date.now()) return null;
  return sameText(sig, sign(`${who}.${exp}`)) ? (who as Person) : null;
}

/* ---- validation: only accept the shapes the site writes ---- */
const SLUG = /^[a-z0-9-]{1,140}$/;
type PersonState = {
  ratings: Record<string, number>;
  favs: Record<string, 1>;
  likes: Record<string, 1>;
  skips: Record<string, 1>;
  notes: Record<string, string>;
  cooked: { s: string; d: string }[];
  updated?: string;
};
const empty = (): PersonState => ({ ratings: {}, favs: {}, likes: {}, skips: {}, notes: {}, cooked: [] });

function clean(body: any): PersonState | null {
  if (!body || typeof body !== "object") return null;
  const out = empty();
  const flags = (src: any, dst: Record<string, 1>) => {
    if (!src || typeof src !== "object") return;
    for (const k of Object.keys(src).slice(0, 5000)) if (SLUG.test(k)) dst[k] = 1;
  };
  if (body.ratings && typeof body.ratings === "object") {
    for (const [k, v] of Object.entries(body.ratings).slice(0, 5000)) {
      const n = Number(v);
      if (SLUG.test(k) && Number.isInteger(n) && n >= 1 && n <= 5) out.ratings[k] = n;
    }
  }
  flags(body.favs, out.favs);
  flags(body.likes, out.likes);
  flags(body.skips, out.skips);
  if (body.notes && typeof body.notes === "object") {
    for (const [k, v] of Object.entries(body.notes).slice(0, 2000)) {
      if (SLUG.test(k) && typeof v === "string" && v.trim()) out.notes[k] = v.slice(0, 4000);
    }
  }
  if (Array.isArray(body.cooked)) {
    for (const c of body.cooked.slice(-3000)) {
      if (c && SLUG.test(c.s) && typeof c.d === "string" && !Number.isNaN(Date.parse(c.d))) out.cooked.push({ s: c.s, d: new Date(c.d).toISOString() });
    }
  }
  return out;
}

async function readPerson(p: Person): Promise<PersonState> {
  const v = (await store().get(`person/${p}`, { type: "json" })) as PersonState | null;
  return v ? { ...empty(), ...v } : empty();
}

export default async (req: Request) => {
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const method = req.method;

  if (path === "login" && method === "POST") {
    const body = await req.json().catch(() => null);
    const who = body?.who;
    const pass = typeof body?.passcode === "string" ? body.passcode.trim() : "";
    const expected = Netlify.env.get("KITCHEN_PASSCODE") || "";
    if (!PEOPLE.includes(who) || !expected || !sameText(pass.toLowerCase(), expected.toLowerCase())) {
      return json({ error: "That passcode isn't right. Check it and try again." }, 401);
    }
    return json({ ok: true, me: who }, 200, { "set-cookie": sessionCookie(who) });
  }

  if (path === "logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie });

  const me = whoFrom(req);
  if (!me) return json({ error: "Sign in to carry on." }, 401);

  if (path === "switch" && method === "POST") {
    const next: Person = me === "will" ? "ella" : "will";
    return json({ ok: true, me: next }, 200, { "set-cookie": sessionCookie(next) });
  }

  if (path === "recipes" && method === "GET") {
    return new Response(JSON.stringify(RECIPES), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=3600" },
    });
  }

  if (path === "state" && method === "GET") {
    const [will, ella] = await Promise.all([readPerson("will"), readPerson("ella")]);
    return json({ me, people: { will, ella } });
  }

  if (path === "state" && method === "PUT") {
    const raw = await req.text();
    if (raw.length > 900_000) return json({ error: "That's too much to save in one go." }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return json({ error: "Couldn't read that save." }, 400); }
    const state = clean(body);
    if (!state) return json({ error: "Couldn't read that save." }, 400);
    state.updated = new Date().toISOString();
    await store().setJSON(`person/${me}`, state);
    return json({ ok: true, updated: state.updated });
  }

  return json({ error: "Not found" }, 404);
};

export const config: Config = {
  path: "/api/*",
  rateLimit: { windowLimit: 240, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
