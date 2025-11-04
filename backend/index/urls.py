from django.urls import path, include
from rest_framework_nested import routers
from .views import IndexProfileViewSet, IndexConnectionViewSet

router = routers.DefaultRouter()
router.register(r'profiles', IndexProfileViewSet, basename='indexprofile')

# Nested router for /api/index/profiles/{profile_pk}/connections/
profiles_router = routers.NestedSimpleRouter(router, r'profiles', lookup='profile')
profiles_router.register(r'connections', IndexConnectionViewSet, basename='profile-connections')

urlpatterns = [
    path('', include(router.urls)),
    path('', include(profiles_router.urls)),
]