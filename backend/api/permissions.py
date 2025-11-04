from rest_framework.permissions import BasePermission
from django.utils import timezone
from django.core.exceptions import ObjectDoesNotExist

def get_user_role(user):
    """Safely retrieve the user's role from their profile."""
    if not user.is_authenticated:
        return None
    try:
        base_role = user.profile.role
        # Check for Protector's Mantle
        if base_role == 'HEIR':
            # If a Mantle exists and is active, elevate role to PROTECTOR
            try:
                mantle = user.mantle  # OneToOne reverse accessor; raises DoesNotExist if none
                if mantle and mantle.is_currently_active():
                    return 'PROTECTOR'
            except ObjectDoesNotExist:
                pass  # No mantle record; proceed with base role
        # Backwards-compatibility: map legacy 'OVERLOOKER' to new 'OBSERVER'
        if base_role == 'OVERLOOKER':
            return 'OBSERVER'
        return base_role
    except AttributeError:
        # This can happen if the UserProfile was not created for some reason
        # or if the Mantle model doesn't exist yet (pre-migration)
        return None

class IsProtector(BasePermission):
    """Allows access only to users with the 'Protector' role."""
    def has_permission(self, request, view):
        return get_user_role(request.user) in ['PROTECTOR', 'HQ']

class IsTrueProtector(BasePermission):
    """Allows access only to users whose base profile role is 'Protector'.
    Does not consider temporary mantle elevation.
    """
    def has_permission(self, request, view):
        user = request.user
        if not getattr(user, 'is_authenticated', False):
            return False
        try:
            return getattr(user.profile, 'role', None) in ['PROTECTOR', 'HQ']
        except AttributeError:
            return False

class IsHeir(BasePermission):
    """Allows access only to users with the 'Heir' role."""
    def has_permission(self, request, view):
        return get_user_role(request.user) in ['HEIR', 'HQ']

class IsObserver(BasePermission):
    """Allows access only to users with the 'Observer' role."""
    def has_permission(self, request, view):
        return get_user_role(request.user) in ['OBSERVER', 'HQ']

# Backwards-compatible alias (deprecated)
class IsOverlooker(IsObserver):
    pass

class IsProtectorOrHeir(BasePermission):
    """Allows access to users with the 'Protector' or 'Heir' role."""
    def has_permission(self, request, view):
        role = get_user_role(request.user)
        return role in ['PROTECTOR', 'HEIR', 'HQ']

class IsHQ(BasePermission):
    """Allows access only to users with the 'HQ' role."""
    def has_permission(self, request, view):
        return get_user_role(request.user) == 'HQ'

class IsHQProtectorOrHeir(BasePermission):
    """HQ, Protector, or Heir may perform the action (e.g., destructive ops)."""
    def has_permission(self, request, view):
        return get_user_role(request.user) in ['HQ', 'PROTECTOR', 'HEIR']
