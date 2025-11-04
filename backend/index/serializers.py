from rest_framework import serializers
from .models import IndexProfile, IndexConnection


class IndexProfileSummarySerializer(serializers.ModelSerializer):
    """A lightweight serializer for displaying profile names and IDs."""
    class Meta:
        model = IndexProfile
        fields = ['id', 'full_name']

class IndexProfileSerializer(serializers.ModelSerializer):
    # The 'affiliations' field will be dynamically added in the view if needed.
    class Meta:
        model = IndexProfile
        fields = [
            'id', 'full_name', 'aliases', 'picture_url', 'classification',
            'status', 'threat_level', 'biography', 'strengths', 'weaknesses',
            'known_locations', 'known_vehicles', 'surveillance_urls',
            'created_at', 'updated_at'
        ]

class IndexConnectionSerializer(serializers.ModelSerializer):
    # Nested serializer to show details of the connected profile
    to_profile_details = serializers.SerializerMethodField()
    from_profile_details = serializers.SerializerMethodField()

    class Meta:
        model = IndexConnection
        fields = ['id', 'from_profile', 'to_profile', 'relationship', 'to_profile_details', 'from_profile_details']
        read_only_fields = ['id', 'from_profile', 'to_profile_details', 'from_profile_details']

    def get_to_profile_details(self, obj):
        """Return a summary of the 'to' profile."""
        return {
            'id': obj.to_profile.id,
            'full_name': obj.to_profile.full_name,
            'classification': obj.to_profile.classification,
        }

    def get_from_profile_details(self, obj):
        """Return a summary of the 'from' profile."""
        return {
            'id': obj.from_profile.id,
            'full_name': obj.from_profile.full_name,
            'classification': obj.from_profile.classification,
        }