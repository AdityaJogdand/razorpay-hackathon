from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://recovery:recovery_dev_pass@localhost:5434/recovery_agent"
    database_url_sync: str = "postgresql+psycopg2://recovery:recovery_dev_pass@localhost:5434/recovery_agent"
    webhook_secret: str = "whsec_test_secret_key_for_dev"
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    gmail_user: str = ""
    gmail_app_password: str = ""
    kill_switch: bool = False

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
