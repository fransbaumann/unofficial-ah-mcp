// unofficial-ah-mcp — onofficiële Albert Heijn MCP server, cloudversie als Supabase Edge Function.
// Not affiliated with Albert Heijn. For personal use only.
// Port van ../../../../server.py (python-appie 0.2.2). Tabellen: zie ../../migrations.
// URL: https://<project>.supabase.co/functions/v1/ah-mcp/<mcp_key>  (mcp_key in tabel ah_mcp_config)
// Keep-alive (token verversen): POST .../ah-mcp/<mcp_key>/keepalive

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const BASE_URL = "https://api.ah.nl";
const CLIENT_ID = "appie-ios";
const CLIENT_VERSION = "9.28";
const USER_AGENT = "Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)";
const LIST_PATH = "/mobile-services/shoppinglist/v2/items";
const REFRESH_SKEW_MS = 60_000;
// Rate limiting: minimaal zoveel ms tussen calls naar AH (per instance).
const MIN_INTERVAL_MS = Number(Deno.env.get("AH_MCP_MIN_INTERVAL_MS") ?? "500");
let lastCall = 0;
async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const baseHeaders = {
  "User-Agent": USER_AGENT,
  "x-client-name": CLIENT_ID,
  "x-client-version": CLIENT_VERSION,
  "x-application": "AHWEBSHOP",
  "Accept": "application/json",
  "Content-Type": "application/json",
};

let MCP_KEY: string | null = null;
async function mcpKey(): Promise<string> {
  if (MCP_KEY) return MCP_KEY;
  const { data } = await db.from("ah_mcp_config").select("mcp_key").eq("id", 1).maybeSingle();
  MCP_KEY = data?.mcp_key ?? "";
  return MCP_KEY!;
}

// ---------------------------------------------------------------- auth
type Tok = { access_token: string; refresh_token: string; expires_at: string };

async function loadToken(): Promise<Tok> {
  const { data, error } = await db.from("ah_auth_state")
    .select("access_token, refresh_token, expires_at").eq("id", 1).maybeSingle();
  if (error) throw new Error(`Token lezen mislukt: ${error.message}`);
  if (!data) throw new Error("Geen AH-tokens opgeslagen. Importeer eerst tokens.json.");
  return data as Tok;
}

