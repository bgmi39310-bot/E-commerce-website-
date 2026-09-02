"""
Small script that Render's Cron Job services run on a schedule. It just
calls this backend's own protected /api/cron/* endpoints over HTTP with the
shared secret — kept separate from app.py so Render can spin up a cheap,
short-lived job for it instead of needing the whole web service to run a
background scheduler itself.

Usage:  python cron_runner.py cleanup
        python cron_runner.py reminders

Required env vars: BACKEND_BASE_URL, CRON_SECRET
"""

import os
import sys
import requests

TASKS = {
    "cleanup": "/api/cron/cleanup-anonymous-users",
    "reminders": "/api/cron/return-window-reminders",
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in TASKS:
        print(f"Usage: python cron_runner.py <{'|'.join(TASKS)}>")
        sys.exit(1)

    base_url = os.environ.get("BACKEND_BASE_URL")
    secret = os.environ.get("CRON_SECRET")
    if not base_url or not secret:
        print("Missing BACKEND_BASE_URL or CRON_SECRET environment variable.")
        sys.exit(1)

    url = base_url.rstrip("/") + TASKS[sys.argv[1]]
    response = requests.post(url, headers={"X-Cron-Secret": secret}, timeout=120)

    print(f"POST {url} -> {response.status_code}")
    print(response.text)

    if not response.ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
