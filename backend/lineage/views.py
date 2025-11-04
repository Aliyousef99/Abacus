from django.conf import settings
from django.utils import timezone
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.exceptions import PermissionDenied

from .models import Agent
from django.db import models
from .serializers import AgentSerializer
from scales.models import Connection
from api.permissions import get_user_role
from audit.utils import log_action
from audit.models import AuditLog
from codex.models import Echo

class AgentViewSet(viewsets.ModelViewSet):
    """
    API endpoint that allows Lineage agents to be viewed or edited, with role-based permissions.
    """
    serializer_class = AgentSerializer
    permission_classes = [IsAuthenticated] # Base permission, more granular checks in methods

    def get_queryset(self):
        """Protector can see all agents, others see non-archived agents; order by custom index then alias."""
        role = get_user_role(self.request.user)
        base_qs = Agent.all_objects.select_related('index_profile') if role == 'PROTECTOR' else Agent.objects.select_related('index_profile')
        # Order by order_index (nulls last), then alias
        return base_qs.order_by(models.F('order_index').asc(nulls_last=True), 'alias')

    def perform_create(self, serializer):
        # The serializer now handles the index_profile_id field for writing
        agent = serializer.save() 
        log_action(self.request.user, f"Created agent '{agent.alias}'", target=agent)

    def perform_update(self, serializer):
        instance = serializer.instance
        # Check if any of the secure comms fields have changed
        comms_fields = ['secure_comms_channel', 'secure_comms_contact_id', 'duress_code']
        has_comms_changed = any(
            serializer.validated_data.get(field) != getattr(instance, field)
            for field in comms_fields
            if field in serializer.validated_data
        )

        if has_comms_changed:
            serializer.validated_data['last_contacted_at'] = timezone.now()

        agent = serializer.save()
        log_action(self.request.user, f"Updated agent '{agent.alias}'", target=agent)    

    def create(self, request, *args, **kwargs):
        """Override create to provide clearer 4xx errors instead of 500s and normalize payload."""
        data = request.data.copy()
        # Normalize alias: allow null to avoid unique '' collisions
        if data.get('alias') in ('', None):
            data['alias'] = None
        serializer = self.get_serializer(data=data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            self.perform_create(serializer)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    @action(detail=False, methods=['post'], url_path='reorder')
    def reorder(self, request):
        """HQ-only: set a new ordering of agents via list of IDs."""
        role = get_user_role(request.user)
        if role != 'HQ':
            return Response({'error': 'Only HQ may reorder the lineage.'}, status=status.HTTP_403_FORBIDDEN)
        order = request.data.get('order') or []
        if not isinstance(order, list) or not all(isinstance(i, int) for i in order):
            return Response({'error': 'order must be a list of integers'}, status=status.HTTP_400_BAD_REQUEST)
        # Assign incremental indices starting at 1
        idx = 1
        for agent_id in order:
            Agent.all_objects.filter(id=agent_id).update(order_index=idx)
            idx += 1
        return Response({'status': 'ok'})

    def perform_destroy(self, instance):
        role = get_user_role(self.request.user)
        agent_alias = instance.alias

        if role == 'PROTECTOR':
            log_action(self.request.user, f"Permanently deleted agent '{agent_alias}'", target=instance)
            instance.delete() # Hard delete
        elif role == 'HEIR':
            instance.deleted_at = timezone.now()
            instance.save()
            log_action(self.request.user, f"Archived agent '{agent_alias}'", target=instance)
        else: # Overlooker and any other role
            log_action(self.request.user, f"Denied attempt to delete agent '{agent_alias}'", target=instance)
            raise PermissionDenied("You do not have permission to delete agents.")

    @action(detail=True, methods=['post'], url_path='reveal')
    def reveal(self, request, pk=None):
        """
        Custom action to reveal an agent's real name.
        Protector: No secondary auth needed.
        Heir: Requires secondary auth.
        Overlooker: No access.
        """
        agent = self.get_object()
        role = get_user_role(request.user)

        if role == 'OVERLOOKER':
            log_action(request.user, f"Denied attempt to reveal name for agent '{agent.alias}'", target=agent)
            raise PermissionDenied("You do not have permission to reveal this information.")

        if role == 'PROTECTOR':
            log_action(request.user, f"Revealed name for agent '{agent.alias}'", target=agent)
            return Response({'real_name': agent.real_name})

        if role == 'HEIR':
            secondary_auth = request.data.get('secondary_auth')
            if secondary_auth == settings.SECONDARY_PASSPHRASE:
                log_action(request.user, f"Revealed name for agent '{agent.alias}'", target=agent)
                return Response({'real_name': agent.real_name})
            else:
                log_action(request.user, f"Failed reveal attempt for agent '{agent.alias}'", target=agent)
                return Response({'detail': 'Authentication failed. Attempt logged.'}, status=status.HTTP_403_FORBIDDEN)
        
        return Response({'detail': 'Invalid role.'}, status=status.HTTP_403_FORBIDDEN)

    @action(detail=True, methods=['get'], url_path='connections')
    def connections(self, request, pk=None):
        """List external (Scales) connections for this Lineage agent."""
        agent = self.get_object()
        qs = Connection.objects.filter(lineage_agent=agent).select_related('scales_agent')
        data = [
            {
                'connection_id': c.id,
                'scales_agent_id': c.scales_agent.id,
                'scales_agent_alias': c.scales_agent.alias,
                'relationship': c.relationship,
                'created_at': c.created_at,
            }
            for c in qs
        ]
        return Response(data)

    @action(detail=True, methods=['get'], url_path='timeline')
    def timeline(self, request, pk=None):
        """Aggregate agent timeline: audit logs and silo mentions."""
        agent = self.get_object()
        items = []
        # Audit logs linked to this agent
        for log in AuditLog.objects.filter(content_type__model='agent', object_id=agent.id).order_by('-timestamp')[:200]:
            items.append({ 'timestamp': log.timestamp, 'source': 'AUDIT', 'type': 'ACTION', 'text': log.action })
        # Silo: echoes that assigned this agent
        for e in Echo.objects.filter(assigned_agents__id=agent.id).order_by('-created_at')[:200]:
            items.append({ 'timestamp': e.created_at, 'source': 'SILO', 'type': 'REPORT', 'text': f"Assigned to report: {e.title}" })
        items.sort(key=lambda x: x['timestamp'], reverse=True)
        return Response(items)
