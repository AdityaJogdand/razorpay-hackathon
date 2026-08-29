from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.core.config import settings
from backend.core.database import engine
from backend.ingest.router import router as ingest_router
from backend.ledger.router import router as ledger_router
from backend.config.router import router as config_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()


app = FastAPI(
    title="Payment Recovery Agent",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest_router)
app.include_router(ledger_router)
app.include_router(config_router)


@app.get("/health")
async def health():
    return {"status": "ok", "kill_switch": settings.kill_switch}
