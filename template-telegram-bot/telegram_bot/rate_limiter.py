"""
TELEGRAM BOT — Rate Limiter

Prevents cost explosions from excessive API usage.
Tracks command usage per user with sliding windows.
"""

from datetime import datetime, timezone, timedelta
from collections import defaultdict, deque
from typing import Dict, Tuple


class RateLimiter:
    """In-memory rate limiter with sliding windows."""

    def __init__(self):
        # {user_id: {command: deque of timestamps}}
        self.usage: Dict[int, Dict[str, deque]] = defaultdict(lambda: defaultdict(deque))

    def check_and_record(self, user_id: int, command: str, limit: int, window_hours: int) -> Tuple[bool, str]:
        """
        Check if command is allowed and record usage.

        Args:
            user_id: Telegram user ID
            command: Command name (e.g., 'ideas', 'make')
            limit: Max number of calls allowed in window
            window_hours: Time window in hours

        Returns:
            (allowed: bool, message: str)
            If not allowed, message explains why and when they can try again.
        """
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=window_hours)

        # Get usage history for this user + command
        history = self.usage[user_id][command]

        # Remove expired entries
        while history and datetime.fromisoformat(history[0]) < cutoff:
            history.popleft()

        # Check if limit exceeded
        if len(history) >= limit:
            oldest = datetime.fromisoformat(history[0])
            reset_at = oldest + timedelta(hours=window_hours)
            minutes_until_reset = int((reset_at - now).total_seconds() / 60)

            if minutes_until_reset < 60:
                time_str = f"{minutes_until_reset} minutes"
            else:
                hours = minutes_until_reset // 60
                time_str = f"{hours} hours"

            return False, (
                f"Rate limit exceeded: /{command} is limited to {limit} uses per {window_hours}h. "
                f"Try again in {time_str}."
            )

        # Record this usage
        history.append(now.isoformat())

        return True, ""

    def get_usage(self, user_id: int, command: str, window_hours: int) -> int:
        """Get current usage count for a user/command in the time window."""
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=window_hours)

        history = self.usage[user_id][command]

        # Remove expired entries
        while history and datetime.fromisoformat(history[0]) < cutoff:
            history.popleft()

        return len(history)


# Global rate limiter instance
rate_limiter = RateLimiter()

# Rate limit configs (command: (limit, window_hours))
RATE_LIMITS = {
    'ideas': (5, 1),   # 5 per hour
    'make': (10, 24),  # 10 per day
}
