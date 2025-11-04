from rest_framework import serializers
from .models import Faction, Agent, Connection
from lineage.serializers import AgentSerializer as LineageAgentSerializer

class FactionSerializer(serializers.ModelSerializer):
    member_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Faction
        fields = [
            'id', 'name', 'threat_level', 'description', 'is_active',
            'picture_url', 'strengths', 'weaknesses', 'member_count',
            'allies', 'rivals', 'surveillance_urls'
        ]

class AgentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Agent
        fields = [
            'id', 'name', 'alias', 'rank', 'strengths', 'weaknesses',
            'known_locations', 'known_vehicles', 'picture_url',
            'surveillance_images', 'threat_level'
        ]

class ConnectionSerializer(serializers.ModelSerializer):
    scales_agent = AgentSerializer(read_only=True)
    lineage_agent = LineageAgentSerializer(read_only=True)

    class Meta:
        model = Connection
        fields = [
            'id', 'scales_agent', 'lineage_agent', 'relationship',
            'note', 'created_at'
        ]