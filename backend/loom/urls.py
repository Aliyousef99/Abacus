from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import OperationViewSet, AssetViewSet, AssetRequisitionViewSet, OperationReportLinkViewSet

router = DefaultRouter()
router.register(r'operations', OperationViewSet)
router.register(r'assets', AssetViewSet, basename='asset')
router.register(r'requisitions', AssetRequisitionViewSet, basename='asset-requisition')
router.register(r'report-links', OperationReportLinkViewSet, basename='report-link')

urlpatterns = [
    path('', include(router.urls)),
]
