from rest_framework import serializers
from .models import CodexEntry, Echo, Task, SiloComment, VaultItem, PropertyDossier, Vehicle, Bulletin, BulletinAck, Notification
from django.contrib.auth.models import User

class UserDisplaySerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(source='profile.display_name', read_only=True)

    class Meta:
        model = User
        fields = ['id', 'username', 'display_name']

class CodexEntrySerializer(serializers.ModelSerializer):
    class Meta:
        model = CodexEntry
        fields = ['id', 'title', 'summary', 'content', 'entry_type', 'image_urls', 'created_at']

class EchoSerializer(serializers.ModelSerializer):
    created_by = UserDisplaySerializer(read_only=True)
    decided_by_username = serializers.CharField(source='decided_by.username', read_only=True)
    class Meta:
        model = Echo
        fields = ['id', 'title', 'content', 'suggested_target', 'confidence', 'involved_entities', 'evidence_urls', 'status', 'created_by', 'decided_by', 'decided_by_username', 'created_at', 'decided_at']
        read_only_fields = ['status', 'created_by', 'decided_by', 'decided_by_username', 'created_at', 'decided_at']

    def to_representation(self, instance):
        """Ensure involved_entities has a consistent structure for the frontend."""
        ret = super().to_representation(instance)
        entities = ret.get('involved_entities', [])
        if isinstance(entities, list):
            normalized_entities = []
            for entity in entities:
                if isinstance(entity, dict) and 'id' in entity and 'type' in entity and 'name' in entity:
                    # Ensure ID is a string for consistency, as it comes from the form.
                    entity['id'] = str(entity['id'])
                    normalized_entities.append(entity)
            ret['involved_entities'] = normalized_entities
        return ret

class TaskSerializer(serializers.ModelSerializer):
    created_by_username = serializers.CharField(source='created_by.username', read_only=True)
    assigned_to_username = serializers.CharField(source='assigned_to.username', read_only=True)
    class Meta:
        model = Task
        fields = ['id', 'title', 'description', 'status', 'created_by', 'created_by_username', 'assigned_to', 'assigned_to_username', 'created_at', 'related_app', 'related_id']
        read_only_fields = ['created_by', 'created_by_username', 'created_at']

class SiloCommentSerializer(serializers.ModelSerializer):
    user = UserDisplaySerializer(read_only=True)
    class Meta:
        model = SiloComment
        fields = ['id', 'user', 'message', 'created_at']
        read_only_fields = ['id', 'echo', 'user', 'user_username', 'created_at']

class VaultItemSerializer(serializers.ModelSerializer):
    created_by_username = serializers.CharField(source='created_by.username', read_only=True)
    class Meta:
        model = VaultItem
        fields = ['id', 'item_type', 'name', 'identifier', 'notes', 'secret', 'created_by', 'created_by_username', 'created_at']
        read_only_fields = ['created_by', 'created_by_username', 'created_at']

class PropertyDossierSerializer(serializers.ModelSerializer):
    created_by_username = serializers.CharField(source='created_by.username', read_only=True)
    stored_items = serializers.PrimaryKeyRelatedField(queryset=VaultItem.objects.all(), many=True, required=False)
    class Meta:
        model = PropertyDossier
        fields = ['id', 'name', 'address', 'photos_urls', 'blueprints_urls', 'security_details', 'vulnerabilities', 'stored_items', 'created_by', 'created_by_username', 'created_at']
        read_only_fields = ['created_by', 'created_by_username', 'created_at']

class VehicleSerializer(serializers.ModelSerializer):
    created_by_username = serializers.CharField(source='created_by.username', read_only=True)
    assigned_agent_alias = serializers.CharField(source='assigned_agent.alias', read_only=True)
    class Meta:
        model = Vehicle
        fields = ['id', 'make', 'model', 'year', 'vin', 'license_plate_clean', 'license_plate_cloned', 'modifications', 'last_known_location', 'picture_urls', 'assigned_agent', 'assigned_agent_alias', 'created_by', 'created_by_username', 'created_at']
        read_only_fields = ['created_by', 'created_by_username', 'created_at', 'assigned_agent_alias']

class BulletinSerializer(serializers.ModelSerializer):
    created_by_username = serializers.CharField(source='created_by.username', read_only=True)
    acknowledged = serializers.SerializerMethodField()
    acknowledged_by = serializers.SerializerMethodField()
    total_users = serializers.SerializerMethodField()

    class Meta:
        model = Bulletin
        fields = ['id', 'title', 'message', 'audience', 'created_by', 'created_by_username', 'created_at', 'acknowledged', 'acknowledged_by', 'total_users']
        read_only_fields = ['created_by', 'created_by_username', 'created_at', 'acknowledged', 'acknowledged_by', 'total_users']

    def get_acknowledged(self, obj):
        user = self.context.get('request').user if self.context.get('request') else None
        if not user or not user.is_authenticated:
            return False
        return obj.acks.filter(user=user).exists()

    def get_acknowledged_by(self, obj):
        # Return a list of usernames of all users who have acknowledged the bulletin.
        return [ack.user.username for ack in obj.acks.select_related('user').all()]

    def get_total_users(self, obj):
        from django.contrib.auth.models import User
        # We count all active users as the potential audience for any bulletin.
        return User.objects.filter(is_active=True).count()

class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = ['id', 'notif_type', 'message', 'created_at', 'read_at', 'metadata']
        read_only_fields = ['id', 'created_at', 'read_at']
