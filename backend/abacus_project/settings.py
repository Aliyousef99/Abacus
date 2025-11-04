# abacus_project/settings.py

from pathlib import Path
from datetime import timedelta
import os
import dj_database_url
from decouple import config
from corsheaders.defaults import default_headers

# -----------------------------------------------------------------------------
# Paths
# -----------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent  # .../backend/abacus_project

# -----------------------------------------------------------------------------
# Security / Environment
# -----------------------------------------------------------------------------
SECRET_KEY = config("SECRET_KEY")  # set in Vercel env
DEBUG = config("DEBUG", default=False, cast=bool)

# Allow overriding via env, else use sane defaults for Vercel
ALLOWED_HOSTS = config(
    "DJANGO_ALLOWED_HOSTS",
    default="abacus-ebon.vercel.app,.vercel.app,localhost,127.0.0.1",
).split(",")

# CSRF: Django requires exact origins (no wildcards)
# Add preview URLs explicitly as needed.
CSRF_TRUSTED_ORIGINS = [
    "https://abacus-ebon.vercel.app",
]

# Optional secondary passphrase used by your app's features
SECONDARY_PASSPHRASE = config(
    "SECONDARY_PASSPHRASE",
    default="the rooster crows at dawn",
)

# -----------------------------------------------------------------------------
# Applications
# -----------------------------------------------------------------------------
INSTALLED_APPS = [
    # Django
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "whitenoise.runserver_nostatic",
    "django.contrib.postgres",

    # 3rd-party
    "rest_framework",
    "rest_framework_simplejwt",
    "corsheaders",

    # Local apps
    "users",
    "lineage",
    "scales",
    "codex",
    "loom",
    "api",  # shared components
    "audit",
    "administration",
    "index",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",

    "django.contrib.sessions.middleware.SessionMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",

    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "abacus_project.shutdown_middleware.ShutdownMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "abacus_project.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "abacus_project.wsgi.application"

# -----------------------------------------------------------------------------
# Database
#   - Falls back to SQLite locally if DATABASE_URL isn't set
#   - Uses pooled (pgBouncer) URL on Vercel with sslmode=require
#   - conn_max_age=0 on Vercel to avoid lingering serverless connections
# -----------------------------------------------------------------------------
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

database_url = config("DATABASE_URL", default=None)
if database_url:
    conn_age = 0 if os.environ.get("VERCEL") else 600
    DATABASES["default"] = dj_database_url.config(
        default=database_url,
        conn_max_age=conn_age,
        ssl_require=True,
    )

# -----------------------------------------------------------------------------
# Passwords
# -----------------------------------------------------------------------------
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.BCryptSHA256PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher",
    "django.contrib.auth.hashers.Argon2PasswordHasher",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# -----------------------------------------------------------------------------
# I18N / TZ
# -----------------------------------------------------------------------------
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# -----------------------------------------------------------------------------
# Static files (WhiteNoise)
#   - collectstatic will place files under ../staticfiles at deploy
#   - all traffic routed through Django; WhiteNoise serves /static/*
# -----------------------------------------------------------------------------
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR.parent / "staticfiles"
STATICFILES_DIRS = []

STORAGES = {
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# -----------------------------------------------------------------------------
# DRF / JWT
# -----------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
        # enable browsable API auth in dev if needed
        "rest_framework.authentication.SessionAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": (
        "rest_framework.permissions.IsAuthenticated",
    ),
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=1),
    "AUTH_HEADER_TYPES": ("Bearer",),
    "ROTATE_REFRESH_TOKENS": False,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": SECRET_KEY,
}

# -----------------------------------------------------------------------------
# CORS
#   - Explicit origins + regex for any *.vercel.app preview
# -----------------------------------------------------------------------------
CORS_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://abacus-ebon.vercel.app",
]

CORS_ALLOWED_ORIGIN_REGEXES = [
    r"^https://.*\.vercel\.app$",
]

CORS_ALLOW_HEADERS = list(default_headers) + [
    "x-secondary-auth",
]
