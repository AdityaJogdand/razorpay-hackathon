"""WebSocket hub for live dashboard updates."""

import asyncio
import json
import logging
from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

_clients: set[WebSocket] = set()


async def dashboard_ws(ws: WebSocket):
    """WebSocket endpoint — clients connect and receive 'refresh' pings."""
    await ws.accept()
    _clients.add(ws)
    logger.info(f"Dashboard WS client connected ({len(_clients)} total)")
    try:
        while True:
            # Keep alive — just wait for disconnect
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(ws)
        logger.info(f"Dashboard WS client disconnected ({len(_clients)} total)")


async def notify_dashboard_update(event_type: str = "refresh"):
    """Broadcast a refresh signal to all connected dashboard clients."""
    if not _clients:
        return
    message = json.dumps({"type": event_type})
    dead = set()
    for ws in _clients:
        try:
            await ws.send_text(message)
        except Exception:
            dead.add(ws)
    _clients.difference_update(dead)
