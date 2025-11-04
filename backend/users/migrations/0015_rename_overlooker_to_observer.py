from django.db import migrations


def forwards(apps, schema_editor):
    UserProfile = apps.get_model('users', 'UserProfile')
    # Rename any legacy OVERLOOKER role values to OBSERVER
    UserProfile.objects.filter(role='OVERLOOKER').update(role='OBSERVER')


def backwards(apps, schema_editor):
    # No-op backwards; retain OBSERVER
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0014_alter_userprofile_role'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]

