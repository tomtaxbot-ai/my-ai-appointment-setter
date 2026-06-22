"""
OWNER IDENTITY — genericized for the template.

Every place that used to hardcode the original client ("teu" / "Maher" / "TEU")
now reads from the environment so each buyer can drop in their own identity
without touching code.
"""

import os

# The client slug used to look the owner's row up in Supabase (clients.slug).
OWNER_SLUG = os.getenv("OWNER_CLIENT_SLUG", "owner")

# The owner's name, used in the AI persona/prompt text the bot speaks with.
OWNER_NAME = os.getenv("OWNER_NAME", "the owner")

# The owner's business name, used in the AI persona/prompt text.
BUSINESS_NAME = os.getenv("BUSINESS_NAME", "the business")
