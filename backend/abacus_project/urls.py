from django.contrib import admin
from django.urls import path, include
from django.views.generic import TemplateView
from django.http import JsonResponse

# Custom JWT View
from users.views import MyTokenObtainPairView
from rest_framework_simplejwt.views import TokenRefreshView

def api_root(_request):
    return JsonResponse({
        "lineage": "/api/lineage/",
        "scales": "/api/scales/",
        "codex": "/api/codex/",
        "loom": "/api/loom/",
        "index": "/api/index/",
        "audit": "/api/audit/",
        "users": "/api/users/",
    })

urlpatterns = [
    # ✅ point to the template that actually exists in the index app
    path('', TemplateView.as_view(template_name='index/index.html'), name='home'),

    path('admin/', admin.site.urls),

    # --- API URL Patterns ---
    path('api/', api_root, name='api-root'),

    # JWT Authentication endpoints
    path('api/auth/token/', MyTokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('api/auth/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),

    # App-specific API endpoints
    path('api/lineage/', include('lineage.urls')),
    path('api/scales/', include('scales.urls')),
    path('api/codex/', include('codex.urls')),
    path('api/loom/', include('loom.urls')),
    path('api/index/', include('index.urls')),
    path('api/audit/', include('audit.urls')),
    path('api/users/', include('users.urls')),
    path('administration/', include('administration.urls')),
]
