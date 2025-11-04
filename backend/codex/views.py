from rest_framework import viewsets, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import CodexEntry, Echo, Task, PropertyDossier, Vehicle, Bulletin, BulletinAck, Notification, CodexCategoryConfig
from lineage.models import Agent as LineageAgent
from .serializers import CodexEntrySerializer, EchoSerializer, TaskSerializer, SiloCommentSerializer, PropertyDossierSerializer, VehicleSerializer, BulletinSerializer, NotificationSerializer
from api.permissions import IsProtector, IsProtectorOrHeir, get_user_role, IsTrueProtector, IsHQ
from audit.utils import log_action
from django.contrib.auth.models import User
from django.db.models import Q

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def codex_categories(request):
    """Return Codex categories for landing widgets.

    Uses entry_type as the category key. Image URLs are static placeholders; replace with real assets as desired.
    """
    base_categories = [
        {
            'name': 'Historic Events',
            'image_url': '/static/images/codex_events.jpg',
            'description': "Review major operations and outcomes.",
        },
        {
            'name': 'Doctrine & Philosophy',
            'image_url': '/static/images/codex_doctrine.jpg',
            'description': "Study the core tenets and philosophy.",
        },
        {
            'name': 'Biographies of the Lost',
            'image_url': '/static/images/codex_biographies.jpg',
            'description': "Honor agents who made the ultimate sacrifice.",
        },
        {
            'name': 'Standard Operating Procedures (SOPs)',
            'image_url': '/static/images/codex_sops.jpg',
            'description': "Reference standard operating procedures.",
        },
        {
            'name': 'Threat Analysis Reports',
            'image_url': '/static/images/codex_threats.jpg',
            'description': "Analyze hostile entities and vectors.",
        },
    ]
    # Apply overrides from DB config
    configs = {c.name: c for c in CodexCategoryConfig.objects.all()}
    out = []
    for item in base_categories:
        cfg = configs.get(item['name'])
        if cfg:
            out.append({
                'name': item['name'],
                'image_url': cfg.image_url or item['image_url'],
                'description': cfg.description or item['description'],
            })
        else:
            out.append(item)
    return Response(out)

@api_view(['POST'])
@permission_classes([IsHQ])
def codex_set_category_cover(request):
    """HQ-only: set/override category cover image and optional description."""
    name = request.data.get('name')
    image_url = request.data.get('image_url', '')
    description = request.data.get('description', '')
    if not name:
        return Response({'error': 'name is required'}, status=status.HTTP_400_BAD_REQUEST)
    cfg, _ = CodexCategoryConfig.objects.get_or_create(name=name)
    cfg.image_url = image_url
    if description:
        cfg.description = description
    cfg.save()
    return Response({'status': 'ok'})
class CodexEntryViewSet(viewsets.ModelViewSet):
    """
    API endpoint for Codex entries, with write access restricted to the Protector.
    """
    queryset = CodexEntry.objects.all().order_by('-created_at')
    serializer_class = CodexEntrySerializer

    def get_permissions(self):
        """Permissions: list/retrieve for any auth; create/update for Protector/HQ; delete for HQ only."""
        if self.action in ['list', 'retrieve']:
            self.permission_classes = [IsAuthenticated]
        elif self.action in ['create', 'update', 'partial_update']:
            self.permission_classes = [IsProtector]  # IsProtector includes HQ in our policy
        elif self.action in ['destroy']:
            self.permission_classes = [IsHQ]
        return super().get_permissions()

    def perform_create(self, serializer):
        entry = serializer.save()
        log_action(self.request.user, f"Created codex entry '{entry.title}'", target=entry)

    def perform_update(self, serializer):
        entry = serializer.save()
        log_action(self.request.user, f"Updated codex entry '{entry.title}'", target=entry)

    def perform_destroy(self, instance):
        # Double-guard: only HQ may delete
        if get_user_role(self.request.user) != 'HQ':
            return Response({'error': 'Only HQ may delete Codex entries.'}, status=status.HTTP_403_FORBIDDEN)
        title = instance.title
        log_action(self.request.user, f"Deleted codex entry '{title}'", target=instance)
        instance.delete()

    def get_queryset(self):
        qs = super().get_queryset()
        # Optional filters for category and search
        category = self.request.query_params.get('category')
        if category:
            # Support either category or entry_type as category source
            qs = qs.filter(entry_type=category)
        q = self.request.query_params.get('search')
        if q:
            from django.db.models import Q
            qs = qs.filter(Q(title__icontains=q) | Q(content__icontains=q))
        return qs


