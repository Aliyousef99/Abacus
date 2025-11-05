import os, sys
from pathlib import Path

# Make .../backend importable
ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.append(str(BACKEND))

# Point Django to your settings module
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "abacus_project.settings")

from django.core.wsgi import get_wsgi_application
import django
django.setup()

# Vercel looks for "app"
app = get_wsgi_application()
