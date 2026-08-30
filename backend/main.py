from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from backend.core.config import settings
from backend.core.database import engine
from backend.ingest.router import router as ingest_router
from backend.ledger.router import router as ledger_router
from backend.config.router import router as config_router
from backend.agent.router import router as agent_router
from backend.execution.router import router as execution_router
from backend.dashboard.router import router as dashboard_router
from backend.dashboard.ws import dashboard_ws
from backend.ope.router import router as ope_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()


app = FastAPI(
    title="Payment Recovery Agent",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest_router)
app.include_router(ledger_router)
app.include_router(config_router)
app.include_router(agent_router)
app.include_router(execution_router)
app.include_router(dashboard_router)
app.include_router(ope_router)


@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    await dashboard_ws(ws)


@app.get("/health")
async def health():
    return {"status": "ok", "kill_switch": settings.kill_switch, "version": "0.2.0"}
