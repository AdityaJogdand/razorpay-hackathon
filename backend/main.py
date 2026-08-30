from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from backend.core.database import engine
from backend.ingest.router import router as ingest_router
from backend.ledger.router import router as ledger_router
from backend.config.router import router as config_router
from backend.agent.router import router as agent_router
from backend.execution.router import router as execution_router
from backend.dashboard.router import router as dashboard_router
from backend.guardrail.router import router as guardrail_router
from backend.dashboard.ws import dashboard_ws
from backend.ope.router import router as ope_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Cache-Control"] = "no-store"
        return response


app = FastAPI(
    title="Payment Recovery Agent",
    version="0.3.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)

app.add_middleware(SecurityHeadersMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-API-Key", "X-Webhook-Signature"],
)

app.include_router(ingest_router)
app.include_router(ledger_router)
app.include_router(config_router)
app.include_router(agent_router)
app.include_router(execution_router)
app.include_router(dashboard_router)
app.include_router(guardrail_router)
app.include_router(ope_router)


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    await dashboard_ws(ws)


@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.3.0"}