class EchoViewSet(viewsets.ModelViewSet):
    queryset = Echo.objects.all().order_by('-created_at')
    serializer_class = EchoSerializer
    permission_classes = [IsAuthenticated]

    def get_permissions(self):
        """
        Instantiates and returns the list of permissions that this view requires.
        """
        if self.action == 'destroy':
            self.permission_classes = [IsTrueProtector] # IsTrueProtector is HQ or Protector
        else:
            self.permission_classes = [IsAuthenticated]
        return super(EchoViewSet, self).get_permissions()

    def perform_create(self, serializer):
        role = get_user_role(self.request.user)
        # Non-leadership cannot pre-assign agents.
        if role not in ['PROTECTOR', 'HEIR', 'HQ']:
            if 'assigned_agents' in serializer.validated_data:
                serializer.validated_data.pop('assigned_agents')
        echo = serializer.save(created_by=self.request.user)

        log_action(self.request.user, f"Submitted echo '{echo.title}' targeting {echo.suggested_target}", target=echo)
        # Notify leadership about new Silo report
        try:
            recipients = User.objects.filter(profile__role__in=['PROTECTOR', 'HEIR']).distinct()
            Notification.objects.bulk_create([
                Notification(
                    user=u,
                    notif_type=Notification.Type.SILO_REPORT,
                    message=f"New Silo report: {echo.title}",
                    metadata={'echo_id': echo.id}
                ) for u in recipients
            ])
        except Exception:
            pass

    def get_queryset(self):
        qs = super().get_queryset().select_related('created_by').prefetch_related('assigned_agents')
        
        # Handle single status filter
        status_filter = self.request.query_params.get('status')
        if status_filter:
            qs = qs.filter(status=status_filter)
        # Handle multiple status filter for archive view
        status_in_filter = self.request.query_params.get('status__in')
        if status_in_filter:
            statuses = [s.strip().upper() for s in status_in_filter.split(',') if s.strip()]
            if statuses:
                qs = qs.filter(status__in=statuses)

        q = self.request.query_params.get('q')
        if q:
            qs = qs.filter(Q(title__icontains=q) | Q(content__icontains=q))

        role = get_user_role(self.request.user)
        # Leadership: can see all (optionally filtered by status)
        if role in ['PROTECTOR', 'HEIR', 'HQ']:
            return qs
        # Overlooker and others: can only see their own submissions
        return qs.filter(created_by=self.request.user)

    def perform_destroy(self, instance):
        title = instance.title
        log_action(self.request.user, f"Permanently deleted Silo report '{title}'", target=instance)
        instance.delete()

    @action(detail=True, methods=['post'], permission_classes=[IsProtectorOrHeir])
    def dismiss(self, request, pk=None):
        echo = self.get_object()
        echo.status = Echo.Status.DISMISSED
        echo.decided_by = request.user
        echo.decided_at = echo.decided_at or echo.created_at
        echo.save(update_fields=['status', 'decided_by', 'decided_at'])
        log_action(request.user, f"Dismissed echo '{echo.title}'", target=echo)
        return Response(self.get_serializer(echo).data)

    @action(detail=True, methods=['post'], permission_classes=[IsProtectorOrHeir])
    def promote(self, request, pk=None):
        echo = self.get_object()
        to = request.data.get('to') or echo.suggested_target
        if to not in ['LINEAGE', 'SCALES']:
            return Response({'error': 'Invalid target'}, status=status.HTTP_400_BAD_REQUEST)
        echo.status = Echo.Status.PROMOTED
        echo.decided_by = request.user
        echo.decided_at = echo.decided_at or echo.created_at
        echo.save(update_fields=['status', 'decided_by', 'decided_at'])
        log_action(request.user, f"Promoted echo '{echo.title}' to {to}", target=echo)
        # Provide simple prefill payload
        prefill = {
            'target': to,
            'title': echo.title,
            'content': echo.content,
        }
        return Response({'echo': self.get_serializer(echo).data, 'prefill': prefill})

    @action(detail=True, methods=['post'], permission_classes=[IsProtectorOrHeir], url_path='set-status')
    def set_status(self, request, pk=None):
        echo = self.get_object()
        new_status = request.data.get('status')
        allowed = ['PENDING', 'UNDER_REVIEW', 'ACTIONED', 'DISMISSED']
        if new_status not in allowed:
            return Response({'error': 'Invalid status'}, status=status.HTTP_400_BAD_REQUEST)
        echo.status = new_status
        if new_status in ['UNDER_REVIEW', 'ACTIONED', 'DISMISSED']:
            echo.decided_by = request.user
            echo.decided_at = echo.decided_at or echo.created_at
        echo.save(update_fields=['status', 'decided_by', 'decided_at'])
        log_action(request.user, f"Set report '{echo.title}' status to {new_status}", target=echo)
        return Response(self.get_serializer(echo).data)

    @action(detail=True, methods=['get', 'post'], permission_classes=[IsProtectorOrHeir], url_path='comments')
    def comments(self, request, pk=None):
        echo = self.get_object()
        if echo.status == Echo.Status.DISMISSED:
            return Response({'error': 'Cannot comment on a dismissed report.'}, status=status.HTTP_400_BAD_REQUEST)
        if request.method.lower() == 'get':
            return Response(SiloCommentSerializer(echo.comments.select_related('user'), many=True).data)
        # POST add comment
        msg = request.data.get('message')
        if not msg:
            return Response({'error': 'message is required'}, status=status.HTTP_400_BAD_REQUEST)
        c = echo.comments.create(user=request.user, message=msg)
        return Response(SiloCommentSerializer(c).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], permission_classes=[IsProtectorOrHeir], url_path='assign')
    def assign(self, request, pk=None):
        echo = self.get_object()
        if echo.status == Echo.Status.DISMISSED:
            return Response({'error': 'Cannot assign agents to a dismissed report.'}, status=status.HTTP_400_BAD_REQUEST)
        agent_id = request.data.get('agent_id')
        try:
            agent = LineageAgent.objects.get(pk=agent_id)
        except LineageAgent.DoesNotExist:
            return Response({'error': 'Agent not found'}, status=status.HTTP_404_NOT_FOUND)
        echo.assigned_agents.add(agent)
        log_action(request.user, f"Assigned agent '{agent.alias}' to report '{echo.title}'", target=echo)
        return Response(self.get_serializer(echo).data)

    @action(detail=True, methods=['post'], permission_classes=[IsProtectorOrHeir], url_path='unassign')
    def unassign(self, request, pk=None):
        echo = self.get_object()
        if echo.status == Echo.Status.DISMISSED:
            return Response({'error': 'Cannot unassign agents from a dismissed report.'}, status=status.HTTP_400_BAD_REQUEST)
        agent_id = request.data.get('agent_id')
        try:
            agent = LineageAgent.objects.get(pk=agent_id)
        except LineageAgent.DoesNotExist:
            return Response({'error': 'Agent not found'}, status=status.HTTP_404_NOT_FOUND)
        echo.assigned_agents.remove(agent)
        log_action(request.user, f"Unassigned agent '{agent.alias}' from report '{echo.title}'", target=echo)
        return Response(self.get_serializer(echo).data)


