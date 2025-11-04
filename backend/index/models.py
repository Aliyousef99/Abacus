from django.db import models
from django.utils import timezone

class SoftDeleteManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)

class IndexProfile(models.Model):
    """
    Represents a single, comprehensive profile in The Index.
    """
    full_name = models.CharField(max_length=255)
    aliases = models.TextField(blank=True, help_text="Comma-separated list of aliases.")
    picture_url = models.URLField(max_length=500, blank=True, null=True)

    # Core Attributes
    classification = models.CharField(max_length=100, blank=True, default='')
    status = models.CharField(max_length=100, blank=True, default='')
    threat_level = models.CharField(max_length=50, blank=True, default='')

    # Detailed Information
    biography = models.TextField(blank=True)
    strengths = models.TextField(blank=True, help_text="Comma-separated list.")
    weaknesses = models.TextField(blank=True, help_text="Comma-separated list.")
    known_locations = models.TextField(blank=True, help_text="Comma-separated list.")
    known_vehicles = models.TextField(blank=True, help_text="Comma-separated list.")
    surveillance_urls = models.TextField(blank=True, help_text="Comma-separated list of URLs.")

    # Timestamps & Soft Delete
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True, default=None)

    objects = SoftDeleteManager()
    all_objects = models.Manager()

    def __str__(self):
        return self.full_name

class IndexConnection(models.Model):
    """
    Represents a directional relationship between two IndexProfiles.
    """
    from_profile = models.ForeignKey(IndexProfile, on_delete=models.CASCADE, related_name='connections_from')
    to_profile = models.ForeignKey(IndexProfile, on_delete=models.CASCADE, related_name='connections_to')
    relationship = models.CharField(max_length=100, blank=True, help_text="e.g., Family, Rival, Known Associate")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('from_profile', 'to_profile')
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.from_profile.full_name} -> {self.to_profile.full_name} ({self.relationship})"

class IndexAffiliation(models.Model):
    """
    Through model for linking IndexProfile to a scales.Faction.
    This is a placeholder to resolve dependencies.
    """
    profile = models.ForeignKey(IndexProfile, on_delete=models.CASCADE)
    faction = models.ForeignKey('scales.Faction', on_delete=models.CASCADE)
    level = models.CharField(max_length=100, blank=True, null=True)