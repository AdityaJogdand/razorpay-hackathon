import secrets

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    database_url: str = Field(..., description="PostgreSQL async connection URL")
    database_url_sync: str = Field(..., description="PostgreSQL sync connection URL")
    webhook_secret: str = Field(..., description="HMAC secret for webhook signature verification")
    api_key: str = Field(
        default_factory=lambda: secrets.token_urlsafe(32),
        description="API key for authenticating dashboard/admin requests",
    )
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    gmail_user: str = ""
    gmail_app_password: str = ""
    kill_switch: bool = False

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
