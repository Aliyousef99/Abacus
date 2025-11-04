#!/bin/bash

# 1. Install dependencies
python3 -m pip install -r backend/requirements.txt

# 2. Run database migrations
python3 backend/manage.py migrate --noinput

# 3. Run collectstatic
python3 backend/manage.py collectstatic --noinput