class TaskViewSet(viewsets.ModelViewSet):
    queryset = Task.objects.select_related('assigned_to', 'created_by').all().order_by('-created_at')
    serializer_class = TaskSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = super().get_queryset()
        mine = self.request.query_params.get('mine')
        role = get_user_role(self.request.user)
        if mine == '1':
            qs = qs.filter(assigned_to=self.request.user)
        elif role in ['PROTECTOR', 'HQ']:
            pass
        elif role == 'HEIR':
            # Heir sees tasks assigned to them OR tasks they created
            qs = qs.filter(Q(assigned_to=self.request.user) | Q(created_by=self.request.user))
        else:
            # Others see tasks assigned to them
            qs = qs.filter(assigned_to=self.request.user)
        status_filter = self.request.query_params.get('status')
        if status_filter:
            qs = qs.filter(status=status_filter)
        related_app = self.request.query_params.get('related_app')
        related_id = self.request.query_params.get('related_id')
        if related_app:
            qs = qs.filter(related_app=related_app)
        if related_id:
            qs = qs.filter(related_id=related_id)
        return qs

    def perform_create(self, serializer):
        # Resolve assignee: either given id or by role hint
        assigned_user = None
        assigned_to = self.request.data.get('assigned_to')
        assigned_role = self.request.data.get('assigned_to_role')
        if assigned_to:
            try:
                assigned_user = User.objects.get(pk=int(assigned_to))
            except Exception:
                assigned_user = None
        elif assigned_role:
            try:
                assigned_user = User.objects.filter(profile__role=assigned_role).first()
            except Exception:
                assigned_user = None
        task = serializer.save(created_by=self.request.user, assigned_to=assigned_user)
        log_action(self.request.user, f"Created task '{task.title}' for {task.assigned_to}", target=task)
        # Notify assignee if present
        try:
            if assigned_user:
                Notification.objects.create(
                    user=assigned_user,
                    notif_type=Notification.Type.TASK_ASSIGNED,
                    message=f"Task assigned: {task.title}",
                    metadata={'task_id': task.id}
                )
        except Exception:
            pass

    @action(detail=True, methods=['post'])
    def complete(self, request, pk=None):
        task = self.get_object()
        role = get_user_role(request.user)
        # Allow Protector/HQ to complete any task; others only their own
        if role not in ['PROTECTOR', 'HQ'] and task.assigned_to_id != getattr(request.user, 'id', None):
            return Response({'error': 'Not permitted to update this task.'}, status=status.HTTP_403_FORBIDDEN)
        task.status = Task.Status.SUCCESS
        task.save(update_fields=['status'])
        log_action(request.user, f"Completed task '{task.title}'", target=task)
        return Response(self.get_serializer(task).data)

    @action(detail=True, methods=['post'], url_path='set-status')
    def set_status(self, request, pk=None):
        task = self.get_object()
        role = get_user_role(request.user)
        if role not in ['PROTECTOR', 'HQ'] and task.assigned_to_id != getattr(request.user, 'id', None):
            return Response({'error': 'Not permitted to update this task.'}, status=status.HTTP_403_FORBIDDEN)
        new_status = request.data.get('status')
        if new_status not in dict(Task.Status.choices):
            return Response({'error': 'Invalid status'}, status=status.HTTP_400_BAD_REQUEST)
        task.status = new_status
        task.save(update_fields=['status'])
        log_action(request.user, f"Set task '{task.title}' status to {new_status}", target=task)
        return Response(self.get_serializer(task).data)

    def create(self, request, *args, **kwargs):
        # Translate assigned_to_role to assigned_to id before serializer validation
        data = request.data.copy()
        if 'assigned_to' not in data and 'assigned_to_role' in data:
            role = data.get('assigned_to_role')
            try:
                user = User.objects.filter(profile__role=role).first()
                if user:
                    data['assigned_to'] = user.id
            except Exception:
                pass
            # Do not pop 'assigned_to_role', let perform_create handle it

        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)



