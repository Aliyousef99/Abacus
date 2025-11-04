from rest_framework import serializers
from .models import Operation, OperationLog, Asset, AssetRequisition, OperationAssignment, OperationReportLink
from lineage.serializers import AgentSerializer
from scales.serializers import FactionSerializer
from index.serializers import IndexProfileSummarySerializer
from codex.serializers import UserDisplaySerializer

class OperationLogSerializer(serializers.ModelSerializer):
    user_display_name = serializers.CharField(source='user.profile.display_name', read_only=True)

    class Meta:
        model = OperationLog
        fields = ['id', 'message', 'timestamp', 'user_display_name']


class OperationSerializer(serializers.ModelSerializer):
    """Serializer for list and update operations."""
    class Meta:
        model = Operation
        fields = [
            'id', 'codename', 'objective', 'status', 'collateral_risk',
            'created_at', 'started_at', 'ended_at'
        ]


class OperationAssignmentSerializer(serializers.ModelSerializer):
    """Serializer for the agent-operation link, including their role."""
    agent = AgentSerializer(read_only=True)

    class Meta:
        model = OperationAssignment
        fields = ['id', 'agent', 'role_in_op']

class OperationDetailSerializer(OperationSerializer):
    """Detailed serializer for a single operation profile."""
    personnel = OperationAssignmentSerializer(source='operationassignment_set', many=True, read_only=True)
    targets = FactionSerializer(many=True, read_only=True) # Faction targets
    individual_targets = IndexProfileSummarySerializer(many=True, read_only=True) # Profile targets
    logs = OperationLogSerializer(many=True, read_only=True)

    class Meta(OperationSerializer.Meta):
        fields = OperationSerializer.Meta.fields + [
            'personnel', 'targets', 'individual_targets', 'logs',
            'after_action_report', 'success_probability'
        ]

class AssetSerializer(serializers.ModelSerializer):
    class Meta:
        model = Asset
        fields = ['id', 'name', 'type', 'status']

class AssetRequisitionSerializer(serializers.ModelSerializer):
    asset_name = serializers.CharField(source='asset.name', read_only=True)
    asset_type = serializers.CharField(source='asset.type', read_only=True)
    requested_by_username = serializers.CharField(source='requested_by.username', read_only=True)
    approved_by_username = serializers.CharField(source='approved_by.username', read_only=True)
    class Meta:
        model = AssetRequisition
        fields = [
            'id', 'operation', 'asset', 'asset_name', 'asset_type',
            'requested_by', 'requested_by_username', 'status',
            'approved_by', 'approved_by_username', 'decided_at', 'note', 'created_at'
        ]
        read_only_fields = ['requested_by', 'status', 'approved_by', 'decided_at', 'created_at']

class OperationReportLinkSerializer(serializers.ModelSerializer):
    """Serializer for the report-operation link."""
    report_id = serializers.ReadOnlyField(source='report.id')
    report_title = serializers.CharField(source='report.title', read_only=True)
    linked_by_username = serializers.CharField(source='linked_by.username', read_only=True)

    class Meta:
        model = OperationReportLink
        fields = ['id', 'operation', 'report_id', 'report_title', 'linked_by', 'linked_by_username', 'linked_at']
