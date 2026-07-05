import os


TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
FREELLM_BASE_URL = os.getenv("FREELLM_BASE_URL", "http://localhost:3000/v1")
FREELLM_API_KEY = os.getenv("FREELLM_API_KEY", "unused")

AGENT_MODEL = os.getenv("AGENT_MODEL", "groq/llama-3.3-70b-versatile")
AGENT_CODE_MODEL = os.getenv("AGENT_CODE_MODEL", "groq/qwen-2.5-coder-32b")
AGENT_FALLBACK_MODEL = os.getenv("AGENT_FALLBACK_MODEL", "github/openai/gpt-4o-mini")
MAX_HISTORY = int(os.getenv("MAX_HISTORY", "50"))
MAX_TOOL_CALLS = int(os.getenv("MAX_TOOL_CALLS", "30"))

MULTI_AGENT_ENABLED = os.getenv("MULTI_AGENT_ENABLED", "true").lower() == "true"
RAG_ENABLED = os.getenv("RAG_ENABLED", "true").lower() == "true"
GUARDRAILS_ENABLED = os.getenv("GUARDRAILS_ENABLED", "true").lower() == "true"
SANDBOX_ENABLED = os.getenv("SANDBOX_ENABLED", "true").lower() == "true"

WORKSPACE_DIR = os.getenv("WORKSPACE_DIR", "/workspace")

ALLOWED_BASH_PREFIXES = os.getenv(
    "ALLOWED_BASH_PREFIXES",
    "ls,cat,head,tail,echo,pwd,which,whoami,id,uname,date,env,dir,npm,pnpm,yarn,python,python3,go,rustc,cargo,gcc,g++,make,cmake,git,curl,wget,node,jq,find,grep,rg,awk,sed,mkdir,cp,mv,rm,touch,chmod,stat,du,df,ps,top,htop,free,ping,nslookup,dig,ssh,scp,rsync,tar,gzip,zip,unzip,docker,docker-compose,kind,kubectl,helm,terraform,pulumi,ansible,brew,apt,dnf,yum,pip,cargo,npx,tsc,eslint,prettier,ruff,black,biome,javac,java",
).split(",")

CONFIRM_COMMANDS = os.getenv("CONFIRM_COMMANDS", "rm,dd,mkfs,format,>|,sudo,su,chown,chgrp,passwd,useradd,usermod,groupadd,poweroff,reboot,shutdown,init,kill,killall,pkill").split(",")

PORT = int(os.getenv("PORT", "8080"))

FILE_TTL_DAYS = int(os.getenv("FILE_TTL_DAYS", "3"))
CLEANUP_INTERVAL_HOURS = int(os.getenv("CLEANUP_INTERVAL_HOURS", "1"))

MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "20"))
MAX_CONCURRENT_TASKS = int(os.getenv("MAX_CONCURRENT_TASKS", "5"))
RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "3"))
AGENT_TIMEOUT_SECONDS = int(os.getenv("AGENT_TIMEOUT_SECONDS", "600"))
MAX_CONTEXT_SIZE_CHARS = int(os.getenv("MAX_CONTEXT_SIZE_CHARS", "200000"))
LLM_CALL_TIMEOUT = int(os.getenv("LLM_CALL_TIMEOUT", "30"))
MAX_HISTORY_LOAD_FILES = int(os.getenv("MAX_HISTORY_LOAD_FILES", "1000"))

GMAIL_ENABLED = os.getenv("GMAIL_ENABLED", "false").lower() == "true"
GMAIL_CREDENTIALS_FILE = os.getenv("GMAIL_CREDENTIALS_FILE", "")
GMAIL_TOKEN_FILE = os.getenv("GMAIL_TOKEN_FILE", "")
GMAIL_TOKEN_JSON = os.getenv("GMAIL_TOKEN_JSON", "")

FIREBASE_SERVICE_ACCOUNT_JSON = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")
FIREBASE_ENABLED = os.getenv("FIREBASE_ENABLED", "false").lower() == "true"
