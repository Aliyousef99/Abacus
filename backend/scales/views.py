import re

from django.utils import timezone
from django.db import transaction
from django.db.models import Q, Prefetch
from rest_framework import viewsets, status, generics
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.filters import SearchFilter
from rest_framework.exceptions import PermissionDenied
import uuid

from .models import Faction, Agent, Connection, FactionHistory, FactionMembership
from index.models import IndexProfile
from audit.models import AuditLog
from .serializers import FactionSerializer, AgentSerializer, ConnectionSerializer
from api.permissions import get_user_role, IsProtectorOrHeir, IsHQProtectorOrHeir
from audit.utils import log_action

class FactionViewSet(viewsets.ModelViewSet):
    """
    Provides CRUD for Factions with role-based permissions.
    """
    serializer_class = FactionSerializer
    permission_classes = [IsAuthenticated]
    # Add SearchFilter to enable the '?search=' query parameter
    filter_backends = [SearchFilter]
    search_fields = ['name', 'description']

    alias_splitter = re.compile(r'[,\n\r;]+')

    def get_object(self):
        queryset = self.filter_queryset(self.get_queryset())
        # Attempt to retrieve by supa_uuid first if the lookup value is a valid UUID
        lookup_value = self.kwargs['pk']
        if self.action in ['retrieve', 'update', 'partial_update', 'destroy', 'timeline'] and isinstance(lookup_value, str) and self._is_valid_uuid(lookup_value):
            obj = generics.get_object_or_404(queryset, supa_uuid=lookup_value)
        else:
            # Otherwise, use the default lookup (by 'pk' which is 'id')
            obj = generics.get_object_or_404(queryset, pk=lookup_value)
        self.check_object_permissions(self.request, obj)
        return obj

    def _is_valid_uuid(self, uuid_string):
        try:
            uuid.UUID(uuid_string)
            return True
        except ValueError:
            return False

    def _affiliation_choices(self):
        return [choice.value for choice in FactionMembership.Affiliation]

    def _normalise_affiliation(self, value, options):
        value = (value or '').strip()
        if value in options:
            return value
        if FactionMembership.Affiliation.ASSOCIATE in options:
            return FactionMembership.Affiliation.ASSOCIATE
        return options[0] if options else FactionMembership.Affiliation.ASSOCIATE

    def _log_faction_history(self, faction, user):
        """Helper to create a FactionHistory entry after membership changes."""
        try:
            # Use the latest member count from the database for accuracy.
            member_count = FactionMembership.objects.filter(faction=faction).count()
            FactionHistory.objects.create(
                faction=faction, 
                threat_level=faction.threat_level,
                member_count=member_count,
                updated_by=user,
            )
        except Exception:
            # It's often better to log this error than to pass silently.
            pass

    def _split_aliases(self, raw):
        if not raw:
            return []
        if isinstance(raw, (list, tuple)):
            return [str(part).strip() for part in raw if str(part).strip()]
        return [
            part.strip()
            for part in self.alias_splitter.split(str(raw))
            if part.strip()
        ]

    def _serialize_membership(self, membership, options):
        profile = membership.profile
        return {
            'profile_id': profile.id,
            'full_name': profile.full_name,
            'aliases': self._split_aliases(profile.aliases),
            'affiliation': self._normalise_affiliation(membership.affiliation, options),
        }

    def _get_serialized_members(self, faction, affiliation_options):
        """Helper to fetch and serialize the current members of a faction."""
        memberships = (
            FactionMembership.objects.filter(faction=faction)
            .select_related('profile')
            .order_by('profile__full_name')
        )
        return [
            self._serialize_membership(membership, affiliation_options)
            for membership in memberships
            if membership.profile_id and membership.profile is not None
        ]

    def get_permissions(self):
        # Read for any authenticated user; write for HQ/Protector/Heir
        if self.action in ['list', 'retrieve', 'history', 'network', 'timeline']:
            self.permission_classes = [IsAuthenticated]
        elif self.action in ['create', 'update', 'partial_update', 'destroy', 'add_member', 'unlink_member', 'manage_members']:
            self.permission_classes = [IsHQProtectorOrHeir]
        return super().get_permissions()

    def get_queryset(self):
        role = get_user_role(self.request.user)
        member_prefetch = Prefetch(
            'memberships',
            queryset=FactionMembership.objects.select_related('profile'),
            to_attr='prefetched_memberships',
        )
        prefetch = ['diplomacy_outgoing__target', member_prefetch]
        if role in ['PROTECTOR', 'HQ']:
            return Faction.all_objects.prefetch_related(*prefetch).all().order_by('name')
        return Faction.objects.prefetch_related(*prefetch).all().order_by('name')

    def perform_create(self, serializer):
        faction = serializer.save()
        log_action(self.request.user, f"Created faction '{faction.name}'", target=faction)

    def perform_update(self, serializer):
        # Capture previous values for change detection
        prev = serializer.instance
        prev_threat = prev.threat_level
        prev_members = prev.member_count if hasattr(prev, 'member_count') else None
        faction = serializer.save()
        log_action(self.request.user, f"Updated faction '{faction.name}'", target=faction)
        # Log history if key indicators changed
        if faction.threat_level != prev_threat:
            FactionHistory.objects.create(
                faction=faction,
                threat_level=faction.threat_level,
                member_count=faction.member_count,
                updated_by=self.request.user,
            )



    def perform_destroy(self, instance):
        role = get_user_role(self.request.user)
        faction_name = instance.name

        if role in ['PROTECTOR', 'HQ']:
            log_action(self.request.user, f"Permanently deleted faction '{faction_name}'", target=instance)
            instance.delete()  # Hard delete
        elif role == 'HEIR':
            instance.deleted_at = timezone.now()
            instance.save()
            log_action(self.request.user, f"Archived faction '{faction_name}'", target=instance)
        else:  # Overlooker and any other role
            log_action(self.request.user, f"Denied attempt to delete faction '{faction_name}'", target=instance)
            raise PermissionDenied("You do not have permission to delete factions.")

    @action(detail=True, methods=['post'], url_path='members', permission_classes=[IsAuthenticated])
    def add_member(self, request, pk=None):
        """Link an existing IndexProfile to this faction (many-to-many).

        Body: { profile_id: int }
        """
        faction = self.get_object()
        profile_id = request.data.get('profile_id')
        try:
            from index.models import IndexProfile, IndexAffiliation
            profile = IndexProfile.objects.get(id=profile_id)
            level = request.data.get('level') or None
            # create/update through model to store level
            obj, _ = IndexAffiliation.objects.update_or_create(profile=profile, faction=faction, defaults={'level': level})
            log_action(request.user, f"Linked profile '{profile.full_name}' to faction '{faction.name}'", target=faction)
            # Optional: history snapshot for member count using index profiles length
            self._log_faction_history(faction, request.user)
            return Response({'status': 'linked'}, status=status.HTTP_200_OK)
        except Exception:
            return Response({'error': 'Profile not found'}, status=status.HTTP_404_NOT_FOUND)

    @action(detail=True, methods=['post'], url_path='unlink-member', permission_classes=[IsAuthenticated])
    def unlink_member(self, request, pk=None):
        """Unlink an IndexProfile from this faction.

        Body: { profile_id: int }
        """
        faction = self.get_object()
        profile_id = request.data.get('profile_id')
        try:
            from index.models import IndexProfile, IndexAffiliation
            profile = IndexProfile.objects.get(id=profile_id)
            IndexAffiliation.objects.filter(profile=profile, faction=faction).delete()
            log_action(request.user, f"Unlinked profile '{profile.full_name}' from faction '{faction.name}'", target=faction)
            self._log_faction_history(faction, request.user)
            return Response({'status': 'unlinked'}, status=status.HTTP_200_OK)
        except Exception:
            return Response({'error': 'Profile not found'}, status=status.HTTP_404_NOT_FOUND)

    @action(detail=True, methods=['get', 'post'], url_path='manage-members', permission_classes=[IsHQProtectorOrHeir])
    def manage_members(self, request, pk=None):
        faction = self.get_object()
        affiliation_options = self._affiliation_choices()
        query = (request.query_params.get('q') or '').strip()

        if request.method.lower() == 'get' and query:
            existing_ids = set(
                FactionMembership.objects.filter(faction=faction).values_list('profile_id', flat=True)
            )
            search = (
                IndexProfile.objects.filter(
                    Q(full_name__icontains=query) | Q(aliases__icontains=query)
                )
                .exclude(id__in=existing_ids)
                .order_by('full_name')[:20]
            )
            candidates = [
                {
                    'profile_id': profile.id,
                    'full_name': profile.full_name,
                    'aliases': self._split_aliases(profile.aliases),
                    'affiliation': self._normalise_affiliation(None, affiliation_options),
                }
                for profile in search
            ]
            return Response({
                'affiliation_options': affiliation_options,
                'candidates': candidates,
            })

        if request.method.lower() == 'get':
            members = self._get_serialized_members(faction, affiliation_options)
            return Response({
                'affiliation_options': affiliation_options,
                'members': members,
                'candidates': [],
            })

        payload = request.data
        add_payload = [item for item in payload.get('add', []) if isinstance(item, dict) and 'profile_id' in item]
        updates_payload = [item for item in payload.get('updates', []) if isinstance(item, dict) and 'profile_id' in item]
        remove_payload = payload.get('remove', [])

        def get_ids_from_payload(p_list):
            ids = set()
            for item in p_list:
                try:
                    ids.add(int(item.get('profile_id')))
                except (TypeError, ValueError, AttributeError):
                    continue
            return list(ids)

        add_ids = get_ids_from_payload(add_payload)
        remove_ids = [int(pid) for pid in remove_payload if str(pid).isdigit()]

        made_changes = False
        with transaction.atomic():
            memberships = {
                m.profile_id: m
                for m in FactionMembership.objects.select_for_update().filter(faction=faction)
            }

            if add_ids:
                profiles = {
                    p.id: p for p in IndexProfile.objects.filter(id__in=add_ids)
                }
                for item in add_payload:
                    try:
                        profile_id = int(item.get('profile_id'))
                    except (TypeError, ValueError, AttributeError):
                        continue
                    profile = profiles.get(profile_id)
                    if profile:
                        desired_aff = self._normalise_affiliation(item.get('affiliation'), affiliation_options)
                        # If the member is not already in the faction, create the membership.
                        if profile_id not in memberships:
                            membership = FactionMembership.objects.create(
                                faction=faction,
                                profile=profile,
                                affiliation=desired_aff,
                            )
                            memberships[profile_id] = membership
                            made_changes = True
                            log_action(request.user, f"Added '{profile.full_name}' to faction '{faction.name}'", target=faction)
                        # Note: The 'updates' loop below will handle affiliation changes for both
                        # existing members and newly added members if their affiliation was
                        # changed on the frontend after being added.

            for item in updates_payload:
                try:
                    profile_id = int(item.get('profile_id'))
                except (TypeError, ValueError, AttributeError):
                    continue
                membership = memberships.get(profile_id)
                if not membership:
                    continue
                desired_aff = self._normalise_affiliation(item.get('affiliation'), affiliation_options)
                if membership.affiliation != desired_aff:
                    membership.affiliation = desired_aff
                    membership.save(update_fields=['affiliation', 'updated_at'])
                    made_changes = True
                    log_action(request.user, f"Updated affiliation for '{membership.profile.full_name}' in '{faction.name}'", target=faction)

            if remove_ids:
                deleted, _ = FactionMembership.objects.filter(
                    faction=faction,
                    profile_id__in=remove_ids,
                ).delete()
                if deleted:
                    made_changes = True
                    for pid in remove_ids:
                        memberships.pop(pid, None)
                    log_action(request.user, f"Removed {deleted} members from faction '{faction.name}'", target=faction)

        if made_changes:
            # Individual actions are now logged above for better audit granularity.
            self._log_faction_history(faction, request.user)

        members = self._get_serialized_members(faction, affiliation_options)
        status_code = status.HTTP_200_OK if made_changes else status.HTTP_202_ACCEPTED
        return Response({
            'affiliation_options': affiliation_options,
            'members': members,
        }, status=status_code)

    @action(detail=True, methods=['get'], url_path='history', permission_classes=[IsAuthenticated])
    def history(self, request, pk=None):
        faction = self.get_object()
        qs = FactionHistory.objects.filter(faction=faction).order_by('timestamp')
        data = [
            {
                'timestamp': h.timestamp,
                'threat_index': h.threat_index,
                'member_count': h.member_count,
            }
            for h in qs
        ]
        return Response(data)

    @action(detail=False, methods=['get'], url_path='network', permission_classes=[IsAuthenticated])
    def network(self, request):
        """Return a simple node-link graph of factions, their members, and lineage connections."""
        factions = list(Faction.objects.prefetch_related('memberships__profile').all())
        scales_agents = list(Agent.objects.all())
        conns = list(Connection.objects.select_related('scales_agent', 'lineage_agent').all())

        nodes = []
        links = []
        seen = set()

        for f in factions:
            nid = f"F-{f.id}"
            if nid not in seen:
                nodes.append({ 'id': nid, 'type': 'FACTION', 'label': f.name, 'threat': f.threat_index })
                seen.add(nid)
            for membership in f.memberships.all():
                sid = f"S-{membership.profile_id}"
                if sid not in seen:
                    nodes.append({ 'id': sid, 'type': 'SCALES_AGENT', 'label': membership.profile.full_name })
                    seen.add(sid)
                links.append({ 'source': sid, 'target': nid, 'kind': 'MEMBER_OF' })

        for c in conns:
            sid = f"S-{c.scales_agent_id}"
            lid = f"L-{c.lineage_agent_id}"
            if sid not in seen:
                nodes.append({ 'id': sid, 'type': 'SCALES_AGENT', 'label': c.scales_agent.alias })
                seen.add(sid)
            if lid not in seen:
                nodes.append({ 'id': lid, 'type': 'LINEAGE_AGENT', 'label': c.lineage_agent.alias })
                seen.add(lid)
            links.append({ 'source': sid, 'target': lid, 'kind': 'CONNECTION', 'relationship': c.relationship })

        return Response({ 'nodes': nodes, 'links': links })

    @action(detail=True, methods=['get'], url_path='timeline', permission_classes=[IsAuthenticated])
    def timeline(self, request, pk=None):
        """Aggregate faction timeline: history snapshots + audit references."""
        faction = self.get_object()
        items = []
        # Faction history points
        for h in FactionHistory.objects.filter(faction=faction).order_by('-timestamp'):
            items.append({
                'timestamp': h.timestamp,
                'source': 'HISTORY', 
                'type': 'FACTION_METRICS',
                'text': f"Threat set to {h.threat_level}, Members {h.member_count}",
                'role': 'System',
                'user': '',
            })
        # Audit logs linked to this faction
        for log in AuditLog.objects.filter(content_type__model='faction', object_id=faction.id).order_by('-timestamp')[:200]:
            items.append({
                'timestamp': log.timestamp,
                'source': 'AUDIT',
                'type': 'ACTION',
                'text': log.action,
                'role': log.role or '',
                'user': getattr(log.user, 'username', '') or '',
                'details': log.details or None,
            })
        items.sort(key=lambda x: x['timestamp'], reverse=True)
        return Response(items)