class BulletinViewSet(viewsets.ModelViewSet):
    queryset = Bulletin.objects.select_related('created_by').all().order_by('-created_at')
    serializer_class = BulletinSerializer

    def get_permissions(self):
        if self.action in ['list', 'retrieve', 'ack', 'create']:
            self.permission_classes = [IsAuthenticated]
        else:  # update, partial_update, destroy
            self.permission_classes = [IsAuthenticated] # Permissions checked in methods
        return super().get_permissions()

    def get_queryset(self):
        qs = super().get_queryset()
        # Bulletins are for all authenticated users.
        return qs

    def perform_create(self, serializer):
        bulletin = serializer.save(created_by=self.request.user)
        log_action(self.request.user, f"Posted bulletin '{bulletin.title}' to {bulletin.audience}", target=bulletin)

    def update(self, request, *args, **kwargs):
        bulletin = self.get_object()
        role = get_user_role(request.user)
        if bulletin.created_by != request.user and role not in ['PROTECTOR', 'HQ']:
            return Response({'error': 'You do not have permission to edit this bulletin.'}, status=status.HTTP_403_FORBIDDEN)
        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        bulletin = self.get_object()
        role = get_user_role(request.user)
        if bulletin.created_by != request.user and role not in ['PROTECTOR', 'HQ']:
            return Response({'error': 'You do not have permission to delete this bulletin.'}, status=status.HTTP_403_FORBIDDEN)
        return super().destroy(request, *args, **kwargs)

    @action(detail=False, methods=['post'], permission_classes=[IsHQ], url_path='clear')
    def clear_board(self, request):
        """HQ-only: remove all bulletins and acknowledgements."""
        try:
            count = Bulletin.objects.count()
            Bulletin.objects.all().delete()
            log_action(request.user, f"Cleared bulletin board ({count} items)")
            return Response({'status': 'ok', 'removed': count})
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=True, methods=['post'], url_path='ack')
    def acknowledge(self, request, pk=None):
        bulletin = self.get_object()
        _, created = BulletinAck.objects.get_or_create(bulletin=bulletin, user=request.user)
        # Notify the creator of the bulletin on first acknowledgement
        if created and bulletin.created_by != request.user:
            Notification.objects.create(
                user=bulletin.created_by,
                notif_type=Notification.Type.BULLETIN_ACK,
                message=f"{request.user.username} acknowledged your bulletin: '{bulletin.title}'",
                metadata={'bulletin_id': bulletin.id, 'user_id': request.user.id}
            )
        return Response({'status': 'acknowledged'})

    @action(detail=False, methods=['get'], url_path='unacked-count')
    def unacked_count(self, request):
        role = get_user_role(request.user)
        qs = self.get_queryset()
        if role != 'PROTECTOR':
            qs = qs.exclude(acks__user=request.user)
        return Response({'count': qs.count()})

class NotificationViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = Notification.objects.filter(user=self.request.user).order_by('-created_at')
        unread_only = self.request.query_params.get('unread')
        if unread_only in ['1', 'true', 'True']:
            qs = qs.filter(read_at__isnull=True)
        return qs

    @action(detail=False, methods=['post'], url_path='mark-read')
    def mark_read(self, request):
        ids = request.data.get('ids') or []
        if not isinstance(ids, list):
            return Response({'error': 'ids must be a list'}, status=status.HTTP_400_BAD_REQUEST)
        from django.utils import timezone
        Notification.objects.filter(user=request.user, id__in=ids, read_at__isnull=True).update(read_at=timezone.now())
        return Response({'status': 'ok'})

    @action(detail=False, methods=['get'], url_path='unread-count')
    def unread_count(self, request):
        count = Notification.objects.filter(user=request.user, read_at__isnull=True).count()
        return Response({'count': count})

    def create(self, request, *args, **kwargs):
        # Translate assigned_to_role to assigned_to id before serializer validation
        data = request.data.copy()
        if 'assigned_to' not in data and 'assigned_to_role' in data:
            role = data.get('assigned_to_role')
            try:
                user = User.objects.filter(profile__role=role).first()
                if user:
                    data['assigned_to'] = user.id
            except Exception:
                pass
            data.pop('assigned_to_role', None)
        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)    
class VaultAccessMixin:
    permission_classes = [IsAuthenticated]

    def _enforce_vault_access(self, request):
        role = get_user_role(request.user)
        # Allow HQ full access in addition to Protector/Heir
        if role not in ['PROTECTOR', 'HEIR', 'HQ']:
            return Response({'error': 'Forbidden'}, status=status.HTTP_403_FORBIDDEN)
        # Require secondary auth for Heir only; Protector and HQ bypass
        if role not in ['PROTECTOR', 'HQ']:
            secondary = request.headers.get('X-Secondary-Auth') or request.data.get('secondary_auth') or request.query_params.get('secondary_auth')
            from django.conf import settings
            if secondary != settings.SECONDARY_PASSPHRASE:
                return Response({'error': 'Secondary authentication required'}, status=status.HTTP_403_FORBIDDEN)
        return None


