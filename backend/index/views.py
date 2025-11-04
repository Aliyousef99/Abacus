from django.db.models import Q
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.exceptions import PermissionDenied

from .models import IndexProfile, IndexConnection
from .serializers import IndexProfileSerializer, IndexConnectionSerializer
from api.permissions import get_user_role, IsHQProtectorOrHeir
from audit.utils import log_action

class IndexProfileViewSet(viewsets.ModelViewSet):
    """
    API endpoint for viewing and editing Index profiles.
    """
    serializer_class = IndexProfileSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = IndexProfile.objects.all().order_by('full_name')
        # Add filtering logic from your app.js
        q = self.request.query_params.get('q')
        if q:
            qs = qs.filter(Q(full_name__icontains=q) | Q(biography__icontains=q) | Q(aliases__icontains=q))
        classification = self.request.query_params.get('classification')
        if classification:
            qs = qs.filter(classification=classification)
        status_param = self.request.query_params.get('status')
        if status_param:
            qs = qs.filter(status=status_param)
        threat = self.request.query_params.get('threat_level')
        if threat:
            qs = qs.filter(threat_level=threat)
        return qs

    def get_permissions(self):
        if self.action in ['destroy']:
            self.permission_classes = [IsHQProtectorOrHeir]
        else:
            self.permission_classes = [IsAuthenticated]
        return super().get_permissions()

    @action(detail=True, methods=['get'], url_path='timeline')
    def timeline(self, request, pk=None):
        # Placeholder for audit log timeline
        return Response([])

class IndexConnectionViewSet(viewsets.ModelViewSet):
    """
    API endpoint for managing connections between IndexProfiles.
    This is a nested viewset, accessed via /api/index/profiles/{profile_pk}/connections/
    """
    serializer_class = IndexConnectionSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        """
        Filter connections to only show those originating from the profile specified in the URL.
        """
        profile_pk = self.kwargs.get('profile_pk')
        if not profile_pk:
            return IndexConnection.objects.none()
        # Show connections both to and from the profile for a complete view
        return IndexConnection.objects.filter(
            Q(from_profile_id=profile_pk) | Q(to_profile_id=profile_pk)
        ).select_related('from_profile', 'to_profile')

    def perform_create(self, serializer):
        """
        Automatically set the 'from_profile' based on the URL.
        """
        profile_pk = self.kwargs.get('profile_pk')
        from_profile = IndexProfile.objects.get(pk=profile_pk)
        serializer.save(from_profile=from_profile)
        log_action(self.request.user, f"Created connection from '{from_profile.full_name}'", target=from_profile)

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            self.permission_classes = [IsAuthenticated]
        else: # create, update, destroy
            self.permission_classes = [IsHQProtectorOrHeir]
        return super().get_permissions()