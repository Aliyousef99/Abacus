from django.db import models
from django.core.validators import MinValueValidator, MaxValueValidator
from django.contrib.auth.models import User

from lineage.models import Agent
from scales.models import Faction
from codex.models import CodexEntry, Echo

class Operation(models.Model):
    STATUS_CHOICES = [
        ('PLANNING', 'Planning'),
        ('ACTIVE', 'Active'),
        ('CONCLUDED - SUCCESS', 'Concluded - Success'),
        ('CONCLUDED - FAILURE', 'Concluded - Failure'),
        ('COMPROMISED', 'Compromised'),
    ]

    RISK_CHOICES = [
        ('LOW', 'Low'),
        ('MEDIUM', 'Medium'),
        ('HIGH', 'High'),
        ('CRITICAL', 'Critical'),
    ]

    codename = models.CharField(max_length=100, unique=True)
    objective = models.TextField()
    status = models.CharField(max_length=50, choices=STATUS_CHOICES, default='PLANNING')
    
    personnel = models.ManyToManyField(Agent, through='OperationAssignment', related_name='operations', blank=True)
    targets = models.ManyToManyField(Faction, related_name='targeted_operations', blank=True)
    individual_targets = models.ManyToManyField('index.IndexProfile', related_name='targeted_in_operations', blank=True)

    # Dynamic Analysis Fields
    success_probability = models.IntegerField(
        default=50, validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    collateral_risk = models.CharField(max_length=10, choices=RISK_CHOICES, default='MEDIUM')

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    started_at = models.DateTimeField(blank=True, null=True)
    ended_at = models.DateTimeField(blank=True, null=True)
    after_action_report = models.TextField(blank=True)

    def __str__(self):
        return self.codename

class OperationAssignment(models.Model):
    """Through model for assigning Agents to Operations with a specific role."""
    operation = models.ForeignKey(Operation, on_delete=models.CASCADE)
    agent = models.ForeignKey(Agent, on_delete=models.CASCADE)
    role_in_op = models.CharField(max_length=100, blank=True, default='Field Agent')

    class Meta:
        unique_together = ('operation', 'agent')

class OperationLog(models.Model):
    operation = models.ForeignKey(Operation, on_delete=models.CASCADE, related_name='logs')
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    message = models.TextField()
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"Log for {self.operation.codename} at {self.timestamp}"

class Asset(models.Model):
    ASSET_TYPES = [
        ('VEHICLE', 'Vehicle'),
        ('PROPERTY', 'Property'),
        ('FINANCIAL', 'Financial Instrument'),
        ('EQUIPMENT', 'Equipment'),
        ('INTEL', 'Intel Packet'),
    ]
    ASSET_STATUS = [
        ('AVAILABLE', 'Available'),
        ('ALLOCATED', 'Allocated'),
        ('MAINTENANCE', 'Maintenance'),
        ('COMPROMISED', 'Compromised'),
        ('DESTROYED', 'Destroyed'),
    ]
    name = models.CharField(max_length=100)
    type = models.CharField(max_length=50, choices=ASSET_TYPES)
    status = models.CharField(max_length=50, choices=ASSET_STATUS, default='AVAILABLE')
    description = models.TextField(blank=True)

    def __str__(self):
        return f"{self.name} ({self.type})"

class AssetRequisition(models.Model):
    REQ_STATUS = [
        ('PENDING', 'Pending'),
        ('APPROVED', 'Approved'),
        ('DENIED', 'Denied'),
    ]
    operation = models.ForeignKey(Operation, on_delete=models.CASCADE, related_name='requisitions')
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name='requisitions')
    requested_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, related_name='asset_requests')
    status = models.CharField(max_length=50, choices=REQ_STATUS, default='PENDING')
    approved_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='approved_requisitions')
    decided_at = models.DateTimeField(null=True, blank=True)
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.asset} for {self.operation} [{self.status}]"

class OperationReportLink(models.Model):
    """Links a Silo report (Echo) to an operation."""
    operation = models.ForeignKey(Operation, on_delete=models.CASCADE, related_name='report_links')
    report = models.ForeignKey(Echo, on_delete=models.CASCADE, related_name='operation_links')
    linked_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    linked_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('operation', 'report')

    def __str__(self):
        return f"'{self.report.title}' linked to '{self.operation.codename}'"
