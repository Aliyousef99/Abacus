from django.contrib import admin
from django.urls import path, include
from django.views.generic import TemplateView
from django.views.generic import TemplateView

# Custom JWT View
from users.views import MyTokenObtainPairView

from rest_framework_simplejwt.views import (
    TokenRefreshView,
)

urlpatterns = [
    path('', TemplateView.as_view(template_name='index.html'), name='frontend-index'),
    path('admin/', admin.site.urls),

    # --- API URL Patterns ---

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
