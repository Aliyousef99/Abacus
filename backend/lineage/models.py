from django.db import models
from index.models import IndexProfile

class SoftDeleteManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)

class Agent(models.Model):
    """
    Represents an agent in the Lineage system.
    """
    # Core Identifiers
    index_profile = models.OneToOneField(IndexProfile, on_delete=models.SET_NULL, null=True, blank=True, related_name='lineage_agent')

    # Classified Identifiers
    alias = models.CharField(max_length=100, unique=True, blank=True, null=True, help_text="The agent's operational codename.")
    real_name = models.CharField(max_length=255, blank=True, help_text="The agent's classified real name.")

    # Operational Details
    STATUS_CHOICES = [
        ('ACTIVE', 'Active'),
        ('IN_DEEP_COVER', 'In-Deep-Cover'),
        ('COMPROMISED', 'Compromised'),
        ('INACTIVE', 'Inactive'),
        ('MIA', 'Missing in Action'),
        ('RETIRED', 'Retired'),
    ]
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='ACTIVE')
    key_skill = models.CharField(max_length=255, blank=True, help_text="Primary skills or specialties.")
    loyalty_type = models.CharField(max_length=100, blank=True, help_text="Assessed loyalty classification.")

    # Extended Profile (can be expanded later)
    summary = models.TextField(blank=True, help_text="A brief summary of the agent's history and capabilities.")
    picture_url = models.URLField(max_length=500, blank=True, help_text="URL to the agent's profile picture.")
    personality = models.TextField(blank=True, help_text="Psychological evaluation notes.")
    locations = models.TextField(blank=True, help_text="Known or last seen locations.")
    vehicles = models.TextField(blank=True, help_text="Known associated vehicles.")
    surveillance_images = models.TextField(blank=True, help_text="Comma-separated URLs of surveillance images.")

    # Secure Comms
    secure_comms_channel = models.CharField(max_length=100, blank=True)
    secure_comms_contact_id = models.CharField(max_length=100, blank=True)
    duress_code = models.CharField(max_length=255, blank=True)
    last_contacted_at = models.DateTimeField(null=True, blank=True)

    # Development Plan (Leadership only)
    dev_plan_focus = models.CharField(max_length=255, blank=True)
    dev_plan_next = models.CharField(max_length=255, blank=True)
    dev_plan_notes = models.TextField(blank=True)

    # Custom ordering index (HQ can rearrange list ordering)
    order_index = models.IntegerField(null=True, blank=True, help_text="Manual ordering; lower appears first.")

    # Soft delete field
    deleted_at = models.DateTimeField(null=True, blank=True, default=None)

    # Model Managers
    objects = SoftDeleteManager()  # Default manager filters out soft-deleted items
    all_objects = models.Manager() # Manager to access all items, including soft-deleted

    def __str__(self):
        return self.alias