class PropertyDossierViewSet(VaultAccessMixin, viewsets.ModelViewSet):
    queryset = __import__('codex.models', fromlist=['PropertyDossier']).PropertyDossier.objects.select_related('created_by').prefetch_related('stored_items').all().order_by('-created_at')
    serializer_class = __import__('codex.serializers', fromlist=['PropertyDossierSerializer']).PropertyDossierSerializer

    def list(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        return super().list(request, *args, **kwargs)

    def retrieve(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        return super().retrieve(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        return super().create(request, *args, **kwargs)

    def perform_create(self, serializer):
        dossier = serializer.save(created_by=self.request.user)
        log_action(self.request.user, f"Created property dossier '{dossier.name}'", target=dossier)

    def update(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        resp = super().update(request, *args, **kwargs)
        try:
            d = self.get_object()
            log_action(request.user, f"Updated property dossier '{d.name}'", target=d)
        except Exception:
            pass
        return resp

    def destroy(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        try:
            d = self.get_object()
            log_action(request.user, f"Deleted property dossier '{d.name}'", target=d)
        except Exception:
            pass
        return super().destroy(request, *args, **kwargs)


class VehicleViewSet(VaultAccessMixin, viewsets.ModelViewSet):
    queryset = __import__('codex.models', fromlist=['Vehicle']).Vehicle.objects.select_related('created_by', 'assigned_agent').all().order_by('-created_at')
    serializer_class = __import__('codex.serializers', fromlist=['VehicleSerializer']).VehicleSerializer

    def list(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        return super().list(request, *args, **kwargs)

    def retrieve(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        return super().retrieve(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        return super().create(request, *args, **kwargs)

    def perform_create(self, serializer):
        v = serializer.save(created_by=self.request.user)
        log_action(self.request.user, f"Created vehicle '{v.make} {v.model}'", target=v)

    def update(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        resp = super().update(request, *args, **kwargs)
        try:
            v = self.get_object()
            log_action(request.user, f"Updated vehicle '{v.make} {v.model}'", target=v)
        except Exception:
            pass
        return resp

    def destroy(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        try:
            v = self.get_object()
            log_action(request.user, f"Deleted vehicle '{v.make} {v.model}'", target=v)
        except Exception:
            pass
        return super().destroy(request, *args, **kwargs)

class VaultItemViewSet(viewsets.ModelViewSet):
    queryset = __import__('codex.models', fromlist=['VaultItem']).VaultItem.objects.select_related('created_by').all().order_by('-created_at')
    serializer_class = __import__('codex.serializers', fromlist=['VaultItemSerializer']).VaultItemSerializer
    permission_classes = [IsAuthenticated]

    def get_permissions(self):
        # Restrict to Protector or Heir
        return super().get_permissions()

    def list(self, request, *args, **kwargs):
        role = get_user_role(request.user)
        if role not in ['PROTECTOR', 'HEIR', 'HQ']:
            return Response({'error': 'Forbidden'}, status=status.HTTP_403_FORBIDDEN)
        # Secondary authentication is required unless effective role is Protector or HQ
        if role not in ['PROTECTOR', 'HQ']:
            secondary = request.headers.get('X-Secondary-Auth') or request.query_params.get('secondary_auth')
            from django.conf import settings
            if secondary != settings.SECONDARY_PASSPHRASE:
                return Response({'error': 'Secondary authentication required'}, status=status.HTTP_403_FORBIDDEN)
        return super().list(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        role = get_user_role(request.user)
        if role not in ['PROTECTOR', 'HEIR', 'HQ']:
            return Response({'error': 'Forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if role not in ['PROTECTOR', 'HQ']:
            secondary = request.headers.get('X-Secondary-Auth') or request.data.get('secondary_auth')
            from django.conf import settings
            if secondary != settings.SECONDARY_PASSPHRASE:
                return Response({'error': 'Secondary authentication required'}, status=status.HTTP_403_FORBIDDEN)
        return super().create(request, *args, **kwargs)

    def perform_create(self, serializer):
        item = serializer.save(created_by=self.request.user)
        log_action(self.request.user, f"Created vault item '{item.name}'", target=item)

    # Apply same access + secondary-auth policy to retrieve/update/delete
    def _enforce_vault_access(self, request):
        role = get_user_role(request.user)
        if role not in ['PROTECTOR', 'HEIR', 'HQ']:
            return Response({'error': 'Forbidden'}, status=status.HTTP_403_FORBIDDEN)
        if role not in ['PROTECTOR', 'HQ']:
            secondary = request.headers.get('X-Secondary-Auth') or request.data.get('secondary_auth') or request.query_params.get('secondary_auth')
            from django.conf import settings
            if secondary != settings.SECONDARY_PASSPHRASE:
                return Response({'error': 'Secondary authentication required'}, status=status.HTTP_403_FORBIDDEN)
        return None

    def retrieve(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        return super().retrieve(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        resp = super().update(request, *args, **kwargs)
        try:
            item = self.get_object()
            log_action(request.user, f"Updated vault item '{item.name}'", target=item)
        except Exception:
            pass
        return resp

    def partial_update(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        resp = super().partial_update(request, *args, **kwargs)
        try:
            item = self.get_object()
            log_action(request.user, f"Updated vault item '{item.name}'", target=item)
        except Exception:
            pass
        return resp

    def destroy(self, request, *args, **kwargs):
        gate = self._enforce_vault_access(request)
        if gate is not None:
            return gate
        try:
            item = self.get_object()
            title = item.name
            log_action(request.user, f"Deleted vault item '{title}'", target=item)
        except Exception:
            pass
        return super().destroy(request, *args, **kwargs)
