**Project Layout**
- `backend/` — Django project and apps (templates, static, APIs)
- `frontend/` — Frontend workspace (e.g., Vite/React). Optional build output later.

**Git Scope**
- Repo root tracks only `backend/` and `frontend/` (see `.gitignore`).
- Legacy files from older layouts moved to `backend/_root_legacy/` for reference.

**Core Sections Of The Abacus**
- Authentication & Roles — secure login; roles: Protector, Heir, Observer
- The Index — universal people database (single source of truth)
- The Lineage — Talon agents’ classified dossiers and status
- The Scales — external factions, threat levels, and linked members
- The Silo — one‑way intelligence reports from Observer
- The Loom — operations planning, execution, and review
- The Pulse — real‑time strategic dashboard
- The Codex — knowledge base, history, doctrine, SOPs
- The Heir's Log — private journal for analysis and review
- The Vault — secure ledger of assets (financials, properties, etc.)

**Run Backend**
- `cd backend`
- Activate venv (create if needed)
- `python manage.py runserver`

**Frontend**
- Add your framework under `frontend/`.
- Later, configure Django to serve build output via `STATICFILES_DIRS` or proxy via a dev server.

