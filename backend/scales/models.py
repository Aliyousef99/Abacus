from django.db import models
from django.utils import timezone
from index.models import IndexProfile

class SoftDeleteManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)

class Agent(models.Model):
    """ Represents an external agent or contact within The Scales. """
    name = models.CharField(max_length=255, blank=True, help_text="The agent's real name, if known.")
    alias = models.CharField(max_length=100, unique=True, blank=True)
    rank = models.CharField(max_length=100, blank=True)
    strengths = models.TextField(blank=True)
    weaknesses = models.TextField(blank=True)
    known_locations = models.TextField(blank=True)
    known_vehicles = models.TextField(blank=True)
    picture_url = models.URLField(max_length=500, blank=True, null=True)
    surveillance_images = models.TextField(blank=True, help_text="Comma-separated URLs of surveillance images.")
    threat_level = models.PositiveIntegerField(default=50, blank=True, null=True, help_text="A score from 0-100 indicating threat level.")
    deleted_at = models.DateTimeField(null=True, blank=True, default=None)

    objects = SoftDeleteManager()
    all_objects = models.Manager()

    def __str__(self):
        return self.alias

class Faction(models.Model):
    name = models.CharField(max_length=150, unique=True)
    class ThreatLevel(models.TextChoices):
        DORMANT = 'DORMANT', 'Dormant'
        NOMINAL = 'NOMINAL', 'Nominal'
        ELEVATED = 'ELEVATED', 'Elevated'
        SEVERE = 'SEVERE', 'Severe'
        CRITICAL = 'CRITICAL', 'Critical'

    threat_level = models.CharField(max_length=20, choices=ThreatLevel.choices, default=ThreatLevel.DORMANT)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    picture_url = models.URLField(max_length=500, blank=True, null=True)
    supa_uuid = models.UUIDField(blank=True, null=True, help_text="Supabase factions UUID (for Index linkage)")

    strengths = models.TextField(blank=True)
    weaknesses = models.TextField(blank=True)
    allies = models.TextField(blank=True, default='')
    rivals = models.TextField(blank=True, default='')
    surveillance_urls = models.TextField(blank=True, help_text="Comma-separated list of surveillance file URLs.")
    members = models.ManyToManyField(IndexProfile, through='FactionMembership', related_name='faction_affiliations', blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True, default=None)

    objects = SoftDeleteManager()
    all_objects = models.Manager()

    def __str__(self):
        return self.name
    
    @property
    def member_count(self):
        try:
            return self.memberships.count()
        except AttributeError:
            return 0



from django.contrib.auth.models import User

class FactionHistory(models.Model):
    """Historical snapshots for a faction's key indicators."""
    faction = models.ForeignKey(Faction, related_name='history', on_delete=models.CASCADE)
    timestamp = models.DateTimeField(auto_now_add=True)
    threat_level = models.CharField(max_length=20, null=True, blank=True)
    member_count = models.IntegerField(null=True, blank=True)
    updated_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"{self.faction.name} @ {self.timestamp:%Y-%m-%d %H:%M}"

from lineage.models import Agent as LineageAgent

class Connection(models.Model):
    class Relationship(models.TextChoices):
        INFORMANT = 'INFORMANT', 'Informant'
        LEVERAGE = 'LEVERAGE', 'Leverage (Blackmail)'
        FAMILY_TIE = 'FAMILY_TIE', 'Family Tie'
        PAST_AFFILIATION = 'PAST_AFFILIATION', 'Past Affiliation'
        RIVAL = 'RIVAL', 'Rival'
        HANDLER = 'HANDLER', 'Handler'

    scales_agent = models.ForeignKey(Agent, related_name='connections', on_delete=models.CASCADE)
    lineage_agent = models.ForeignKey(LineageAgent, related_name='external_connections', on_delete=models.CASCADE)
    relationship = models.CharField(max_length=32, choices=Relationship.choices)
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('scales_agent', 'lineage_agent')

    def __str__(self):
        return f"{self.scales_agent.alias} ↔ {self.lineage_agent.alias} ({self.get_relationship_display()})"

class FactionDiplomacy(models.Model):
    """Defines a diplomatic relationship (e.g., ally, rival) between two factions."""
    class Relation(models.TextChoices):
        ALLY = 'ALLY', 'Ally'
        RIVAL = 'RIVAL', 'Rival'
        NEUTRAL = 'NEUTRAL', 'Neutral'

    source = models.ForeignKey(Faction, related_name='diplomacy_outgoing', on_delete=models.CASCADE)
    target = models.ForeignKey(Faction, related_name='diplomacy_incoming', on_delete=models.CASCADE, null=True, blank=True)
    target_name = models.CharField(max_length=150, blank=True, help_text="Name of the target if it's not in the system.")
    relation = models.CharField(max_length=32, choices=Relation.choices, default=Relation.NEUTRAL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('source', 'target', 'relation')
        ordering = ['-created_at']

    def __str__(self):
        target_display = self.target.name if self.target else self.target_name
        return f"{self.source.name} -> {target_display} ({self.get_relation_display()})"

class FactionMembership(models.Model):
    """Through model linking Faction to IndexProfile with an affiliation level."""
    class Affiliation(models.TextChoices):
        LEADER = 'Leader', 'Leader'
        HIGH_RANKING_MEMBER = 'High ranking member', 'High ranking member'
        MEMBER = 'Member', 'Member'
        ASSOCIATE = 'Associate', 'Associate'
        HANGAROUND = 'Hangaround', 'Hangaround'
        AFFILIATE = 'Affiliate', 'Affiliate'
        SUPPORTER = 'Supporter', 'Supporter'
        INFORMANT = 'Informant', 'Informant'
        UNKNOWN = 'Unknown', 'Unknown'

    faction = models.ForeignKey(Faction, on_delete=models.CASCADE, related_name='memberships')
    profile = models.ForeignKey(IndexProfile, on_delete=models.CASCADE, related_name='faction_memberships')
    affiliation = models.CharField(max_length=32, choices=Affiliation.choices, default=Affiliation.ASSOCIATE)
    added_at = models.DateTimeField(db_column='added_at', default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True, db_column='updated_at')

    class Meta:
        unique_together = ('faction', 'profile')
        ordering = ['-added_at']