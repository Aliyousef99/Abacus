from rest_framework import serializers
from .models import IndexProfile


class IndexProfileSummarySerializer(serializers.ModelSerializer):
    """A lightweight serializer for displaying profile names and IDs."""
    class Meta:
        model = IndexProfile
        fields = ['id', 'full_name']