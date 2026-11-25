"""Onofficiële Albert Heijn MCP server op basis van python-appie.

Not affiliated with Albert Heijn. For personal use only.

Tools: producten zoeken, bonus checken, AH-boodschappenlijst lezen/vullen/legen,
kassabonnen bekijken. Eerst eenmalig inloggen met `appie-login`.
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx
from appie.lists import ListsAPI
from pydantic import BaseModel, Field

try:  # mcp 2.x
    from mcp.server.mcpserver import MCPServer as _Server
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server

mcp = _Server("unofficial-ah-mcp")

# Rate limiting: minimaal MIN_INTERVAL seconden tussen calls naar AH.
MIN_INTERVAL = float(os.environ.get("AH_MCP_MIN_INTERVAL", "0.5"))
_rl_lock = asyncio.Lock()
_rl_last = 0.0


async def _throttle() -> None:
    global _rl_last
    async with _rl_lock:
        wait = _rl_last + MIN_INTERVAL - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        _rl_last = time.monotonic()


# --- Fix voor python-appie 0.2.2: AH vereist "strikeThrough" in lijst-items -------------
_orig_add_payload = ListsAPI._add_payload
_orig_remove_payload = ListsAPI._remove_payload_from_item_id


def _add_payload(description: str, quantity: int, product_id: int | None) -> dict[str, Any]:
    payload = _orig_add_payload(description, quantity, product_id)
    payload["strikeThrough"] = False
    return payload


def _remove_payload(item_id: str) -> dict[str, Any]:
    payload = _orig_remove_payload(item_id)
    payload["strikeThrough"] = False
    return payload


ListsAPI._add_payload = staticmethod(_add_payload)
ListsAPI._remove_payload_from_item_id = staticmethod(_remove_payload)
# -----------------------------------------------------------------------------------------


@asynccontextmanager
async def ah() -> AsyncIterator:
    """Nieuwe client per call, zodat ververste tokens altijd van schijf komen."""
    if os.environ.get("AH_MCP_MOCK") == "1":
        from appie import MockAHClient as Client
    else:
        from appie import AHClient as Client
    await _throttle()
    async with Client() as client:
        yield client


def _err(exc: Exception) -> str:
    """Foutmelding inclusief AH's antwoord, zodat je ziet wat er misging."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"{exc.response.status_code}: {exc.response.text[:300]}"
    return str(exc)


def _fmt_product(p) -> dict:
    return {
        "product_id": p.id,
        "titel": p.title,
        "merk": p.brand,
        "inhoud": p.unit_size,
        "prijs": p.price,
        "oude_prijs": p.original_price,
        "bonus": p.is_bonus,
        "bonus_label": p.bonus_label,
        "bonus_tot": p.bonus_end_date.isoformat() if p.bonus_end_date else None,
        "biologisch": p.is_organic,
    }


def _fmt_item(i) -> dict:
    return {
        "item_id": i.id,
        "omschrijving": i.description,
        "aantal": i.quantity,
        "product_id": i.product_id,
    }


@mcp.tool()
async def search_products(query: str, limit: int = 8, only_bonus: bool = False) -> list[dict]:
    """Zoek AH-producten op naam (bijv. 'halfvolle melk'). Geeft product_id, prijs en bonusinfo.
    Gebruik de product_id om een specifiek product op de lijst te zetten."""
    async with ah() as client:
        products = await client.products.search(query, limit=limit)
    result = [_fmt_product(p) for p in products]
    if only_bonus:
        result = [p for p in result if p["bonus"]]
    return result[:limit]


@mcp.tool()
async def get_product(product_id: int) -> dict:
    """Haal details van één product op via product_id."""
    async with ah() as client:
        return _fmt_product(await client.products.get(product_id))


@mcp.tool()
async def get_shopping_list() -> list[dict]:
    """Toon de huidige AH-boodschappenlijst (standaardlijst in de Appie-app)."""
    async with ah() as client:
        return [_fmt_item(i) for i in await client.lists.get_list()]


class ListItem(BaseModel):
    omschrijving: str = Field(description="Productnaam of vrije omschrijving, bijv. 'bananen'")
    aantal: int = Field(default=1, ge=1)
    product_id: int | None = Field(
        default=None,
        description="Specifiek AH-product (uit search_products). Leeg = vrije tekst op de lijst.",
    )


@mcp.tool()
async def add_to_shopping_list(items: list[ListItem]) -> dict:
    """Zet één of meer items op de AH-boodschappenlijst. Zoek bij voorkeur eerst het juiste
    product met search_products en geef de product_id mee."""
    added, failed = [], []
    async with ah() as client:
        for it in items:
            try:
                await _throttle()
                res = await client.lists.add_item(it.omschrijving, it.aantal, it.product_id)
                added.append(_fmt_item(res))
            except Exception as exc:  # noqa: BLE001 - per item rapporteren
                failed.append({"omschrijving": it.omschrijving, "fout": _err(exc)})
    return {"toegevoegd": added, "mislukt": failed}


@mcp.tool()
async def remove_from_shopping_list(item_id: str) -> str:
    """Verwijder één item van de lijst (item_id uit get_shopping_list)."""
    async with ah() as client:
        try:
            await client.lists.remove_item(item_id)
        except Exception as exc:  # noqa: BLE001
            return f"Mislukt: {_err(exc)}"
    return f"Verwijderd: {item_id}"


@mcp.tool()
async def clear_shopping_list(confirm: bool = False) -> str:
    """Maak de hele boodschappenlijst leeg. Alleen met confirm=true, na bevestiging van de gebruiker."""
    if not confirm:
        return "Niet uitgevoerd: vraag eerst bevestiging en roep opnieuw aan met confirm=true."
    async with ah() as client:
        try:
            await client.lists.clear()
        except Exception as exc:  # noqa: BLE001
            return f"Mislukt: {_err(exc)}"
    return "Boodschappenlijst geleegd."


@mcp.tool()
async def list_receipts(limit: int = 10) -> list[dict]:
    """Recente kassabonnen uit de winkel (zonder regels). Handig om vaste boodschappen te vinden."""
    async with ah() as client:
        receipts = await client.receipts.list_all(limit=limit)
    return [
        {"receipt_id": r.id, "datum": r.datetime.isoformat(), "winkel": r.store_name, "totaal": r.total}
        for r in receipts
    ]


@mcp.tool()
async def get_receipt(receipt_id: str) -> dict:
    """Kassabon met alle regels (receipt_id uit list_receipts)."""
    async with ah() as client:
        r = await client.receipts.get_pos_receipt(receipt_id)
    return {
        "datum": r.datetime.isoformat(),
        "winkel": r.store_name,
        "totaal": r.total,
        "regels": [
            {"product_id": p.id, "naam": p.name, "aantal": p.quantity, "totaal": p.total_price}
            for p in r.products
        ],
    }


if __name__ == "__main__":
    mcp.run()
