from rest_framework import serializers
from .models import Agent
from index.serializers import IndexProfileSerializer

class AgentSerializer(serializers.ModelSerializer):
    # Use a read-only nested serializer to include public profile details
    index_profile = IndexProfileSerializer(read_only=True)
    # Keep index_profile_id as a write-only field for creating the link
    index_profile_id = serializers.IntegerField(write_only=True, required=False, allow_null=True)

    class Meta:
        model = Agent
        # Ensure all fields from the model are included, especially the new ones.
        fields = [
            'id', 'alias', 'real_name', 'status', 'key_skill', 'loyalty_type', 'index_profile',
            'summary', 'picture_url', 'personality', 'locations', 'vehicles',
            'surveillance_images', 'secure_comms_channel', 'secure_comms_contact_id',
            'duress_code', 'last_contacted_at', 'dev_plan_focus', 'dev_plan_next',
            'dev_plan_notes', 'index_profile_id', 'order_index'
        ]
        read_only_fields = ['last_contacted_at']