async function refresh(refreshToken: string): Promise<Tok> {
  const r = await fetch(`${BASE_URL}/mobile-auth/v1/auth/token/refresh`, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ clientId: CLIENT_ID, refreshToken }),
  });
  if (!r.ok) {
    throw new Error(`Token verversen mislukt (${r.status}): ${(await r.text()).slice(0, 300)}. ` +
      "Opnieuw inloggen met appie-login en tokens.json opnieuw importeren.");
  }
  const t = await r.json();
  const tok: Tok = {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? refreshToken,
    expires_at: new Date(Date.now() + Number(t.expires_in) * 1000).toISOString(),
  };
  const { error } = await db.from("ah_auth_state").upsert({ id: 1, ...tok, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Token opslaan mislukt: ${error.message}`);
  return tok;
}

async function validToken(force = false): Promise<string> {
  const tok = await loadToken();
  if (force || new Date(tok.expires_at).getTime() - REFRESH_SKEW_MS <= Date.now()) {
    return (await refresh(tok.refresh_token)).access_token;
  }
  return tok.access_token;
}

async function ah(method: string, path: string, opts: { params?: Record<string, string | number>; json?: unknown } = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, String(v));
  const doFetch = async (token: string) => {
    await throttle();
    return await fetch(url, {
      method,
      headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    });
  };
  let r = await doFetch(await validToken());
  if (r.status === 401) r = await doFetch(await validToken(true)); // token toch verlopen
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

async function graphql(query: string, variables: Record<string, unknown>) {
  const p = await ah("POST", "/graphql", { json: { query, variables } });
  if (p.errors) throw new Error(`GraphQL fout: ${JSON.stringify(p.errors).slice(0, 300)}`);
  return p.data;
}

// ---------------------------------------------------------------- mapping (zoals python-appie)
// deno-lint-ignore no-explicit-any
type J = any;
const amount = (v: J) => (v && typeof v === "object" ? v.amount : v);

function fmtProduct(p: J) {
  const priceRaw = amount(p.currentPrice ?? p.priceBeforeBonus ?? p.price);
  const price = priceRaw != null ? Number(priceRaw) : null;
  const origRaw = amount(p.priceBeforeBonus);
  const orig = origRaw != null && price != null && Number(origRaw) > price ? Number(origRaw) : null;
  let bonus: boolean | null = null;
  if (p.isBonus != null) bonus = !!p.isBonus;
  else if (p.isBonusPrice != null) bonus = !!p.isBonusPrice;
  else if (p.bonusMechanism || p.bonusStartDate) bonus = true;
  let label: string | null = typeof p.bonusMechanism === "string" && p.bonusMechanism.trim() ? p.bonusMechanism : null;
  if (!label && Array.isArray(p.extraDescriptions)) {
    label = p.extraDescriptions.find((d: J) => typeof d === "string" && d.toLowerCase().includes("korting")) ?? null;
  }
  return {
    product_id: Number(p.id ?? p.webshopId),
    titel: p.title ?? p.description,
    merk: p.brand ?? null,
    inhoud: p.unitSize ?? p.salesUnitSize ?? p.unitPriceDescription ?? null,
    prijs: price,
    oude_prijs: orig,
    bonus,
    bonus_label: label,
    bonus_tot: p.bonusEndDate ?? null,
    biologisch: p.isOrganic != null ? !!p.isOrganic : null,
  };
}

function fmtItem(i: J) {
  const prod = i?.productDetails?.product ?? {};
  const pid = prod.webshopId ?? null;
  const desc = i.description || prod.title || i?.vagueTermDetails?.searchTermValue || `Item ${i.listItemId ?? "unknown"}`;
  const id = pid != null ? `prd:${Number(pid)}:${encodeURIComponent(desc)}` : `txt:${encodeURIComponent(desc)}`;
  return { item_id: id, omschrijving: desc, aantal: Number(i.quantity ?? 1), product_id: pid != null ? Number(pid) : null };
}

function addPayload(desc: string, qty: number, pid: number | null) {
  return pid != null
    ? { productId: pid, quantity: qty, type: "SHOPPABLE", originCode: "PRD", description: desc, searchTerm: desc, strikeThrough: false }
    : { description: desc, quantity: qty, type: "SHOPPABLE", originCode: "TXT", strikeThrough: false };
}

function removePayload(itemId: string) {
  if (itemId.startsWith("prd:")) {
    const [, pid, ...rest] = itemId.split(":");
    const d = decodeURIComponent(rest.join(":"));
    return { productId: Number(pid), quantity: 0, type: "SHOPPABLE", originCode: "PRD", description: d, searchTerm: d, strikeThrough: false };
  }
  if (itemId.startsWith("txt:")) {
    return { description: decodeURIComponent(itemId.slice(4)), quantity: 0, type: "SHOPPABLE", originCode: "TXT", strikeThrough: false };
  }
  throw new Error(`Onbekend item_id-formaat: ${itemId}`);
}

const getList = async () => ((await ah("GET", LIST_PATH)).items ?? []).map(fmtItem);

// ---------------------------------------------------------------- tools
const RECEIPTS_Q = `query FetchPosReceipts($offset: Int!, $limit: Int!) {
  posReceiptsPage(pagination: {offset: $offset, limit: $limit}) { posReceipts { id dateTime totalAmount { amount } } } }`;
const RECEIPT_Q = `query FetchReceipt($id: String!) {
  posReceiptDetails(id: $id) { id products { id quantity name price { amount } amount { amount } } } }`;

const tools: Record<string, { description: string; inputSchema: J; run: (a: J) => Promise<unknown> }> = {
  search_products: {
    description: "Zoek AH-producten op naam (bijv. 'halfvolle melk'). Geeft product_id, prijs en bonusinfo. Gebruik de product_id om een specifiek product op de lijst te zetten.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 8 },
        only_bonus: { type: "boolean", default: false },
      },
      required: ["query"],
    },
    run: async ({ query, limit = 8, only_bonus = false }) => {
      const p = await ah("GET", "/mobile-services/product/search/v2", { params: { query, sortOn: "RELEVANCE", size: limit, page: 0 } });
      let res = ((p.products ?? p.data ?? []) as J[]).map(fmtProduct);
      if (only_bonus) res = res.filter((x) => x.bonus);
      return res.slice(0, limit);
    },
  },
  get_product: {
    description: "Haal details van één product op via product_id.",
    inputSchema: { type: "object", properties: { product_id: { type: "integer" } }, required: ["product_id"] },
    run: async ({ product_id }) => {
      const p = await ah("GET", `/mobile-services/product/detail/v4/fir/${product_id}`);
      if (!p.productCard) throw new Error(`Product ${product_id} niet gevonden.`);
      return fmtProduct(p.productCard);
    },
  },
  get_shopping_list: {
    description: "Toon de huidige AH-boodschappenlijst (standaardlijst in de Appie-app).",
    inputSchema: { type: "object", properties: {} },
    run: async () => await getList(),
  },
  add_to_shopping_list: {
    description: "Zet één of meer items op de AH-boodschappenlijst. Zoek bij voorkeur eerst het juiste product met search_products en geef de product_id mee.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              omschrijving: { type: "string", description: "Productnaam of vrije omschrijving, bijv. 'bananen'" },
              aantal: { type: "integer", minimum: 1, default: 1 },
              product_id: { type: ["integer", "null"], description: "Specifiek AH-product (uit search_products). Leeg = vrije tekst op de lijst." },
            },
            required: ["omschrijving"],
          },
        },
      },
      required: ["items"],
    },
    run: async ({ items }) => {
      const toegevoegd: unknown[] = [], mislukt: unknown[] = [];
      for (const it of items ?? []) {
        try {
          const pid = it.product_id != null ? Number(it.product_id) : null;
          const r = await ah("PATCH", LIST_PATH, { json: { items: [addPayload(it.omschrijving, Number(it.aantal ?? 1), pid)] } });
          const first = (r.items ?? [])[0];
          toegevoegd.push(first ? fmtItem(first) : { omschrijving: it.omschrijving });
        } catch (e) {
          mislukt.push({ omschrijving: it.omschrijving, fout: String((e as Error).message) });
        }
      }
      return { toegevoegd, mislukt };
    },
  },
  remove_from_shopping_list: {
    description: "Verwijder één item van de lijst (item_id uit get_shopping_list).",
    inputSchema: { type: "object", properties: { item_id: { type: "string" } }, required: ["item_id"] },
    run: async ({ item_id }) => {
      await ah("PATCH", LIST_PATH, { json: { items: [removePayload(item_id)] } });
      return `Verwijderd: ${item_id}`;
    },
  },
  clear_shopping_list: {
    description: "Maak de hele boodschappenlijst leeg. Alleen met confirm=true, na bevestiging van de gebruiker.",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean", default: false } } },
    run: async ({ confirm = false }) => {
      if (!confirm) return "Niet uitgevoerd: vraag eerst bevestiging en roep opnieuw aan met confirm=true.";
      for (const i of await getList()) await ah("PATCH", LIST_PATH, { json: { items: [removePayload(i.item_id)] } });
      return "Boodschappenlijst geleegd.";
    },
  },
  list_receipts: {
    description: "Recente kassabonnen uit de winkel (zonder regels). Handig om vaste boodschappen te vinden.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", default: 10 } } },
    run: async ({ limit = 10 }) => {
      const d = await graphql(RECEIPTS_Q, { offset: 0, limit });
      return ((d?.posReceiptsPage?.posReceipts ?? []) as J[])
        .map((r) => ({ receipt_id: String(r.id), datum: r.dateTime, winkel: null, totaal: Number(r.totalAmount.amount) }))
        .sort((a, b) => (a.datum < b.datum ? 1 : -1));
    },
  },
  get_receipt: {
    description: "Kassabon met alle regels (receipt_id uit list_receipts).",
    inputSchema: { type: "object", properties: { receipt_id: { type: "string" } }, required: ["receipt_id"] },
    run: async ({ receipt_id }) => {
      const d = await graphql(RECEIPT_Q, { id: receipt_id });
      const r = d.posReceiptDetails;
      const regels = ((r?.products ?? []) as J[]).map((p) => ({
        product_id: Number(p.id), naam: p.name, aantal: Number(p.quantity), totaal: Number(p.amount.amount),
      }));
      return { receipt_id, totaal: regels.reduce((s, x) => s + x.totaal, 0), regels };
    },
  },
};

// ---------------------------------------------------------------- MCP (Streamable HTTP, stateless)
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

async function handleRpc(msg: J): Promise<J | null> {
  const { id, method, params } = msg ?? {};
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined || id === null) return null; // notificatie
  switch (method) {
    case "initialize": {
      const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return ok({
        protocolVersion: v,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "unofficial-ah-mcp", version: "1.0.0" },
        instructions: "Onofficiële Albert Heijn-koppeling (not affiliated with Albert Heijn): producten zoeken, bonus checken en de AH-boodschappenlijst vullen.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const t = tools[params?.name];
      if (!t) return fail(-32602, `Onbekende tool: ${params?.name}`);
      try {
        const res = await t.run(params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: typeof res === "string" ? res : JSON.stringify(res, null, 2) }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Fout: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Methode niet ondersteund: ${method}`);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const i = parts.indexOf("ah-mcp");
  const key = parts[i + 1] ?? "";
  const sub = parts[i + 2] ?? "";
  const expected = await mcpKey();
  if (!expected || key !== expected) return new Response("Not found", { status: 404 });

  if (sub === "keepalive") {
    try {
      await validToken(true);
      return json({ ok: true, ververst: new Date().toISOString() });
    } catch (e) {
      return json({ ok: false, fout: (e as Error).message }, 500);
    }
  }

  if (req.method === "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: J;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handleRpc))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleRpc(body);
  return out ? json(out) : new Response(null, { status: 202 });
});
