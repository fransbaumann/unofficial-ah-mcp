# unofficial-ah-mcp

> **Not affiliated with, endorsed by or connected to Albert Heijn B.V.** Unofficial, for personal use only.
> Uses the undocumented API of the Appie app, which can change or break at any time. Use at your own risk.

MCP server waarmee Claude (of een andere MCP-client) AH-producten kan zoeken, bonus kan checken en je AH-boodschappenlijst kan vullen.
Gebouwd op [python-appie](https://pypi.org/project/python-appie/).

## Tools
| Tool | Wat |
|---|---|
| `search_products` | Zoeken op naam, met prijs/bonus (optioneel alleen bonus) |
| `get_product` | Details via product_id |
| `get_shopping_list` | Huidige AH-lijst |
| `add_to_shopping_list` | Eén of meer items toevoegen (met of zonder product_id) |
| `remove_from_shopping_list` | Eén item verwijderen |
| `clear_shopping_list` | Lijst legen (alleen met `confirm=true`) |
| `list_receipts` / `get_receipt` | Kassabonnen uit de winkel |

Dit vult de **boodschappenlijst** in de Appie-app, niet het winkelmandje. Vanaf de lijst zet je alles met één tik in je mandje.

## Eerlijk gebruik
- Elke gebruiker logt in met **zijn eigen** AH-account. Deel nooit tokens.
- Er zit rate limiting in (standaard 0,5 s tussen calls; `AH_MCP_MIN_INTERVAL` / `AH_MCP_MIN_INTERVAL_MS`). Gebruik dit niet om te scrapen.

## Lokaal (Python)

```bash
git clone https://github.com/<jij>/unofficial-ah-mcp.git
cd unofficial-ah-mcp
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip
```

### Eenmalig inloggen
```bash
.venv/bin/appie-login                            # Windows: .venv\Scripts\appie-login
```
Opent een browser voor de AH-login. Lukt automatisch vangen niet, dan vraagt hij om de redirect-URL (`appie://login-exit?code=...`): kopieer die uit de adresbalk/devtools en plak hem.
Tokens komen in `~/.config/appie/tokens.json` en worden automatisch ververst. Dit bestand hoort nooit in git.

### Koppelen aan Claude Desktop
Voeg toe aan `claude_desktop_config.json` onder `mcpServers`:

```json
"albert-heijn": {
  "command": "/pad/naar/unofficial-ah-mcp/.venv/bin/python",
  "args": ["/pad/naar/unofficial-ah-mcp/server.py"]
}
```
Op Windows: `...\\.venv\\Scripts\\python.exe`. Herstart Claude Desktop daarna volledig.

### Testen zonder AH-account
```bash
AH_MCP_MOCK=1 .venv/bin/python server.py
```

## Cloud (Supabase Edge Function)
In `cloud/supabase/` staat een TypeScript-port die als Supabase Edge Function draait, zodat het zonder je eigen computer werkt (bijv. voor geplande taken).

1. Draai de migratie in `cloud/supabase/migrations/` (maakt `ah_auth_state` en `ah_mcp_config`, met RLS aan).
2. Zet een lange willekeurige sleutel in `ah_mcp_config.mcp_key` en importeer `access_token`, `refresh_token` en `expires_at` uit je lokale `tokens.json` in `ah_auth_state`.
3. Deploy: `supabase functions deploy ah-mcp --no-verify-jwt`.
4. MCP-URL: `https://<project>.supabase.co/functions/v1/ah-mcp/<mcp_key>`. Behandel deze URL als een wachtwoord.
5. Optioneel keep-alive (tokens verversen): `POST .../ah-mcp/<mcp_key>/keepalive`, bijvoorbeeld dagelijks via `pg_cron`.

## Problemen
- **401 / "No stored tokens"** → opnieuw `appie-login` (en voor de cloud: tokens opnieuw importeren).
- **Refresh token verlopen na lange inactiviteit** → zelfde oplossing, of gebruik de keep-alive.

## Licentie
MIT, zie [LICENSE](LICENSE). Zonder enige garantie.