class AgentViewSet(viewsets.ModelViewSet):
    """
    Provides CRUD for external agents (faction members) with role-based permissions.
    """
    serializer_class = AgentSerializer
    permission_classes = [IsAuthenticated]

    def get_permissions(self):
        if self.action in ['list', 'retrieve', 'connections'] and self.request.method.lower() == 'get':
            self.permission_classes = [IsAuthenticated]
        else:
            self.permission_classes = [IsHQProtectorOrHeir]
        return super().get_permissions()

    def get_queryset(self):
        role = get_user_role(self.request.user)
        if role in ['PROTECTOR', 'HQ']:
            return Agent.all_objects.all().order_by('alias')
        return Agent.objects.all().order_by('alias')

    def perform_create(self, serializer):
        agent = serializer.save()
        log_action(self.request.user, f"Created external agent '{agent.alias}'", target=agent)

    def perform_update(self, serializer):
        agent = serializer.save()
        log_action(self.request.user, f"Updated external agent '{agent.alias}'", target=agent)

    def perform_destroy(self, instance):
        role = get_user_role(self.request.user)
        agent_alias = instance.alias

        if role in ['PROTECTOR', 'HQ']:
            log_action(self.request.user, f"Permanently deleted external agent '{agent_alias}'", target=instance)
            instance.delete()
        elif role == 'HEIR':
            instance.deleted_at = timezone.now()
            instance.save()
            log_action(self.request.user, f"Archived external agent '{agent_alias}'", target=instance)
        else:
            log_action(self.request.user, f"Denied attempt to delete external agent '{agent_alias}'", target=instance)
            raise PermissionDenied("You do not have permission to delete these agents.")

    @action(detail=True, methods=['get', 'post'], url_path='connections', permission_classes=[IsAuthenticated])
    def connections(self, request, pk=None):
        """List or create connections for a Scales agent to a Lineage agent.
        GET: list connections for this Scales agent.
        POST: create connection; requires IsProtectorOrHeir role.
        Body: { lineage_agent_id: int, relationship: str, note?: str }
        """
        scales_agent = self.get_object()
        if request.method.lower() == 'get':
            qs = Connection.objects.filter(scales_agent=scales_agent).select_related('lineage_agent')
            return Response(ConnectionSerializer(qs, many=True).data)

        # POST create
        role = get_user_role(request.user)
        if role not in ['PROTECTOR', 'HEIR', 'HQ']:
            raise PermissionDenied("You do not have permission to create connections.")
        lineage_agent_id = request.data.get('lineage_agent_id')
        relationship = request.data.get('relationship')
        note = request.data.get('note', '')
        if not lineage_agent_id or not relationship:
            return Response({'error': 'lineage_agent_id and relationship are required.'}, status=status.HTTP_400_BAD_REQUEST)
        from lineage.models import Agent as LineageAgent
        try:
            lineage_agent = LineageAgent.objects.get(pk=lineage_agent_id)
        except LineageAgent.DoesNotExist:
            return Response({'error': 'Lineage agent not found.'}, status=status.HTTP_404_NOT_FOUND)
        if relationship not in dict(Connection.Relationship.choices):
            return Response({'error': 'Invalid relationship value.'}, status=status.HTTP_400_BAD_REQUEST)
        conn, created = Connection.objects.get_or_create(
            scales_agent=scales_agent,
            lineage_agent=lineage_agent,
            defaults={'relationship': relationship, 'note': note}
        )
        if not created:
            # Update relationship/note if already exists
            conn.relationship = relationship
            conn.note = note
            conn.save(update_fields=['relationship', 'note'])
        log_action(request.user, f"Linked scales agent '{scales_agent.alias}' to lineage agent '{lineage_agent.alias}' as {relationship}", target=scales_agent)
        return Response(ConnectionSerializer(conn).data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)
        
        # DELETE unlink (body should contain lineage_agent_id)
        
    @connections.mapping.delete
    def delete_connection(self, request, pk=None):
        scales_agent = self.get_object()
        role = get_user_role(request.user)
        if role not in ['PROTECTOR', 'HEIR', 'HQ']:
            raise PermissionDenied("You do not have permission to remove connections.")
        lineage_agent_id = request.data.get('lineage_agent_id')
        if not lineage_agent_id:
            return Response({'error': 'lineage_agent_id is required.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            conn = Connection.objects.get(scales_agent=scales_agent, lineage_agent_id=lineage_agent_id)
        except Connection.DoesNotExist:
            return Response({'error': 'Connection not found.'}, status=status.HTTP_404_NOT_FOUND)
        alias = conn.lineage_agent.alias
        conn.delete()
        log_action(request.user, f"Unlinked scales agent '{scales_agent.alias}' from lineage agent '{alias}'", target=scales_agent)
        return Response(status=status.HTTP_204_NO_CONTENT)
